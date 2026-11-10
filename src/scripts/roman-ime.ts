/**
 * Romanised Nepali typing for a textarea, in the manner of Gboard's Nepali keyboard:
 * type a word in Latin letters, see Devanagari suggestions under it, and the first one
 * replaces the word when you type a space or punctuation.
 *
 *   namaste|        ->  नमस्ते  नमसते  नामस्ते ... namaste
 *   namaste |       ->  नमस्ते |
 *
 * Keys while suggestions are open: ↑/↓ choose, Enter takes the highlighted one,
 * Space (or any punctuation) takes it and keeps the character, Esc hides the list.
 * Tapping or clicking a suggestion takes it and adds a space, as a phone keyboard does.
 * Ctrl+Z undoes a conversion back to the Latin you typed (edits go through
 * execCommand('insertText'), which keeps the browser's own undo stack intact).
 *
 * This replaces nepalify's `romanized` layout, which was a fixed key-to-glyph map --
 * `a` was always ा, `h` was always ह -- so `namaste` became नामासते and `kathmandu`
 * कातहमानदु. It also listened for `keypress`, which Android keyboards do not send.
 * Everything here runs off `input` and composition events instead, so it behaves the
 * same under a phone keyboard's word-at-a-time composition as under a desktop one.
 *
 * Words are committed before the network has necessarily answered: if the space comes
 * first, the rule-based spelling goes in, and Google's answer replaces it a moment
 * later if it differs and the word is still there untouched. Waiting instead would
 * either stall typing or leave Latin on screen, and the two spellings agree on most
 * common words, so the swap is rarely visible.
 */
import { cachedCandidates, fetchCandidates, rankCandidates, rememberPick } from './transliterate';

const LETTER = /[A-Za-z]/;
/** Devanagari suggestions shown. */
const MAX_SHOWN = 6;
/** Debounce for lookups while a word is being typed. */
const LOOKUP_DELAY_MS = 60;
/** How long after a commit a late network answer may still correct the word. */
const UPGRADE_WINDOW_MS = 8000;

export interface RomanIme {
  enable(): void;
  disable(): void;
}

export interface RomanImeOptions {
  textarea: HTMLTextAreaElement;
  /** The suggestion box. Must contain `[data-ime-list]`; may contain `[data-ime-word]` and `[data-ime-status]`. */
  popover: HTMLElement;
  /** Called after an edit that dispatches no `input` event of its own. */
  onChange?: () => void;
}

interface Word {
  start: number;
  end: number;
  text: string;
}

interface Active extends Word {
  /** Devanagari candidates, best first. */
  candidates: string[];
  /** What the viewer has arrowed to, or null for the default (the first). */
  choice: string | null;
  status: 'loading' | 'ready' | 'offline';
}

interface Upgrade {
  start: number;
  /** What was committed. */
  output: string;
  roman: string;
  /** The better spelling, once the network has answered. */
  best?: string;
  at: number;
}

/** Start of the run of Latin letters that ends at `end`. */
const runStart = (text: string, end: number): number => {
  let i = end;
  while (i > 0 && LETTER.test(text[i - 1])) i--;
  return i;
};

/** End of the run of Latin letters that starts at `start`. */
const runEnd = (text: string, start: number): number => {
  let i = start;
  while (i < text.length && LETTER.test(text[i])) i++;
  return i;
};

/** How many characters at the end of `s` are word boundaries (anything but a Latin letter). */
const trailingBoundary = (s: string): number => {
  let n = 0;
  while (n < s.length && !LETTER.test(s[s.length - 1 - n])) n++;
  return n;
};

const sameWord = (a: Word | null, b: Word): boolean =>
  !!a && a.start === b.start && a.text === b.text;

/* ---- caret geometry ----------------------------------------------------- */

const MIRRORED = [
  'boxSizing', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontFamily',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'tabSize',
] as const;

/**
 * Where character `index` sits inside the textarea's border box, in pixels. A textarea
 * exposes no geometry for its text, so this lays the same text out in a hidden div with
 * the same box and font, and measures a marker span.
 */
