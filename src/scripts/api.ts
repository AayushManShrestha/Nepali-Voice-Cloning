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

async function createJob(text: string, audioBase64: string): Promise<string> {
  const response = await fetch(`${SPACE}/api/v2/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_text: text, cloning_audio: audioBase64 }),
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
): Promise<SynthesisResult> {
  const id = await createJob(text, audioBase64);

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

/** Measured on the live Space: ~17s fixed + ~2.3s per second of generated audio. */
export function estimateSeconds(characterCount: number): number {
  const estimatedAudioSeconds = Math.max(0.7, characterCount * 0.065);
  return Math.round(6 + estimatedAudioSeconds * 2.3);
}
