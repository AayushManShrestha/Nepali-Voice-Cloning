/**
 * Edit a reference clip before it is sent, by deleting parts of it -- Audacity's
 * Delete: select, delete, and the gap closes.
 *
 *  - drag across anything unwanted (a cough, a click, silence at either end) to select
 *    it. A delete icon shows over the selection;
 *  - click the selection or the icon, or press Enter or Delete, to delete it. The
 *    waveform closes up, with a thin mark where the pieces now join;
 *  - Undo (the icon, or Ctrl/Cmd+Z) brings back the last deletion, as far back as you go;
 *    Redo (the icon, Ctrl/Cmd+Shift+Z or Ctrl+Y) deletes it again. A new deletion after
 *    an undo starts a new branch, so what was undone can no longer be redone;
 *  - click outside the selection, or press Escape, to drop it.
 *
 * One tool covers trimming as well: deleting from the very start or up to the very end
 * is a trim. Why it exists at all: the speaker encoder averages every 1.6 s window of
 * the reference into one embedding, so anything left in the clip is averaged into the
 * clone.
 *
 * Keyboard: Enter on the waveform selects a second in the middle; its edges are sliders
 * (arrows 0.1 s, Shift+arrows or PageUp/PageDown 1 s, Home/End); Enter then deletes.
 * Play plays the selection when there is one, otherwise exactly what will be sent.
 *
 * State is the list of kept pieces of the original, in order. The waveform shows them
 * joined, so every position on screen is a position in what will be sent; a selection
 * is mapped back onto the original only when it is deleted. At least a second always
 * has to stay (the same floor as a whole clip).
 */
import { encodeWav, joinPieces } from './reference-audio';
import type { Span } from './reference-audio';
import { computePeaks, cssVar, fit } from './viz';

export interface Trimmer {
  /** Show a clip, starting from the `initial` stretch of it (all of it if omitted). */
  load(samples: Float32Array, rate: number, initial?: Span): void;
  /** Hide the trimmer and forget the clip. */
  clear(): void;
  /** The pieces of the original that will be sent, in order, in seconds. */
  kept(): Span[];
}

export interface TrimmerOptions {
  /** Least audio that must stay, in seconds. */
  minLength: number;
  /** Most audio that can be sent, in seconds (e.g. what fits the upload limit). */
  maxLength?: (rate: number) => number;
}

type Edge = 'start' | 'end';

const SMALL_STEP = 0.1;
const BIG_STEP = 1;
/** Selections shorter than this are slips of the pointer. */
const TINY = 0.02;
/** A press that moves less than this many pixels is a click, not a drag. */
const CLICK_PX = 4;
/** A selection edge this close to either end of the waveform goes all the way. */
const SNAP_PX = 8;
const HISTORY_LIMIT = 50;

