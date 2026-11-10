/**
 * Nepali text entry: romanised-as-you-type, or the Preeti layout.
 *
 * There is no separate "paste Devanagari" mode. Neither mode touches Devanagari:
 * the romanised IME acts only on Latin letters and leaves pastes alone, and the Preeti
 * interceptor only rewrites keys in its own map. So pasting, or typing on a native
 * Nepali keyboard, works the same in both.
 *
 * Shared by the cloning studio and the TTS page. It used to exist twice -- once here
 * and once as a CDN `<script>` tag plus a half-wired writenepali.com embed in the
 * standalone TTS frontend, which had drifted to the point of shipping two elements
 * with the same id. One implementation is the whole reason those pages now live in
 * one project.
 *
 * Both models share a text front-end (`unidecode` into a ~68-symbol ASCII set), so
 * they share the same constraint: digits are not in the symbol set and are dropped
 * rather than spoken. The warning belongs here for the same reason the input does.
 */
import nepalify from 'nepalify';
import { attachRomanIme } from './roman-ime';

export type Mode = 'romanized' | 'preeti';

export interface NepaliInputOptions {
  /** Scope for every query; lets two instances coexist on one page. */
  root: ParentNode;
  /** The textarea's DOM id. nepalify (the Preeti layout) addresses elements by id, not by node. */
  textareaId: string;
  /** Called after any change to the text, with the current value. */
  onChange?: (value: string) => void;
}

export interface NepaliInput {
  value(): string;
  setValue(text: string): void;
  focus(): void;
  mode(): Mode;
}

const DIGITS = /[0-9०-९]/;

export function initNepaliInput(options: NepaliInputOptions): NepaliInput | null {
  const { root, textareaId, onChange } = options;
  const $ = <T extends Element>(sel: string): T | null => root.querySelector<T>(sel);
  const $$ = <T extends Element>(sel: string): T[] => Array.from(root.querySelectorAll<T>(sel));

  const textarea = document.getElementById(textareaId) as HTMLTextAreaElement | null;
  if (!textarea) return null;

  const count = $<HTMLElement>('[data-count]');
  const warning = $<HTMLElement>('[data-digit-warning]');
  const keyhelp = $<HTMLElement>('[data-keyhelp]');

  const sync = () => {
    if (count) count.textContent = String(textarea.value.length);
    // Devanagari and ASCII digits alike are absent from the model's symbol set.
    if (warning) warning.hidden = !DIGITS.test(textarea.value);
    onChange?.(textarea.value);
  };

  // Preeti is a fixed key-to-glyph layout, which is exactly what nepalify's
  // keypress interceptor does. Romanised typing is not: it needs whole-word
  // transliteration with suggestions, which is roman-ime.ts. (nepalify's own
  // `romanized` layout is the key-map kind, and turned `namaste` into नामासते.)
  const preeti = nepalify.interceptElementById(textareaId, { layout: 'traditional', enable: false });
  const popover = $<HTMLElement>('[data-ime]');
  const roman = popover ? attachRomanIme({ textarea, popover, onChange: sync }) : null;

  let current: Mode = 'romanized';

  const setMode = (mode: Mode) => {
    current = mode;
    if (mode === 'preeti') preeti.enable();
    else preeti.disable();
    if (mode === 'romanized') roman?.enable();
    else roman?.disable();
    if (keyhelp) keyhelp.hidden = mode !== 'preeti';
    $$<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode)),
    );
  };

  $$<HTMLButtonElement>('[data-mode]').forEach((button) =>
    button.addEventListener('click', () => setMode(button.dataset.mode as Mode)),
  );

  // `input` alone is not enough. nepalify intercepts `keypress`, rewrites the value
  // and calls preventDefault(), which dispatches no `input` event -- so typing
  // "namaste 2024" left the counter reading 8 of 12 and never raised the digit
  // warning, which is the one thing on the page whose job is to say that numbers are
  // dropped rather than spoken. `keyup` fires after the interceptor has run.
  textarea.addEventListener('input', sync);
  textarea.addEventListener('keyup', sync);

  const keyToggle = $<HTMLButtonElement>('[data-keyboard-toggle]');
  const keyFigure = $<HTMLElement>('[data-preeti-map]');
  keyToggle?.addEventListener('click', () => {
    const open = keyFigure?.hidden ?? true;
    if (keyFigure) keyFigure.hidden = !open;
    keyToggle.setAttribute('aria-expanded', String(open));
    keyToggle.textContent = open ? 'Hide the Preeti key map' : 'Show the Preeti key map';
  });

  $$<HTMLButtonElement>('[data-preset]').forEach((button) =>
    button.addEventListener('click', () => {
      textarea.value = button.dataset.preset!;
      sync();
      textarea.focus();
    }),
  );

  setMode('romanized');
  sync();

  return {
    value: () => textarea.value,
    setValue: (text) => {
      textarea.value = text;
      sync();
    },
    focus: () => textarea.focus(),
    mode: () => current,
  };
}
