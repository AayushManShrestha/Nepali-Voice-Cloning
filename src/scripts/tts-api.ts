/**
 * Client for the Nepali TTS Space (Tacotron2 + HiFi-GAN, one fixed voice).
 *
 * THIS FILE IS THE ONLY PLACE THAT KNOWS THE BACKEND'S WIRE FORMAT. `TtsResult` is
 * expressed in terms of what the page needs, so the page did not change when the
 * Space moved from v1 to v2.
 *
 * Contract:
 *
 *   POST /api/v2/jobs           {input_text} -> 202 {id, events}
 *   GET  /api/v2/jobs/{id}/events               -> SSE status/done/error
 *   GET  /api/v2/jobs/{id}                      -> poll fallback
 *
 * v2 returns mel and alignment as base64 uint8 with their shape and value range, and
 * the browser draws them -- the same trade the voice-cloning Space makes. The old v1
 * `/synthesize` returned two server-rendered PNGs that were ~29% of a 705 KB response
 * and could not follow the page theme.
 */
import type { Matrix } from './viz';

// Point at a local backend with `PUBLIC_TTS_URL=http://localhost:7860 npm run dev`.
export const TTS_SPACE =
  import.meta.env.PUBLIC_TTS_URL ?? 'https://lord-reso-tts-only.hf.space';

/** Mirrors the server's MAX_TEXT_CHARS. */
export const MAX_TEXT_CHARS = 300;

/** Stage names emitted by the backend, in pipeline order. */
export const STAGES = ['encoding', 'synthesizing', 'vocoding', 'packaging'] as const;
export type Stage = (typeof STAGES)[number];

export interface TtsJobStatus {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  stage: Stage | null;
  progress: number;
  queue_position?: number;
  elapsed?: number;
  error?: string;
}

/** Raw v2 payload. Only this module should touch this shape. */
interface TtsPayload {
  audio: string;
  sample_rate: number;
  duration: number;
  mel: Matrix;
  alignment: Matrix;
  decoder_steps: number;
  max_decoder_steps: number;
  reached_max_steps: boolean;
  timings: Record<string, number>;
}

export interface TtsResult {
  /** Object URL for the synthesised wav. Caller revokes it. */
  audioUrl: string;
  duration: number;
  sampleRate: number;
  mel: Matrix;
  alignment: Matrix;
  /**
   * True when the decoder hit its step ceiling without the stop gate firing, which
   * means the tail of the audio is artefact rather than speech. Worth surfacing:
   * otherwise one word comes back as eleven seconds and the listener blames the page.
   */
  reachedMaxSteps: boolean;
  decoderSteps: number;
  maxDecoderSteps: number;
  timings: Record<string, number>;
  /** Wall-clock seconds for the whole job, measured client-side. */
  elapsed: number;
}

export interface TtsHealth {
  status: string;
  models_loaded: boolean;
  queue_depth: number;
  running: number;
}

export async function checkHealth(timeoutMs = 8000): Promise<TtsHealth | null> {
  try {
    const response = await fetch(`${TTS_SPACE}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return (await response.json()) as TtsHealth;
    return null;
  } catch {
    // A sleeping Space fails here; the request itself starts waking it.
    return null;
  }
}

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

function toResult(payload: TtsPayload, startedAt: number): TtsResult {
  return {
    audioUrl: URL.createObjectURL(base64ToBlob(payload.audio, 'audio/wav')),
    duration: payload.duration,
    sampleRate: payload.sample_rate,
    mel: payload.mel,
    alignment: payload.alignment,
    reachedMaxSteps: Boolean(payload.reached_max_steps),
    decoderSteps: payload.decoder_steps,
    maxDecoderSteps: payload.max_decoder_steps,
    timings: payload.timings ?? {},
    elapsed: (Date.now() - startedAt) / 1000,
  };
}

async function createJob(text: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${TTS_SPACE}/api/v2/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_text: text }),
    });
  } catch {
    throw new Error(
      'Could not reach the TTS server. It may be waking from sleep — try again in a minute.',
    );
  }

  if (!response.ok) {
    // A 404 here means the route itself is missing, not that anything went wrong with
    // the request -- i.e. the Space is still on the pre-v2 build, whose only endpoint
    // is /synthesize. FastAPI's own detail for that is the bare string "Not Found",
    // which told the last person to hit it precisely nothing.
    if (response.status === 404) {
      throw new Error(
        'The TTS server is running an older build without the v2 job API. ' +
          'It needs redeploying before this page can reach it.',
      );
    }
    let detail = `The TTS server returned ${response.status}.`;
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
  onStatus: (status: TtsJobStatus) => void,
  signal?: AbortSignal,
): Promise<TtsResult> {
  const startedAt = Date.now();
  const id = await createJob(text);

  return new Promise<TtsResult>((resolve, reject) => {
    let settled = false;
    const source = new EventSource(`${TTS_SPACE}/api/v2/jobs/${id}/events`);

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
        onStatus(JSON.parse((event as MessageEvent).data) as TtsJobStatus);
      } catch {
        /* ignore a malformed frame rather than killing the stream */
      }
    });

    source.addEventListener('done', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as TtsPayload;
        finish(() => resolve(toResult(payload, startedAt)));
      } catch {
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
        finish(() => pollToCompletion(id, startedAt).then(resolve, reject));
      }
    });
  });
}

async function pollToCompletion(id: string, startedAt: number): Promise<TtsResult> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${TTS_SPACE}/api/v2/jobs/${id}`);
    if (!response.ok) throw new Error(`Lost track of job ${id}.`);
    const body = await response.json();
    if (body.status === 'done') return toResult(body.result as TtsPayload, startedAt);
    if (body.status === 'error') throw new Error(body.error ?? 'Synthesis failed.');
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error('Timed out waiting for synthesis.');
}

/**
 * Expected synthesis time.
 *
 * The pre-optimisation Space measured 15.7s for a 6-character input, of which an
 * unknown but large share was loading 376 MB of checkpoint per request — that now
 * happens once at startup. Until the new Space is measured this stays deliberately
 * pessimistic: under-promising costs nothing, and blowing past a confident estimate
 * reads as a hang.
 *
 * Tacotron2 also runs to its step ceiling whenever the stop gate misfires, so cost is
 * closer to flat in input length than it is on the cloning Space.
 */
export function estimateSeconds(characterCount: number): number {
  return Math.round(Math.max(15, 10 + 0.06 * Math.max(1, characterCount)));
}

export function estimateWithQueue(characterCount: number, jobsAhead: number): number {
  return estimateSeconds(characterCount) * (Math.max(0, jobsAhead) + 1);
}
