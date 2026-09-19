/**
 * Canvas renderers for the synthesis output.
 *
 * The backend used to return seven matplotlib PNGs -- 374 KB of raster, 86% of the
 * response, and the bulk of its latency. It now returns the underlying arrays as
 * base64 uint8 and we draw them here, which is ~40x smaller and lets the plots be
 * interactive (hover readouts, a playhead locked to audio playback).
 */

export interface Matrix {
  shape: [number, number];
  range: [number, number];
  data: string;
}

/** Decode a base64 uint8 payload into its 2-D shape. */
export function decodeMatrix(block: Matrix): {
  rows: number;
  cols: number;
  values: Uint8Array;
} {
  const binary = atob(block.data);
  const values = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) values[i] = binary.charCodeAt(i);
  const [rows, cols] = block.shape;
  return { rows, cols, values };
}

/* --- colour ramps ---------------------------------------------------------- */

// Magma, sampled at 9 stops. Perceptually uniform, prints legibly in greyscale, and
// its warm high end sits naturally beside the vermilion accent.
const MAGMA: Array<[number, number, number]> = [
  [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
  [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191],
];

function ramp(stops: Array<[number, number, number]>, t: number): [number, number, number] {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function parseColor(value: string): [number, number, number] {
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.fillStyle = value;
  const hex = probe.fillStyle as string;
  if (hex.startsWith('#')) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }
  const nums = hex.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return [nums[0], nums[1], nums[2]];
}

/* --- canvas plumbing ------------------------------------------------------- */

function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return ctx;
}

/**
 * Render a quantised matrix.
 *
 * `flipY` puts row 0 at the bottom, matching `origin='lower'` in the original
 * matplotlib plots -- for a mel spectrogram, low frequencies belong at the bottom.
 */
export function drawMatrix(
  canvas: HTMLCanvasElement,
  block: Matrix,
  opts: { stops?: Array<[number, number, number]>; flipY?: boolean; smooth?: boolean } = {},
): void {
  const { rows, cols, values } = decodeMatrix(block);
  const stops = opts.stops ?? MAGMA;
  const flipY = opts.flipY ?? true;

  const buffer = document.createElement('canvas');
  buffer.width = cols;
  buffer.height = rows;
  const bctx = buffer.getContext('2d')!;
  const image = bctx.createImageData(cols, rows);

  for (let r = 0; r < rows; r += 1) {
    const targetRow = flipY ? rows - 1 - r : r;
    for (let c = 0; c < cols; c += 1) {
      const [red, green, blue] = ramp(stops, values[r * cols + c] / 255);
      const o = (targetRow * cols + c) * 4;
      image.data[o] = red;
      image.data[o + 1] = green;
      image.data[o + 2] = blue;
      image.data[o + 3] = 255;
    }
  }
  bctx.putImageData(image, 0, 0);

  const rect = canvas.getBoundingClientRect();
  const ctx = fit(canvas);
  ctx.imageSmoothingEnabled = opts.smooth ?? true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(buffer, 0, 0, rect.width, rect.height);
}

/** Alignment weights read better as ink-to-accent than as a spectral ramp. */
export function alignmentStops(): Array<[number, number, number]> {
  const bg = parseColor(cssVar('--viz-bg') || '#ffffff');
  const accent = parseColor(cssVar('--accent') || '#c0392b');
  return [bg, accent];
}

/* --- waveform -------------------------------------------------------------- */

/** Reduce a long signal to per-pixel min/max pairs, the standard way to draw audio. */
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
  playhead = -1,
): void {
  const rect = canvas.getBoundingClientRect();
  const ctx = fit(canvas);
  const buckets = peaks.length / 2;
  const mid = rect.height / 2;
  const barWidth = rect.width / buckets;

  ctx.strokeStyle = cssVar('--viz-grid') || 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(rect.width, mid);
  ctx.stroke();

  const played = playhead >= 0 ? playhead * rect.width : -1;
  for (let b = 0; b < buckets; b += 1) {
    const x = b * barWidth;
    ctx.fillStyle =
      played >= 0 && x <= played ? cssVar('--accent') : cssVar('--wave-ghost');
    const top = mid - peaks[b * 2 + 1] * mid * 0.94;
    const bottom = mid - peaks[b * 2] * mid * 0.94;
    ctx.fillRect(x, top, Math.max(barWidth * 0.8, 0.6), Math.max(bottom - top, 1));
  }

  if (played >= 0) {
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(played, 0);
    ctx.lineTo(played, rect.height);
    ctx.stroke();
  }
}

/* --- speaker embedding ----------------------------------------------------- */

/**
 * The 256-d GE2E embedding as a 16x16 grid.
 *
 * The old version printed the number into every cell -- 256 `ax.text` calls per
 * heatmap, twice per request. The grid alone carries the same structure.
 */
export function drawEmbedding(canvas: HTMLCanvasElement, embedding: number[]): void {
  const side = Math.round(Math.sqrt(embedding.length));
  const rect = canvas.getBoundingClientRect();
  const ctx = fit(canvas);
  const cell = Math.min(rect.width, rect.height) / side;
  const offsetX = (rect.width - cell * side) / 2;
  const offsetY = (rect.height - cell * side) / 2;

  // GE2E embeddings are L2-normalised and non-negative; scale to the observed max
  // so the structure is visible rather than washed out.
  const peak = Math.max(...embedding.map(Math.abs)) || 1;

  for (let i = 0; i < embedding.length; i += 1) {
    const row = Math.floor(i / side);
    const col = i % side;
    const [r, g, b] = ramp(MAGMA, Math.abs(embedding[i]) / peak);
    ctx.fillStyle = `rgb(${r} ${g} ${b})`;
    ctx.fillRect(
      offsetX + col * cell,
      offsetY + row * cell,
      Math.ceil(cell) - 0.5,
      Math.ceil(cell) - 0.5,
    );
  }
}

/** Decode a WAV/any browser-supported buffer to mono float samples. */
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
