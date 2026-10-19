/**
 * The model-server indicator in the header, shared by both studios.
 *
 * Each studio passes its own Space's health check. /mos talks to no server and
 * renders no indicator (SiteHeader's `status` prop), so this is a no-op there.
 */

export interface HealthLike {
  models_loaded: boolean;
  queue_depth: number;
}

export type ServerState = 'probing' | 'ready' | 'waking' | 'down';

let current: ServerState = 'probing';

/** What the indicator last showed. progress.ts reads it to explain a slow start. */
export function serverState(): ServerState {
  return current;
}

export function initServerStatus(check: () => Promise<HealthLike | null>): void {
  const dot = document.querySelector<HTMLElement>('[data-backend-status] .dot');
  const label = document.querySelector<HTMLElement>('[data-backend-label]');
  if (!dot || !label) return;

  const set = (state: ServerState, text: string) => {
    current = state;
    dot.dataset.state = state;
    label.textContent = text;
  };

  void (async () => {
    const health = await check();
    if (health?.models_loaded) {
      set('ready', health.queue_depth > 0 ? `queue ${health.queue_depth}` : 'model server ready');
      return;
    }
    // Either asleep or still loading. The probe above already started waking it.
    set('waking', 'waking model server');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((r) => setTimeout(r, 6000));
      const again = await check();
      if (again?.models_loaded) {
        set('ready', 'model server ready');
        return;
      }
    }
    set('down', 'model server unreachable');
  })();
}
