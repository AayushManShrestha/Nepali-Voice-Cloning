/**
 * Canvas renderers for the synthesis output.
 *
 * The backend returns raw arrays rather than rendered PNGs, so everything here is drawn
 * client-side: axes, ticks, colour bars and all. That keeps the response ~1.6-7.6x
 * smaller and lets the plots respond to the theme and to audio playback.
 */

export interface Matrix {
  shape: [number, number];
  range: [number, number];
  data: string;
}

export function decodeMatrix(block: Matrix): { rows: number; cols: number; values: Uint8Array } {
  const binary = atob(block.data);
  const values = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) values[i] = binary.charCodeAt(i);
  const [rows, cols] = block.shape;
  return { rows, cols, values };
}

/* --- colour ------------------------------------------------------------- */

// Magma: perceptually uniform, legible in greyscale, warm high end.
const MAGMA: Array<[number, number, number]> = [
  [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
  [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191],
];

// Viridis, for the alignment plot -- matches the original matplotlib output.
const VIRIDIS: Array<[number, number, number]> = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
  [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
];

export const RAMPS = { magma: MAGMA, viridis: VIRIDIS };

function ramp(stops: Array<[number, number, number]>, t: number): [number, number, number] {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const scaled = c * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* --- canvas plumbing ----------------------------------------------------- */

interface Box { x: number; y: number; w: number; h: number }

function fit(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function monoFont(px: number): string {
  const family = cssVar('--font-mono') || 'monospace';
  return `${px}px ${family}`;
}

/** Tick values at 1/2/5 x 10^n spacing, the standard "nice number" choice. */
function niceTicks(min: number, max: number, target = 6): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  return ticks;
}

interface AxisOpts {
  xLabel?: string;
  yLabel?: string;
  xMax?: number;
  yMax?: number;
  xMin?: number;
  yMin?: number;
  colorbar?: [number, number];
  stops?: Array<[number, number, number]>;
}

/** Draw the frame, ticks, numeric labels and axis titles. Returns the plot rectangle. */
function drawAxes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opts: AxisOpts,
): Box {
  const ink = cssVar('--ink-faint') || '#888';
  const rule = cssVar('--rule-strong') || '#ccc';
  const hasBar = !!opts.colorbar;

  const box: Box = {
    x: opts.yLabel ? 46 : 12,
    y: 10,
    w: 0,
    h: 0,
  };
  box.w = w - box.x - (hasBar ? 54 : 12);
  box.h = h - box.y - (opts.xLabel ? 38 : 14);

  ctx.save();
  ctx.font = monoFont(9.5);
  ctx.fillStyle = ink;
  ctx.strokeStyle = rule;
  ctx.lineWidth = 1;

  // frame
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);

  // x ticks
  const xMin = opts.xMin ?? 0;
  const xMax = opts.xMax ?? 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of niceTicks(xMin, xMax)) {
    const px = box.x + ((t - xMin) / (xMax - xMin || 1)) * box.w;
    ctx.beginPath();
    ctx.moveTo(px, box.y + box.h);
    ctx.lineTo(px, box.y + box.h + 4);
    ctx.stroke();
    ctx.fillText(formatTick(t), px, box.y + box.h + 6);
  }

  // y ticks
  const yMin = opts.yMin ?? 0;
  const yMax = opts.yMax ?? 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of niceTicks(yMin, yMax)) {
    const py = box.y + box.h - ((t - yMin) / (yMax - yMin || 1)) * box.h;
    ctx.beginPath();
    ctx.moveTo(box.x - 4, py);
    ctx.lineTo(box.x, py);
    ctx.stroke();
    ctx.fillText(formatTick(t), box.x - 6, py);
  }

  // titles
  ctx.font = monoFont(10);
  if (opts.xLabel) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.xLabel, box.x + box.w / 2, h - 2);
  }
  if (opts.yLabel) {
    ctx.save();
    ctx.translate(11, box.y + box.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
  }

  // colour bar
  if (opts.colorbar) {
    const stops = opts.stops ?? MAGMA;
    const bx = box.x + box.w + 12;
    const bw = 10;
    for (let i = 0; i < box.h; i += 1) {
      const [r, g, b] = ramp(stops, 1 - i / box.h);
      ctx.fillStyle = `rgb(${r} ${g} ${b})`;
      ctx.fillRect(bx, box.y + i, bw, 1);
    }
    ctx.strokeRect(bx + 0.5, box.y + 0.5, bw, box.h);
    ctx.fillStyle = ink;
    ctx.font = monoFont(9);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const [lo, hi] = opts.colorbar;
    for (const [frac, val] of [[0, hi], [0.5, (hi + lo) / 2], [1, lo]] as const) {
      ctx.fillText(formatTick(val), bx + bw + 4, box.y + frac * box.h);
    }
  }

  ctx.restore();
  return box;
}

function formatTick(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1);
}

/* --- matrix plots -------------------------------------------------------- */

export interface MatrixOpts extends AxisOpts {
  flipY?: boolean;
  transpose?: boolean;
  smooth?: boolean;
}