/** "4.2 s" under a minute, "1:04.2" above. */
function stamp(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, '0')}`;
}

const lengthOf = (pieces: Span[]) => pieces.reduce((n, p) => n + p.end - p.start, 0);

/** Delete [a, b) of the joined timeline from `pieces`, which are spans of the original. */
function removeRange(pieces: Span[], a: number, b: number): Span[] {
  const out: Span[] = [];
  let offset = 0;
  for (const piece of pieces) {
    const length = piece.end - piece.start;
    if (a > offset) out.push({ start: piece.start, end: piece.start + Math.min(length, a - offset) });
    if (b < offset + length) out.push({ start: piece.start + Math.max(0, b - offset), end: piece.end });
    offset += length;
  }
  return out.filter((p) => p.end - p.start > 0.0005);
}

/** Where consecutive pieces meet, on the joined timeline. */
function joinsOf(pieces: Span[]): number[] {
  const out: number[] = [];
  let offset = 0;
  for (let i = 0; i < pieces.length - 1; i += 1) {
    offset += pieces[i].end - pieces[i].start;
    out.push(offset);
  }
  return out;
}

export function createTrimmer(root: HTMLElement, options: TrimmerOptions): Trimmer {
  const q = <T extends HTMLElement>(sel: string) => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`clip trimmer: missing ${sel}`);
    return el;
  };
  const wave = q<HTMLElement>('[data-trim-wave]');
  const canvas = q<HTMLCanvasElement>('[data-trim-canvas]');
  const selBox = q('[data-trim-selection]');
  const deleteButton = q<HTMLButtonElement>('[data-trim-delete]');
  const selHandle = { start: q('[data-trim-sel-handle="start"]'), end: q('[data-trim-sel-handle="end"]') };
  const playhead = q('[data-trim-playhead]');
  const play = q<HTMLButtonElement>('[data-trim-play]');
  const undoButton = q<HTMLButtonElement>('[data-trim-undo]');
  const redoButton = q<HTMLButtonElement>('[data-trim-redo]');
  const readout = q('[data-trim-readout]');

  let samples: Float32Array | null = null;
  let rate = 16_000;
  /** Seconds in the original clip. */
  let duration = 0;
  /** Seconds kept when the clip was loaded: what "all" means in the readout. */
  let base = 0;
  /** Pieces of the original kept, in order. */
  let kept: Span[] = [];
  /** Earlier states of `kept`, newest last: what Undo goes back to. */
  let history: Span[][] = [];
  /** States undone, newest last: what Redo goes forward to. */
  let future: Span[][] = [];
  /** On the joined timeline. */
  let selection: Span | null = null;
  /** The kept pieces, joined: what is drawn and played. */
  let joined: Float32Array | null = null;
  let peaks: { width: number; data: Float32Array } | null = null;
  let notice = '';
  let noticeTimer = 0;

  const shown = () => lengthOf(kept);
  const minLength = () => Math.min(options.minLength, duration);
  const canDelete = () => !!selection && shown() - (selection.end - selection.start) >= minLength() - 1e-9;

  const say = (message: string) => {
    notice = message;
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      notice = '';
      layout();
    }, 2800);
    layout();
  };

  /* -- drawing -- */

  const draw = () => {
    if (!joined || root.hidden) return;
    const { ctx, w, h } = fit(canvas);
    if (w < 2 || !joined.length) return;
    if (peaks?.width !== w) peaks = { width: w, data: computePeaks(joined, w) };
    const data = peaks.data;
    // Normalise to the clip's own peak: a quiet recording should still show its shape.
    let top = 0;
    for (let i = 0; i < data.length; i += 1) top = Math.max(top, Math.abs(data[i]));
    const scale = top > 0 ? ((h / 2) * 0.9) / top : 0;
    const mid = h / 2;
    ctx.fillStyle = cssVar('--wave') || '#333';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let x = 0; x < w; x += 1) ctx.lineTo(x + 0.5, mid - data[x * 2 + 1] * scale - 0.5);
    for (let x = w - 1; x >= 0; x -= 1) ctx.lineTo(x + 0.5, mid - data[x * 2] * scale + 0.5);
    ctx.closePath();
    ctx.fill();

    // A thin dashed mark where something was deleted and the pieces now meet.
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const t of joinsOf(kept)) {
      const x = Math.round((t / shown()) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  };

  /** After the kept pieces change: rebuild the joined audio and redraw. */
  const rebuild = () => {
    joined = samples ? joinPieces(samples, rate, kept) : null;
    peaks = null;
    stopPlayback();
    draw();
    layout();
  };

  /* -- layout -- */

  const pct = (t: number) => `${(t / shown()) * 100}%`;
  const slider = (el: HTMLElement, value: number, min: number, max: number) => {
    el.setAttribute('aria-valuemin', min.toFixed(1));
    el.setAttribute('aria-valuemax', max.toFixed(1));
    el.setAttribute('aria-valuenow', value.toFixed(1));
    el.setAttribute('aria-valuetext', stamp(value));
  };

  const layout = () => {
    if (!duration) return;
    selBox.hidden = !selection;
    if (selection) {
      selBox.style.left = pct(selection.start);
      selBox.style.width = pct(selection.end - selection.start);
      slider(selHandle.start, selection.start, 0, selection.end);
      slider(selHandle.end, selection.end, selection.start, shown());
      const ok = canDelete();
      deleteButton.disabled = !ok;
      deleteButton.title = ok ? 'Delete (Enter)' : `At least ${stamp(minLength())} has to stay`;
    }
    undoButton.disabled = history.length === 0;
    redoButton.disabled = future.length === 0;

    const total = shown();
    const max = options.maxLength?.(rate) ?? Infinity;
    let text: string;
    if (notice) text = notice;
    else if (selection) {
      text = `selected ${stamp(selection.start)} – ${stamp(selection.end)} (${stamp(selection.end - selection.start)})`;
    } else if (total >= base - 0.0005) text = `all ${stamp(base)}`;
    else text = `keeping ${stamp(total)} of ${stamp(base)}`;
    if (!notice && total > max) text += ` · only the first ${stamp(max)} is sent`;
    readout.textContent = text;
  };

  /* -- edits -- */

  const setSelection = (span: Span | null) => {
    notice = '';
    if (span) {
      const start = Math.max(0, span.start);
      const end = Math.min(shown(), span.end);
      selection = end - start >= TINY ? { start, end } : null;
    } else {
      selection = null;
    }
    stopPlayback();
    layout();
  };

  const moveSelectionEdge = (edge: Edge, to: number) => {
    if (!selection) return;
    const gap = 0.05;
    if (edge === 'start') setSelection({ start: Math.min(Math.max(to, 0), selection.end - gap), end: selection.end });
    else setSelection({ start: selection.start, end: Math.max(Math.min(to, shown()), selection.start + gap) });
  };

  const deleteSelection = () => {
    if (!selection) return;
    if (!canDelete()) {
      say(`At least ${stamp(minLength())} has to stay`);
      return;
    }
    history.push(kept);
    if (history.length > HISTORY_LIMIT) history.shift();
    future = [];
    kept = removeRange(kept, selection.start, selection.end);
    selection = null;
    notice = '';
    rebuild();
    wave.focus();
  };

  /** Move through the history: pop a state off `from`, push the current one onto `to`. */
  const travel = (from: Span[][], to: Span[][]) => {
    const next = from.pop();
    if (!next) return;
    to.push(kept);
    kept = next;
    selection = null;
    notice = '';
    rebuild();
    // Undoing the last step disables the button that was just pressed, which drops
    // focus to the page and with it the keyboard shortcuts; keep it in the editor.
    if ((document.activeElement as HTMLButtonElement | null)?.disabled) wave.focus();
  };
  const undo = () => travel(history, future);
  const redo = () => travel(future, history);

  /* -- pointer -- */

  const timeAt = (clientX: number) => {
    const rect = wave.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * shown();
  };
  /** Like timeAt, but snapping to either end: nobody can start a drag on the exact
   *  first pixel, and a sliver left at the start would still be sent. */
  const snappedTimeAt = (clientX: number) => {
    const rect = wave.getBoundingClientRect();
    if (clientX - rect.left <= SNAP_PX) return 0;
    if (rect.right - clientX <= SNAP_PX) return shown();
    return timeAt(clientX);
  };

  wave.addEventListener('pointerdown', (e) => {
    if (!samples || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = e.target as Element;
    // The delete icon is a button with its own click.
    if (target.closest('[data-trim-delete]')) return;

    const t = snappedTimeAt(e.clientX);
    const x0 = e.clientX;
    let onMove: (now: number, ev: PointerEvent) => void;
    let onEnd: () => void;

    const selEl = target.closest<HTMLElement>('[data-trim-sel-handle]');
    if (selEl) {
      const edge = selEl.dataset.trimSelHandle as Edge;
      selEl.focus();
      wave.setPointerCapture(e.pointerId);
      onMove = (now) => moveSelectionEdge(edge, now);
      onEnd = () => {};
    } else {
      wave.focus();
      const inside = !!selection && t >= selection.start && t <= selection.end;
      let dragging = false;
      onMove = (now, ev) => {
        if (!dragging && Math.abs(ev.clientX - x0) < CLICK_PX) return;
        if (!dragging) {
          dragging = true;
          wave.setPointerCapture(e.pointerId);
        }
        setSelection({ start: Math.min(t, now), end: Math.max(t, now) });
      };
      // A click inside the selection deletes it; anywhere else, drops it.
      onEnd = () => {
        if (dragging) return;
        if (inside) deleteSelection();
        else setSelection(null);
      };
    }

    e.preventDefault();
    wave.setAttribute('data-dragging', '');
    const move = (ev: PointerEvent) => onMove(snappedTimeAt(ev.clientX), ev);
    const finish = (ev: PointerEvent) => {
      wave.removeEventListener('pointermove', move);
      wave.removeEventListener('pointerup', finish);
      wave.removeEventListener('pointercancel', finish);
      wave.removeAttribute('data-dragging');
      // A cancel is the browser taking the gesture (a vertical scroll on touch): it is
      // not a click, and must never delete anything.
      if (ev.type === 'pointerup') onEnd();
    };
    wave.addEventListener('pointermove', move);
    wave.addEventListener('pointerup', finish);
    wave.addEventListener('pointercancel', finish);
  });

  deleteButton.addEventListener('click', deleteSelection);
  undoButton.addEventListener('click', undo);
  redoButton.addEventListener('click', redo);

  /* -- keyboard -- */

  for (const edge of ['start', 'end'] as const) {
    selHandle[edge].addEventListener('keydown', (e) => {
      if (!selection) return;
      const step = e.shiftKey ? BIG_STEP : SMALL_STEP;
      const by: Record<string, number> = {
        ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step,
        PageDown: -BIG_STEP, PageUp: BIG_STEP, Home: -Infinity, End: Infinity,
      };
      if (!(e.key in by)) return;
      e.preventDefault();
      moveSelectionEdge(edge, selection[edge] + by[e.key]);
    });
  }

  root.addEventListener('keydown', (e) => {
    if (!samples) return;
    const target = e.target as HTMLElement;
    // Buttons answer Enter and Space themselves.
    if (target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && key === 'z') {
      if (!history.length) return;
      e.preventDefault();
      undo();
    } else if (mod && ((e.shiftKey && key === 'z') || (!e.shiftKey && key === 'y'))) {
      if (!future.length) return;
      e.preventDefault();
      redo();
    } else if ((e.key === 'Enter' || e.key === 'Delete' || e.key === 'Backspace') && selection) {
      e.preventDefault();
      deleteSelection();
    } else if ((e.key === 'Enter' || e.key === ' ') && target === wave) {
      // No selection yet: select a second in the middle to adjust from.
      e.preventDefault();
      const mid = shown() / 2;
      const half = Math.min(0.5, shown() / 4);
      setSelection({ start: mid - half, end: mid + half });
      selHandle.start.focus();
    } else if (e.key === 'Escape' && selection) {
      e.preventDefault();
      setSelection(null);
      wave.focus();
    }
  });

  /* -- playback: the selection, or exactly what will be sent -- */

  const audio = new Audio();
  let audioUrl: string | null = null;
  let playFrom = 0;
  let raf = 0;

  function stopPlayback() {
    if (!audioUrl) return;
    audio.pause();
    cancelAnimationFrame(raf);
    URL.revokeObjectURL(audioUrl);
    audioUrl = null;
    play.removeAttribute('data-playing');
    play.setAttribute('aria-label', 'Play');
    playhead.hidden = true;
  }

  const tick = () => {
    if (!audioUrl) return;
    playhead.style.left = pct(playFrom + audio.currentTime);
    raf = requestAnimationFrame(tick);
  };

  play.addEventListener('click', () => {
    if (!joined) return;
    if (audioUrl) return stopPlayback();
    const span = selection ?? { start: 0, end: shown() };
    playFrom = span.start;
    const slice = joined.subarray(Math.floor(span.start * rate), Math.ceil(span.end * rate));
    audioUrl = URL.createObjectURL(new Blob([encodeWav(slice, rate)], { type: 'audio/wav' }));
    audio.src = audioUrl;
    audio.onended = stopPlayback;
    void audio.play().catch(stopPlayback);
    play.setAttribute('data-playing', '');
    play.setAttribute('aria-label', 'Stop playing');
    playhead.hidden = false;
    tick();
  });

  /* -- repaint on resize and theme -- */

  new ResizeObserver(draw).observe(wave);
  document.addEventListener('themechange', draw);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);

  return {
    load(clip, clipRate, initial) {
      stopPlayback();
      samples = clip;
      rate = clipRate;
      duration = clip.length / clipRate;
      kept = [initial ?? { start: 0, end: duration }];
      base = lengthOf(kept);
      history = [];
      future = [];
      selection = null;
      notice = '';
      root.hidden = false;
      rebuild();
    },
    clear() {
      stopPlayback();
      samples = null;
      joined = null;
      duration = 0;
      kept = [];
      history = [];
      future = [];
      selection = null;
      root.hidden = true;
    },
    kept: () => kept.map((p) => ({ ...p })),
  };
}
