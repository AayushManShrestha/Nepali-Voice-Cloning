/**
 * The progress readout under the Synthesise button, shared by both studios.
 *
 * Both Spaces run one synthesis at a time and send the same SSE status frames, so
 * the queue arithmetic is the same on both pages. It used to exist twice, and the
 * /tts copy missed a fix the cloning copy already had: time spent queued fell out of
 * the budget once the job started running, so any job that had waited in line read
 * "longer than usual" almost immediately.
 *
 * Markup contract (components/SynthControls.astro):
 *
 *   [data-progress-fill]   width follows the server's progress fraction
 *   [data-progress-label]  queue position, then the current stage
 *   [data-progress-eta]    elapsed against expected
 */

import { serverState } from './server-status';

/**
 * Until the server accepts the job there is no queue position or stage to show,
 * and a sleeping Space can take minutes to accept it. When the header already
 * knows the server is waking, say so rather than implying a queue that isn't there.
 */
const WAKING_LABEL = 'Waking the model server — can take a few minutes';

export interface ProgressStatus {
  status: 'queued' | 'running' | 'done' | 'error';
  stage: string | null;
  progress: number;
  queue_position?: number;
}

export interface Progress {
  /**
   * Restart the clock for a new job. `estimate` gives the expected seconds when
   * `jobsAhead` jobs must finish first; 0 means this one runs next.
   */
  start(estimate: (jobsAhead: number) => number): void;
  /** Apply one status frame from the server. */
  update(status: ProgressStatus): void;
  stop(): void;
}

export function createProgress(
  root: ParentNode,
  /** Human labels for the backend's stage names. Unknown stages show raw. */
  stageLabels: Record<string, string>,
): Progress {
  const fill = root.querySelector<HTMLElement>('[data-progress-fill]');
  const label = root.querySelector<HTMLElement>('[data-progress-label]');
  const eta = root.querySelector<HTMLElement>('[data-progress-eta]');
  const pendingLabel = label?.textContent ?? '';

  let timer: number | null = null;
  let estimate: (jobsAhead: number) => number = () => 0;
  let startedAt = 0;
  let jobsAhead = 0;
  let queuedAt: number | null = null;
  let queuedForMs = 0;

  /**
   * Show elapsed time against the expected duration.
   *
   * Two things this deliberately does NOT do: promise a countdown (the estimate is a
   * fit, not a guarantee), and keep quoting a stale figure once it has been exceeded.
   * Being overtaken by your own estimate and saying nothing reads as a hang.
   */
  const render = () => {
    if (!eta) return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    // Recomputed every tick, so the figure tracks the queue draining ahead of you.
    // Time already spent queued stays in the budget once we start running -- elapsed
    // counts from submit, so dropping it would make every queued job look overdue.
    const budget = Math.round(queuedForMs / 1000) + estimate(jobsAhead);
    eta.textContent =
      elapsed > budget * 1.25
        ? `${elapsed}s elapsed · longer than usual`
        : `${elapsed}s elapsed · ~${budget}s expected`;
  };

  const stop = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };

  return {
    start(next) {
      stop();
      estimate = next;
      startedAt = Date.now();
      jobsAhead = 0;
      queuedAt = null;
      queuedForMs = 0;
      // Without this the previous run's full bar and last stage linger until the
      // first frame of the new one arrives.
      if (fill) fill.style.width = '0%';
      if (label) label.textContent = serverState() === 'waking' ? WAKING_LABEL : pendingLabel;
      render();
      timer = window.setInterval(render, 500);
    },

    update(status) {
      if (status.status === 'queued') {
        // The server's queue_position counts only *waiting* jobs, not the one currently
        // running. But being queued at all means something is ahead of us -- otherwise
        // we would be running. So position N means N jobs to get through, not N-1.
        jobsAhead = Math.max(1, status.queue_position ?? 1);
        if (label) {
          label.textContent =
            jobsAhead === 1
              ? 'Queued — one job ahead of you'
              : `Queued — ${jobsAhead} jobs ahead of you`;
        }
        if (fill) fill.style.width = '4%';
        queuedAt ??= Date.now();
        return;
      }

      // First non-queued update: bank however long we actually waited.
      if (queuedAt !== null) {
        queuedForMs = Date.now() - queuedAt;
        queuedAt = null;
      }
      jobsAhead = 0;

      if (fill) fill.style.width = `${Math.max(4, status.progress * 100).toFixed(1)}%`;
      if (label && status.stage) label.textContent = stageLabels[status.stage] ?? status.stage;
    },

    stop,
  };
}
