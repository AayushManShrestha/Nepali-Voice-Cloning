/**
 * Client for the Hugging Face Space that runs the model.
 *
 * The browser talks to the Space directly rather than proxying through Vercel: the
 * Space already sends `CORS: *`, and a Vercel Hobby function caps at 60s while
 * synthesis can exceed that. The only serverless function in this project is the
 * daily keep-alive cron.
 */

// Point at a local backend with `PUBLIC_SPACE_URL=http://localhost:7860 npm run dev`.
export const SPACE =
  import.meta.env.PUBLIC_SPACE_URL ?? 'https://lord-reso-nepali-voice-cloning.hf.space';

/** Stage names emitted by the backend, in pipeline order. */
export const STAGES = ['decoding', 'encoding', 'synthesizing', 'vocoding', 'packaging'] as const;
export type Stage = (typeof STAGES)[number];

export interface JobStatus {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  stage: Stage | null;
  progress: number;
  queue_position?: number;
  elapsed?: number;
  error?: string;
}

export interface SynthesisResult {
  audio: string;
  sample_rate: number;
  duration: number;
  mel: { shape: [number, number]; range: [number, number]; data: string };
  alignment: { shape: [number, number]; range: [number, number]; data: string };
  reference_mel?: { shape: [number, number]; range: [number, number]; data: string };
  embedding: number[];
  cloned_embedding?: number[];
  timings: Record<string, number>;
}

export interface Health {
  status: string;
  models_loaded: boolean;
  queue_depth: number;
  running: number;
}

export async function checkHealth(timeoutMs = 8000): Promise<Health | null> {
  try {
    const response = await fetch(`${SPACE}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return (await response.json()) as Health;

    // The previous backend has no /health. Fall back to `/` so the indicator stays
    // truthful against either version during the rollout.
    if (response.status === 404) {
      const legacy = await fetch(`${SPACE}/`, { signal: AbortSignal.timeout(timeoutMs) });
      if (legacy.ok) {
        return { status: 'ok', models_loaded: true, queue_depth: 0, running: 0 };
      }
    }
    return null;
  } catch {
    // A sleeping Space will fail here; the request itself starts waking it.
    return null;
  }
}

async function createJob(
  text: string,
  audioBase64: string,
  wantClonedEmbedding: boolean,
): Promise<string> {
  const response = await fetch(`${SPACE}/api/v2/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input_text: text,
      cloning_audio: audioBase64,
      // A second encoder pass over the generated audio. Measured at ~0.04s, which is
      // nothing next to the vocoder, and it is what lets the UI show the original and
      // cloned embeddings side by side.
      want_cloned_embedding: wantClonedEmbedding,
    }),
  });

  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  const body = await response.json();
  return body.id as string;
}

/**
 * Create a job and follow it to completion over server-sent events.
 *
 * Falls back to polling if EventSource cannot connect -- some corporate proxies
 * buffer or drop text/event-stream.
 */
export async function synthesize(
  text: string,
  audioBase64: string,
  onStatus: (status: JobStatus) => void,
  signal?: AbortSignal,
  wantClonedEmbedding = false,
): Promise<SynthesisResult> {
  const id = await createJob(text, audioBase64, wantClonedEmbedding);

  return new Promise<SynthesisResult>((resolve, reject) => {
    let settled = false;
    const source = new EventSource(`${SPACE}/api/v2/jobs/${id}/events`);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      source.close();
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    function onAbort() {
      finish(() => reject(new DOMException('Aborted', 'AbortError')));
    }
    signal?.addEventListener('abort', onAbort);

    source.addEventListener('status', (event) => {
      try {
        onStatus(JSON.parse((event as MessageEvent).data) as JobStatus);
      } catch {
        /* ignore a malformed frame rather than killing the stream */
      }
    });

    source.addEventListener('done', (event) => {
      try {
        const result = JSON.parse((event as MessageEvent).data) as SynthesisResult;
        finish(() => resolve(result));
      } catch (error) {
        finish(() => reject(new Error('Could not parse the synthesis result.')));
      }
    });

    source.addEventListener('error', (event) => {
      const data = (event as MessageEvent).data;
      if (data) {
        let message = 'Synthesis failed.';
        try {
          message = JSON.parse(data).error ?? message;
        } catch {
          /* keep the default */
        }
        finish(() => reject(new Error(message)));
        return;
      }
      // No payload means a transport-level drop. Fall back to polling once.
      if (source.readyState === EventSource.CLOSED) {
        finish(() => pollToCompletion(id).then(resolve, reject));
      }
    });
  });
}

async function pollToCompletion(id: string): Promise<SynthesisResult> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${SPACE}/api/v2/jobs/${id}`);
    if (!response.ok) throw new Error(`Lost track of job ${id}.`);
    const body = await response.json();
    if (body.status === 'done') return body.result as SynthesisResult;
    if (body.status === 'error') throw new Error(body.error ?? 'Synthesis failed.');
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error('Timed out waiting for synthesis.');
}

/**
 * Expected synthesis time, fitted to measurements on the live Space (cpu-basic, 2 vCPU).
 *
 *   server_seconds = 11.9 + 2.94 * audio_seconds
 *   audio_seconds  = 0.0628 * characters
 *
 * Fit against three points (7/52/177 chars -> 13.4/22.6/45.2s) lands within ~1s each.
 * The dominant term is the autoregressive vocoder, which is why this scales with the
 * length of the *output* rather than being a flat constant.
 */
export function estimateSeconds(characterCount: number): number {
  const fitted = 11.9 + 0.1845 * Math.max(1, characterCount);
  // Quote at least 30s. The fit is a central estimate, but the Space runs on two
  // *shared* vCPUs, so a noisy neighbour can double it. Under-promising costs nothing;
  // blowing past a confident estimate reads as a hang.
  return Math.round(Math.max(MIN_ESTIMATE_SECONDS, fitted));
}

/** Floor for any quoted estimate. See estimateSeconds(). */
export const MIN_ESTIMATE_SECONDS = 30;

/**
 * Expected wait including the queue.
 *
 * Only one synthesis runs at a time, so being Nth in line means waiting for N jobs.
 * The text length of the jobs ahead is unknown, so each is costed at your own estimate
 * — measured production runs put three concurrent jobs at roughly 20s / 37s / 53s,
 * i.e. very close to linear in queue position.
 *
 * `jobsAhead` is 0 when you are next to run.
 */
export function estimateWithQueue(characterCount: number, jobsAhead: number): number {
  return estimateSeconds(characterCount) * (Math.max(0, jobsAhead) + 1);
}
