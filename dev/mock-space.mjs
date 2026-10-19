// A stand-in for both Hugging Face Spaces, for working on the site without either.
//
//   npm run dev:mock
//
// Starts this server and `astro dev` pointed at it, so both studios run end to end
// -- queue, stages, plots, audio, timings -- with no Docker, no ~490 MB of weights,
// and without waking the real Spaces or queueing behind real visitors.
//
// It speaks the real protocol (POST /api/v2/jobs, SSE on /api/v2/jobs/{id}/events,
// GET /api/v2/jobs/{id} as the polling fallback, GET /health) with payloads shaped
// like the real ones. The contents are invented: a tone, not speech.
//
// To see the queue UI, hold the next job in line and release it by hand:
//
//   curl 'localhost:7999/control/hold?on=1'   # next job reports "queued"
//   curl  localhost:7999/control/go           # ...until this
//
// Env: MOCK_PORT (7999), MOCK_STAGE_MS (500) per pipeline stage, MOCK_ONLY=1 to run
// the mock alone, e.g. against `astro preview`.
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.MOCK_PORT ?? 7999);
const STAGE_MS = Number(process.env.MOCK_STAGE_MS ?? 500);

let hold = false;
let release = null;
const jobs = new Map();

/* --- synthetic payloads ------------------------------------------------- */

function wav(seconds, rate) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const envelope = Math.abs(Math.sin(t * 3.1)) * Math.min(1, t * 4, (seconds - t) * 4);
    const v = envelope * (0.6 * Math.sin(2 * Math.PI * 180 * t) + 0.25 * Math.sin(2 * Math.PI * 420 * t));
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32000), 44 + i * 2);
  }
  return buf.toString('base64');
}

/** uint8 matrix, base64, with its shape and value range -- the wire format viz.ts reads. */
function matrix(rows, cols, fn, range = [-4, 4]) {
  const a = Buffer.alloc(rows * cols);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      a[r * cols + c] = Math.max(0, Math.min(255, Math.round(fn(r, c))));
    }
  }
  return { shape: [rows, cols], range, data: a.toString('base64') };
}

const mel = (frames) =>
  matrix(80, frames, (r, c) => 120 + 90 * Math.sin(c / 9) * Math.exp(-r / 40) + 30 * Math.sin((r * c) / 50));

/** A clean diagonal: what a model that tracked the text looks like. */
const alignment = (rows, cols, rowsAreDecoder) =>
  matrix(rows, cols, (r, c) => {
    const [dec, enc, d, e] = rowsAreDecoder ? [rows, cols, r, c] : [cols, rows, c, r];
    return 255 * Math.exp(-((e - (d * enc) / dec) ** 2) / 3);
  }, [0, 1]);

/** Unit-norm, like GE2E's output, so the page's cosine working reads as it does live. */
function embedding(seed) {
  const v = Array.from({ length: 256 }, (_, i) => Math.max(0, Math.sin(i * 1.7 + seed) + Math.cos(i * 0.3)));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

function payload(kind) {
  if (kind === 'tts') {
    return {
      audio: wav(2.4, 22050), sample_rate: 22050, duration: 2.4,
      mel: mel(210),
      // The TTS Space sends alignment already transposed to (encoder, decoder).
      alignment: alignment(40, 210, false),
      decoder_steps: 210, max_decoder_steps: 1000, reached_max_steps: false,
      timings: { encoding: 0.01, synthesizer: 3.2, vocoder: 1.1, packaging: 0.04, total: 4.35 },
    };
  }
  return {
    audio: wav(3.1, 16000), sample_rate: 16000, duration: 3.1,
    mel: mel(250),
    // The cloning Space sends (decoder, encoder); the studio transposes it.
    alignment: alignment(250, 45, true),
    reference_mel: mel(300),
    embedding: embedding(0), cloned_embedding: embedding(0.15),
    timings: { decode: 0.08, encoder: 0.04, synthesizer: 2.6, vocoder: 13.9, packaging: 0.05, total: 16.67 },
  };
}

const STAGES = {
  tts: ['encoding', 'synthesizing', 'vocoding', 'packaging'],
  cloning: ['decoding', 'encoding', 'synthesizing', 'vocoding', 'packaging'],
};

/* --- server ------------------------------------------------------------- */

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, body) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (url.pathname === '/control/hold') {
    hold = url.searchParams.get('on') === '1';
    return json(res, 200, { hold });
  }
  if (url.pathname === '/control/go') {
    release?.();
    release = null;
    return json(res, 200, { released: true });
  }

  if (url.pathname === '/health') {
    return json(res, 200, { status: 'ok', models_loaded: true, queue_depth: 0, running: 0 });
  }

  if (url.pathname === '/api/v2/jobs' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || '{}');
    if (!parsed.input_text?.trim()) return json(res, 422, { detail: 'input_text is empty.' });
    const id = `mock-${jobs.size + 1}`;
    jobs.set(id, parsed.cloning_audio ? 'cloning' : 'tts');
    return json(res, 202, { id, events: `/api/v2/jobs/${id}/events` });
  }

  const poll = url.pathname.match(/^\/api\/v2\/jobs\/([\w-]+)$/);
  if (poll && jobs.has(poll[1])) {
    return json(res, 200, { id: poll[1], status: 'done', result: payload(jobs.get(poll[1])) });
  }

  const events = url.pathname.match(/^\/api\/v2\/jobs\/([\w-]+)\/events$/);
  if (events && jobs.has(events[1])) {
    const id = events[1];
    const kind = jobs.get(id);
    res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    if (hold) {
      send('status', { id, status: 'queued', stage: null, progress: 0, queue_position: 1 });
      await new Promise((r) => { release = r; });
    }
    const stages = STAGES[kind];
    for (const [i, stage] of stages.entries()) {
      send('status', { id, status: 'running', stage, progress: (i + 1) / (stages.length + 1) });
      await sleep(STAGE_MS);
    }
    send('done', payload(kind));
    return res.end();
  }

  json(res, 404, { detail: 'Not Found' });
});

server.listen(PORT, () => {
  console.log(`mock Space on http://localhost:${PORT} (both studios)`);
  if (process.env.MOCK_ONLY === '1') return;

  const local = `http://localhost:${PORT}`;
  const astro = spawn('astro', ['dev'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, PUBLIC_SPACE_URL: local, PUBLIC_TTS_URL: local },
  });
  astro.on('exit', (code) => {
    server.close();
    process.exit(code ?? 0);
  });
  // Ctrl-C reaches both processes anyway, but a bare `kill` of this one would
  // otherwise leave astro dev orphaned and holding its port.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => astro.kill(signal));
});