export function drawMatrix(canvas: HTMLCanvasElement, block: Matrix, opts: MatrixOpts = {}): void {
  const { rows, cols, values } = decodeMatrix(block);
  const stops = opts.stops ?? MAGMA;
  const flipY = opts.flipY ?? true;

  // Logical display dimensions after an optional transpose.
  const dw = opts.transpose ? rows : cols;
  const dh = opts.transpose ? cols : rows;

  const buffer = document.createElement('canvas');
  buffer.width = dw;
  buffer.height = dh;
  const bctx = buffer.getContext('2d')!;
  const image = bctx.createImageData(dw, dh);

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = values[r * cols + c];
      const dx = opts.transpose ? r : c;
      const dyRaw = opts.transpose ? c : r;
      const dy = flipY ? dh - 1 - dyRaw : dyRaw;
      const [red, green, blue] = ramp(stops, v / 255);
      const o = (dy * dw + dx) * 4;
      image.data[o] = red;
      image.data[o + 1] = green;
      image.data[o + 2] = blue;
      image.data[o + 3] = 255;
    }
  }
  bctx.putImageData(image, 0, 0);

  const { ctx, w, h } = fit(canvas);
  const box = drawAxes(ctx, w, h, {
    ...opts,
    xMax: opts.xMax ?? dw,
    yMax: opts.yMax ?? dh,
    colorbar: opts.colorbar ?? block.range,
    stops,
  });

  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.imageSmoothingEnabled = opts.smooth ?? true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(buffer, box.x, box.y, box.w, box.h);
  ctx.restore();
}

/* --- waveform ------------------------------------------------------------ */

export function computePeaks(samples: Float32Array, buckets: number): Float32Array {
  const peaks = new Float32Array(buckets * 2);
  const stride = samples.length / buckets;
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * stride);
    const end = Math.min(samples.length, Math.floor((b + 1) * stride));
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i += 1) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  opts: { duration?: number; playhead?: number; axes?: boolean } = {},
): void {
  const { ctx, w, h } = fit(canvas);
  const duration = opts.duration ?? 1;
  const playhead = opts.playhead ?? -1;

  const box = opts.axes === false
    ? { x: 0, y: 0, w, h }
    : drawAxes(ctx, w, h, {
        xLabel: 'Time (s)',
        yLabel: 'Amplitude',
        xMax: duration,
        yMin: -1,
        yMax: 1,
      });

  const buckets = peaks.length / 2;
  const mid = box.y + box.h / 2;
  const half = (box.h / 2) * 0.96;

  // zero line
  ctx.strokeStyle = cssVar('--viz-grid') || 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(box.x, mid);
  ctx.lineTo(box.x + box.w, mid);
  ctx.stroke();

  // A filled min/max envelope rather than one rect per bucket. At these plot heights a
  // per-bucket bar is sub-pixel wide and all but disappears once alpha is applied.
  const envelope = (from: number, to: number): Path2D => {
    const path = new Path2D();
    path.moveTo(box.x + (from / buckets) * box.w, mid - peaks[from * 2 + 1] * half);
    for (let b = from; b < to; b += 1) {
      path.lineTo(box.x + (b / buckets) * box.w, mid - peaks[b * 2 + 1] * half);
    }
    for (let b = to - 1; b >= from; b -= 1) {
      path.lineTo(box.x + (b / buckets) * box.w, mid - peaks[b * 2] * half);
    }
    path.closePath();
    return path;
  };

  const split = playhead >= 0 ? Math.round(playhead * buckets) : 0;

  ctx.fillStyle = cssVar('--wave') || '#333';
  ctx.globalAlpha = 0.55;
  ctx.fill(envelope(Math.max(0, split - 1), buckets));
  ctx.globalAlpha = 1;

  if (playhead >= 0 && split > 0) {
    ctx.fillStyle = cssVar('--accent');
    ctx.fill(envelope(0, split));
    const px = box.x + playhead * box.w;
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, box.y);
    ctx.lineTo(px, box.y + box.h);
    ctx.stroke();
  }
}

/* --- speaker embedding --------------------------------------------------- */

/**
 * The 256-d GE2E embedding as a 16x16 grid.
 *
 * `showValues` prints the number in each cell, matching the original matplotlib
 * heatmap; with it off the colour alone carries the structure, which reads better
 * when comparing two embeddings side by side.
 */
export function drawEmbedding(
  canvas: HTMLCanvasElement,
  embedding: number[],
  opts: { showValues?: boolean } = {},
): void {
  const side = Math.round(Math.sqrt(embedding.length));
  const { ctx, w, h } = fit(canvas);
  const box = drawAxes(ctx, w, h, {
    xLabel: 'Features',
    yLabel: 'Features',
    xMax: side,
    yMax: side,
  });

  // Cells fill the plot area rather than being forced square: a 16x16 grid in a wide
  // panel would otherwise occupy only the middle third, and the wider cell gives the
  // "0.00" labels room to breathe.
  const cellW = box.w / side;
  const cellH = box.h / side;
  const peak = Math.max(...embedding.map(Math.abs)) || 1;

  ctx.font = monoFont(Math.max(6, Math.min(9, cellW * 0.22, cellH * 0.5)));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < embedding.length; i += 1) {
    const row = Math.floor(i / side);
    const col = i % side;
    const value = embedding[i];
    const x = box.x + col * cellW;
    const y = box.y + row * cellH;

    if (opts.showValues) {
      ctx.fillStyle = cssVar('--paper-raised') || '#fff';
      ctx.fillRect(x, y, cellW, cellH);
      ctx.strokeStyle = cssVar('--rule') || '#eee';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x + 0.25, y + 0.25, cellW - 0.5, cellH - 0.5);
      ctx.fillStyle = cssVar('--ink') || '#000';
      ctx.fillText(value.toFixed(2), x + cellW / 2, y + cellH / 2);
    } else {
      const [r, g, b] = ramp(MAGMA, Math.abs(value) / peak);
      ctx.fillStyle = `rgb(${r} ${g} ${b})`;
      ctx.fillRect(x, y, Math.ceil(cellW), Math.ceil(cellH));
    }
  }
}

/* --- audio --------------------------------------------------------------- */

export async function decodeAudio(bytes: ArrayBuffer): Promise<{
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}> {
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    return {
      samples: buffer.getChannelData(0),
      sampleRate: buffer.sampleRate,
      duration: buffer.duration,
    };
  } finally {
    void ctx.close();
  }
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
