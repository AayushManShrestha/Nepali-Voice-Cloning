/**
 * Fullscreen view for any canvas plot, shared by both studios.
 *
 * The enlarged plot is genuinely re-rendered at the larger size rather than being a
 * scaled-up bitmap -- which is the whole point, since these are drawn from arrays and
 * a mel spectrogram at 1140px wide is a different amount of detail than at 340px.
 *
 * Markup contract:
 *
 *   [data-zoom]         <dialog>
 *   [data-zoom-canvas]  <canvas> inside it
 *   [data-zoom-title]   caption slot
 *   [data-zoom-close]   close button
 *   [data-expand="K"]   opens plot K; [data-expand-title] labels it
 */
const $ = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
const $$ = <T extends Element>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel));

export interface ZoomController {
  /** The plot currently enlarged, or null. */
  readonly open: string | null;
  /** Re-render the enlarged plot, if one is open. Call after a theme flip. */
  render(): void;
}

export function wireZoom(
  paint: (key: string, canvas: HTMLCanvasElement) => void,
  hasResult: () => boolean,
  /** Inline canvases that should also open on click, as [selector, key] pairs. */
  clickable: Array<[string, string]> = [],
): ZoomController {
  const dialog = $<HTMLDialogElement>('[data-zoom]');
  const canvas = $<HTMLCanvasElement>('[data-zoom-canvas]');
  const title = $<HTMLElement>('[data-zoom-title]');

  let openKey: string | null = null;
  const controller: ZoomController = {
    get open() {
      return openKey;
    },
    render() {
      if (openKey && canvas && dialog?.open) paint(openKey, canvas);
    },
  };
  if (!dialog || !canvas) return controller;

  const open = (key: string, label: string) => {
    if (!hasResult()) return;
    openKey = key;
    if (title) title.textContent = label;
    dialog.showModal();
    // Wait for layout so the canvas has its final size before drawing into it.
    requestAnimationFrame(() => controller.render());
  };

  for (const button of $$<HTMLButtonElement>('[data-expand]')) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      open(button.dataset.expand!, button.dataset.expandTitle ?? 'Plot');
    });
  }

  // Clicking a plot itself opens it too -- except waveforms, where a click already
  // means "seek", so those are never passed in here.
  for (const [selector, key] of clickable) {
    const inline = $<HTMLCanvasElement>(selector);
    if (!inline) continue;
    inline.style.cursor = 'zoom-in';
    inline.addEventListener('click', () => {
      const label = inline.closest('figure')?.querySelector('figcaption')?.textContent?.trim();
      open(key, label ?? 'Plot');
    });
  }

  $<HTMLButtonElement>('[data-zoom-close]')?.addEventListener('click', () => dialog.close());

  // Click outside the panel closes it. <dialog> handles Escape natively.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    openKey = null;
  });

  window.addEventListener('resize', () => {
    if (dialog.open) controller.render();
  });

  return controller;
}