function caretPoint(ta: HTMLTextAreaElement, index: number): { top: number; left: number; line: number } {
  const style = getComputedStyle(ta);
  const mirror = document.createElement('div');
  for (const prop of MIRRORED) mirror.style[prop] = style[prop];
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-9999px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    overflow: 'hidden',
    boxSizing: 'border-box',
    // clientWidth excludes a vertical scrollbar, which narrows the wrapping width.
    width: `${ta.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`,
  });
  mirror.textContent = ta.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = ta.value.slice(index) || '.';
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.offsetTop + parseFloat(style.borderTopWidth) - ta.scrollTop;
  const left = marker.offsetLeft + parseFloat(style.borderLeftWidth) - ta.scrollLeft;
  mirror.remove();
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
  return { top, left, line };
}

/* ---- the IME ------------------------------------------------------------ */

export function attachRomanIme({ textarea: ta, popover, onChange }: RomanImeOptions): RomanIme {
  const list = popover.querySelector<HTMLElement>('[data-ime-list]');
  const wordLabel = popover.querySelector<HTMLElement>('[data-ime-word]');
  const statusLabel = popover.querySelector<HTMLElement>('[data-ime-status]');
  if (!list) throw new Error('roman IME: popover has no [data-ime-list]');
  list.id ||= `${ta.id}-ime-list`;
  const coarse = window.matchMedia('(pointer: coarse)');

  let enabled = false;
  let composing = false;
  /** True while this module edits the text, so its own `input` events are ignored. */
  let busy = false;
  let active: Active | null = null;
  let upgrades: Upgrade[] = [];
  let lookupTimer = 0;

  /* -- reading the text -- */

  /** The Latin word the caret is in or just after, if any. */
  const wordAtCaret = (): Word | null => {
    const caret = ta.selectionStart;
    if (caret !== ta.selectionEnd) return null;
    const value = ta.value;
    const start = runStart(value, caret);
    if (start === caret) return null;
    const end = runEnd(value, caret);
    return { start, end, text: value.slice(start, end) };
  };

  /** The candidates as shown. */
  const options = (a: Active): string[] => a.candidates.slice(0, MAX_SHOWN);

  const selectedIndex = (a: Active, opts = options(a)): number =>
    a.choice === null ? 0 : Math.max(0, opts.indexOf(a.choice));

  /* -- writing the text -- */

  /**
   * Replace [start, end) with `text`, then put the caret at `caret` if given. Uses
   * execCommand so the edit is undoable; falls back to setRangeText when the textarea
   * is not focused (execCommand needs focus) or the browser refuses.
   */
  const replace = (start: number, end: number, text: string, caret?: number) => {
    busy = true;
    try {
      let done = false;
      if (document.activeElement === ta) {
        ta.setSelectionRange(start, end);
        try {
          done = document.execCommand('insertText', false, text);
        } catch {
          done = false;
        }
      }
      if (!done) {
        ta.setRangeText(text, start, end, 'preserve');
        onChange?.();
      }
      // Moving the selection of an unfocused field can steal focus in Safari.
      if (caret !== undefined && document.activeElement === ta) ta.setSelectionRange(caret, caret);
    } finally {
      busy = false;
    }
  };

  /**
   * Turn a Latin word into Devanagari. `explicit` is a suggestion the viewer chose;
   * without it, the arrowed-to choice or else the best candidate known right now.
   * `after` is text to insert after the word; `skip` is how many characters after the
   * word the caret should end up beyond (the boundary the viewer just typed).
   */
  const convert = (word: Word, opts: { explicit?: string; after?: string; skip?: number } = {}) => {
    const google = cachedCandidates(word.text);
    const best = rankCandidates(word.text, google)[0];
    const chosen = opts.explicit ?? (sameWord(active, word) ? active!.choice : null);
    const output = chosen ?? best;
    const after = opts.after ?? '';
    const caretAfter = word.start + output.length + after.length + (opts.skip ?? 0);

    active = null;
    close();

    if (chosen !== null && chosen !== best) rememberPick(word.text, chosen);
    replace(word.start, word.end, output + after, caretAfter);
    // Committed before the network answered: let the answer correct it.
    if (chosen === null && !google) queueUpgrade(word.start, output, word.text);
  };

  /** Commit the word ending just before the `boundary` characters left of the caret. */
  const commitBefore = (boundary: number): boolean => {
    const caret = ta.selectionStart;
    if (caret !== ta.selectionEnd) return false;
    const end = caret - boundary;
    const start = runStart(ta.value, end);
    if (start === end) return false;
    convert({ start, end, text: ta.value.slice(start, end) }, { skip: boundary });
    return true;
  };

  /* -- late corrections -- */

  const queueUpgrade = (start: number, output: string, roman: string) => {
    const entry: Upgrade = { start, output, roman, at: performance.now() };
    upgrades.push(entry);
    fetchCandidates(roman).then(
      (google) => {
        entry.best = rankCandidates(roman, google)[0];
        flushUpgrades();
      },
      () => {
        upgrades = upgrades.filter((u) => u !== entry);
      },
    );
  };

  /**
   * Apply corrections whose answers have arrived. Never mid-composition: changing the
   * text before a phone keyboard's live composition would break it, so those wait for
   * the composition to end.
   */
  const flushUpgrades = () => {
    if (!enabled || composing || busy) return;
    const now = performance.now();
    // Right to left, so applying one never moves the start of the next.
    const ready = upgrades.filter((u) => u.best !== undefined).sort((a, b) => b.start - a.start);
    if (!ready.length) return;
    upgrades = upgrades.filter((u) => u.best === undefined);

    let changed = false;
    for (const u of ready) {
      const best = u.best!;
      const end = u.start + u.output.length;
      if (best === u.output || now - u.at > UPGRADE_WINDOW_MS) continue;
      // Only if the word is still exactly what was committed.
      if (ta.value.slice(u.start, end) !== u.output) continue;
      if (LETTER.test(ta.value[end] ?? '')) continue;

      const delta = best.length - u.output.length;
      const shift = (p: number) => (p >= end ? p + delta : p);
      const [selStart, selEnd] = [ta.selectionStart, ta.selectionEnd];
      replace(u.start, end, best);
      if (document.activeElement === ta) ta.setSelectionRange(shift(selStart), shift(selEnd));
      for (const p of upgrades) if (p.start >= end) p.start += delta;
      if (active && active.start >= end) {
        active.start += delta;
        active.end += delta;
      }
      changed = true;
    }
    if (changed) refresh();
  };

  /* -- suggestions -- */

  const lookup = (text: string) => {
    window.clearTimeout(lookupTimer);
    lookupTimer = window.setTimeout(() => {
      fetchCandidates(text).then(
        (google) => {
          if (active?.text !== text) return;
          active.candidates = rankCandidates(text, google);
          active.status = 'ready';
          render();
        },
        () => {
          if (active?.text !== text) return;
          active.status = 'offline';
          render();
        },
      );
    }, LOOKUP_DELAY_MS);
  };

  /** Re-read the word at the caret and show, update or hide suggestions for it. */
  const refresh = () => {
    if (!enabled) return;
    const word = wordAtCaret();
    if (!word) {
      active = null;
      close();
      return;
    }
    if (sameWord(active, word)) {
      active!.end = word.end;
    } else {
      const google = cachedCandidates(word.text);
      active = {
        ...word,
        candidates: rankCandidates(word.text, google),
        choice: null,
        status: google ? 'ready' : 'loading',
      };
      if (!google) lookup(word.text);
    }
    render();
  };

  const close = () => {
    popover.hidden = true;
    ta.removeAttribute('aria-activedescendant');
  };

  const render = () => {
    if (!enabled || !active || document.activeElement !== ta) return close();
    const opts = options(active);
    const index = selectedIndex(active, opts);
    if (wordLabel) wordLabel.textContent = active.text;
    if (statusLabel) {
      statusLabel.textContent =
        active.status === 'loading' ? 'looking up…' : active.status === 'offline' ? 'offline: basic spelling' : '';
    }
    list.replaceChildren(
      ...opts.map((value, i) => {
        const li = document.createElement('li');
        li.id = `${list.id}-${i}`;
        li.setAttribute('role', 'option');
        li.dataset.index = String(i);
        li.setAttribute('aria-selected', String(i === index));
        li.lang = 'ne';
        li.className = 'deva';
        li.textContent = value;
        return li;
      }),
    );
    ta.setAttribute('aria-activedescendant', `${list.id}-${index}`);
    popover.hidden = false;
    position();
  };

  /** Pin the box under the line the word is on: at the word on desktop, full width on touch. */
  const position = () => {
    if (!active || popover.hidden) return;
    const point = caretPoint(ta, active.start);
    const below = Math.min(Math.max(point.top + point.line, 0), ta.clientHeight);
    popover.style.top = `${ta.offsetTop + below + 4}px`;
    if (coarse.matches) {
      popover.style.left = '0px';
      popover.style.right = '0px';
      return;
    }
    popover.style.right = '';
    const room = (popover.offsetParent as HTMLElement | null)?.clientWidth ?? ta.offsetWidth;
    const left = ta.offsetLeft + point.left - 10;
    popover.style.left = `${Math.max(0, Math.min(left, room - popover.offsetWidth))}px`;
  };

  /* -- events -- */

  ta.addEventListener('input', (event) => {
    if (!enabled || busy) return;
    const e = event as InputEvent;
    if (e.isComposing || composing) return refresh();
    flushUpgrades();
    const type = e.inputType || 'insertText';
    // Typing a boundary commits the word before it. Pastes and drops are left alone:
    // they may be meant as they are, and the last word still gets suggestions.
    if (type.startsWith('insert') && type !== 'insertFromPaste' && type !== 'insertFromDrop') {
      const data = type === 'insertLineBreak' || type === 'insertParagraph' ? '\n' : (e.data ?? '');
      const boundary = trailingBoundary(data);
      if (boundary > 0 && commitBefore(boundary)) return;
    }
    refresh();
  });

  ta.addEventListener('compositionstart', () => {
    composing = true;
  });

  ta.addEventListener('compositionend', (event) => {
    composing = false;
    if (!enabled) return;
    flushUpgrades();
    // Some keyboards commit the space as part of the composition, with no separate
    // `input` event for it afterwards.
    const data = event.data ?? '';
    const boundary = trailingBoundary(data);
    if (boundary > 0 && boundary < data.length && commitBefore(boundary)) return;
    refresh();
  });

  ta.addEventListener('keydown', (e) => {
    if (!enabled || !active || popover.hidden || e.isComposing) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const opts = options(active);
    const index = selectedIndex(active, opts);
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.shiftKey) {
      e.preventDefault();
      const next = (index + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      active.choice = opts[next];
      render();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Same as a space, minus the space: the arrowed-to choice, else the best so far.
      convert(active);
    } else if (e.key === 'Escape') {
      // Hides the list only; the word still converts on space. Ctrl+Z after a
      // conversion is the way back to the Latin.
      e.preventDefault();
      active = null;
      close();
    }
  });

  // Caret moved by mouse or keys: suggestions follow the word under it.
  ta.addEventListener('click', () => enabled && refresh());
  ta.addEventListener('keyup', (e) => {
    if (enabled && /^(Arrow(Left|Right)|Home|End|Page(Up|Down))$/.test(e.key)) refresh();
  });
  ta.addEventListener('scroll', position);
  window.addEventListener('resize', position);

  // Leaving the box converts a word still in progress: in this mode Latin is input,
  // and clicking "synthesise" straight after the last word should not send it as is.
  ta.addEventListener('blur', () => {
    if (!enabled) return;
    window.clearTimeout(lookupTimer);
    const word = wordAtCaret();
    active = word && sameWord(active, word) ? active : null;
    close();
    if (word) convert(word);
  });

  // Keep focus (and the caret) in the textarea when a suggestion is pressed.
  popover.addEventListener('mousedown', (e) => e.preventDefault());
  popover.addEventListener('click', (e) => {
    const li = (e.target as Element).closest<HTMLElement>('[role="option"]');
    if (!li || !active) return;
    const value = options(active)[Number(li.dataset.index)];
    if (value === undefined) return;
    const next = ta.value[active.end] ?? '';
    convert(active, {
      explicit: value,
      after: /\s/.test(next) ? '' : ' ',
      skip: /\s/.test(next) ? 1 : 0,
    });
    ta.focus();
  });

  return {
    enable() {
      if (enabled) return;
      enabled = true;
      ta.setAttribute('aria-autocomplete', 'list');
      ta.setAttribute('aria-controls', list.id);
      refresh();
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      window.clearTimeout(lookupTimer);
      active = null;
      upgrades = [];
      close();
      ta.removeAttribute('aria-autocomplete');
      ta.removeAttribute('aria-controls');
    },
  };
}
