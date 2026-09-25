/**
 * The light/dark toggle, shared by every page.
 *
 * This used to live inside studio.ts, which is fine while the studio is the only
 * thing on the site -- but the evaluation page has a theme toggle and deliberately
 * does not ship the synthesis island, so the toggle has to stand on its own.
 *
 * Base.astro resolves the saved choice inline before first paint (so there is no
 * flash); this module only handles the click.
 *
 * Importing it is enough -- it wires itself up. Pages that also draw from the theme
 * listen for the `themechange` event dispatched here.
 */
export function initTheme(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  button?.addEventListener('click', () => {
    const root = document.documentElement;
    const currentlyDark =
      root.dataset.theme === 'dark' ||
      (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = currentlyDark ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* storage blocked; the choice just won't persist */
    }
    document.dispatchEvent(new CustomEvent('themechange'));
  });
}

initTheme();
