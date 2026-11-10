/**
 * Turns whatever the visitor recorded or uploaded into a clip the model server can read.
 *
 * The server decodes with libsndfile (pinned: soundfile 0.12.1, libsndfile 1.2.0). That
 * reads WAV, FLAC, MP3, Ogg (Vorbis or Opus) and AIFF, but not WebM or MP4 -- which is
 * exactly what browsers record into. Chrome, Edge and Brave record WebM/Opus, Safari
 * records MP4/AAC, and only Firefox records Ogg. Phones save voice memos as M4A. Sending
 * those untouched fails on the server with "Format not recognised".
 *
 * So:
 *
 *  - A file the server already reads is sent byte for byte. Its speaker embedding is
 *    then exactly what it has always been; nothing about those formats changes.
 *  - Anything else is decoded by the browser and re-encoded as 16 kHz mono 16-bit WAV,
 *    the rate the speaker encoder works at anyway.
 *  - Recordings are always re-encoded. Their container depends on the browser, and
 *    there is no original file worth preserving.
 *
 * Every clip the browser can decode is also checked for length and for silence here,
 * so a muted or wrong microphone is caught at once rather than after a minute in the
 * queue.
 *
 * Decoding and encoding are separate steps (`loadReference`, then `clipFor`) because
 * the visitor can edit a clip in between: the encoder averages every 1.6 s window of
 * what it is given, so a cough or a second voice left in the clip ends up in the
 * clone. Trimming the ends and cutting out the middle are both just a matter of which
 * pieces of the decoded samples get joined and encoded.
 */

/** The server's MAX_AUDIO_BYTES. Uploads above this are refused before reading. */
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

/** The rate the speaker encoder works at; converted clips are written at this rate. */
const TARGET_RATE = 16_000;

/** Shorter than this and there is too little voice to embed. Five seconds is ideal. */
const MIN_SECONDS = 1;

/** Peak below -60 dBFS: nothing but noise floor, i.e. a muted or wrong microphone. */
const SILENT_PEAK = 0.001;

const WAV_HEADER_BYTES = 44;

type Container = 'wav' | 'flac' | 'mp3' | 'ogg' | 'aiff' | 'webm' | 'mp4' | 'aac' | 'unknown';

const NAMES: Record<Container, string> = {
  wav: 'WAV', flac: 'FLAC', mp3: 'MP3', ogg: 'Ogg', aiff: 'AIFF',
  webm: 'WebM', mp4: 'M4A', aac: 'AAC', unknown: 'audio',
};

/** What the server's libsndfile decodes as-is, each confirmed against real files. */
const SERVER_READS: Partial<Record<Container, { type: string; extension: string }>> = {
  wav: { type: 'audio/wav', extension: 'wav' },
  flac: { type: 'audio/flac', extension: 'flac' },
  mp3: { type: 'audio/mpeg', extension: 'mp3' },
  ogg: { type: 'audio/ogg', extension: 'ogg' },
  aiff: { type: 'audio/aiff', extension: 'aiff' },
};

/** For the upload control's `accept` and its hint; keep the two in step. */
export const UPLOAD_ACCEPT = [
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm', '.aif', '.aiff',
  'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
  'audio/flac', 'audio/ogg', 'audio/opus', 'audio/webm', 'audio/aiff', 'audio/x-aiff',
].join(',');

const SUPPORTED_SUMMARY = 'WAV, MP3, M4A, FLAC, Ogg, Opus, WebM or AIFF';

/** A problem with the clip itself. The message is written for the visitor. */
export class ReferenceAudioError extends Error {}

export interface ReferenceClip {
  /** Exactly what gets sent to the server. */
  bytes: ArrayBuffer;
  /** MIME type of `bytes`. */
  type: string;
  /** File extension for `bytes`, for the download link. */
  extension: string;
  /** Seconds of audio in `bytes`; null when this browser cannot decode the file. */
  duration: number | null;
  /** Seconds in the original, when longer than what is sent; otherwise null. */
  trimmedFrom: number | null;
}

/** Identify the container from its leading bytes. Extensions and MIME types lie. */
function sniff(bytes: Uint8Array, offset = 0): Container {
  const b = bytes.subarray(offset);
  const ascii = (at: number, length: number) =>
    String.fromCharCode(...b.subarray(at, at + length));

  if (['RIFF', 'RIFX', 'RF64'].includes(ascii(0, 4)) && ascii(8, 4) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(8, 4))) return 'aiff';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (ascii(4, 4) === 'ftyp') return 'mp4';
  if (ascii(0, 3) === 'ID3' && b.length >= 10) {
    // An ID3v2 tag can front MP3, AAC or even FLAC. Skip it and look at what follows.
    // Its size is four 7-bit bytes, excluding the 10-byte header and optional footer.
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    const footer = b[5] & 0x10 ? 10 : 0;
    const next = sniff(bytes, offset + 10 + size + footer);
    return next === 'unknown' ? 'mp3' : next;
  }
  // A bare MPEG frame sync. The layer bits tell MP3 (non-zero) from ADTS AAC (zero).
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return (b[1] & 0x06) === 0 ? 'aac' : 'mp3';
  return 'unknown';
}

/**
 * Decode with the browser's own codecs, resampled to 16 kHz.
 *
 * Some browsers refuse a context below 22.05 kHz; then decode at their default rate and
 * let the server resample, which it does for any non-16 kHz input anyway.
 */
async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  let context: OfflineAudioContext;
  try {
    context = new OfflineAudioContext(1, 1, TARGET_RATE);
  } catch {
    context = new OfflineAudioContext(1, 1, 44_100);
  }
  // decodeAudioData detaches the buffer it is given, and the original may still be sent.
  return context.decodeAudioData(bytes.slice(0));
}

/** Average the channels, as the server's `librosa.load(mono=True)` does. */
function mono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i += 1) out[i] += channel[i] / buffer.numberOfChannels;
  }
  return out;
}

function peak(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i]);
    if (v > max) max = v;
  }
  return max;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(WAV_HEADER_BYTES + samples.length * 2));
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return view.buffer;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** A decoded, validated recording or upload, before any cropping. */
export interface LoadedReference {
  /** The file exactly as recorded or chosen. */
  original: ArrayBuffer;
  /** Set when `original` can be sent as is: the server reads it and it is not a recording. */
  native: { type: string; extension: string } | null;
  /** Mono samples at `rate`; null when this browser cannot decode the file. */
  samples: Float32Array | null;
  rate: number;
  /** Seconds; null when this browser cannot decode the file. */
  duration: number | null;
}

/** A stretch of a clip, in seconds. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Longest stretch that fits the server's byte limit once encoded as 16-bit WAV. At
 * 16 kHz that is about 4 minutes 22 seconds, far more voice than the encoder needs.
 */
export const maxSendSeconds = (rate: number): number =>
  Math.floor((MAX_REFERENCE_BYTES - WAV_HEADER_BYTES) / 2) / rate;

/**
 * Decode and validate a recording or upload.
 *
 * `alwaysConvert` is for recordings: re-encode even when the server could read the
 * container, so every browser's recordings take the same path.
 */
export async function loadReference(
  input: Blob,
  { alwaysConvert = false }: { alwaysConvert?: boolean } = {},
): Promise<LoadedReference> {
  if (input.size === 0) throw new ReferenceAudioError('That file is empty.');
  if (input.size > MAX_REFERENCE_BYTES) {
    throw new ReferenceAudioError(
      `That file is ${megabytes(input.size)}; the limit is ${megabytes(MAX_REFERENCE_BYTES)}.`,
    );
  }

  const original = await input.arrayBuffer();
  const container = sniff(new Uint8Array(original));
  const native = (!alwaysConvert && SERVER_READS[container]) || null;

  let decoded: AudioBuffer | null = null;
  let samples: Float32Array | null = null;
  try {
    decoded = await decode(original);
    samples = mono(decoded);
  } catch {
    // Not fatal yet: Chromium cannot decode AIFF, but the server can.
  }

  if (!decoded || !samples) {
    if (native) return { original, native, samples: null, rate: 0, duration: null };
    throw new ReferenceAudioError(
      container === 'unknown'
        ? `That file could not be read as audio. Use ${SUPPORTED_SUMMARY}.`
        : `This browser cannot decode that ${NAMES[container]} file. ` +
          'Convert it to WAV or MP3, or try another browser.',
    );
  }
  if (decoded.duration < MIN_SECONDS) {
    throw new ReferenceAudioError(
      `That clip is only ${decoded.duration.toFixed(1)} seconds long. ` +
        'Use at least a second of speech; five is ideal.',
    );
  }
  if (peak(samples) < SILENT_PEAK) {
    throw new ReferenceAudioError(
      'That clip is silent. If you recorded it, check that the right microphone is ' +
        'selected and not muted.',
    );
  }
  return { original, native, samples, rate: decoded.sampleRate, duration: decoded.duration };
}

/** Fade length at each join, so a cut never lands as a click. */
const JOIN_FADE_SECONDS = 0.005;

/**
 * The kept pieces of a clip, back to back, with a short fade at every join. A piece
 * that starts at the very beginning or ends at the very end keeps that edge as is.
 */
export function joinPieces(samples: Float32Array, rate: number, pieces: Span[]): Float32Array {
  const ranges = pieces
    .map((p) => [Math.max(0, Math.floor(p.start * rate)), Math.min(samples.length, Math.ceil(p.end * rate))])
    .filter(([a, b]) => b > a);
  const out = new Float32Array(ranges.reduce((n, [a, b]) => n + b - a, 0));
  const fade = Math.max(1, Math.round(JOIN_FADE_SECONDS * rate));
  let at = 0;
  for (const [a, b] of ranges) {
    out.set(samples.subarray(a, b), at);
    const n = Math.min(fade, Math.floor((b - a) / 2));
    for (let i = 0; i < n; i += 1) {
      if (a > 0) out[at + i] *= i / n;
      if (b < samples.length) out[at + (b - a) - 1 - i] *= i / n;
    }
    at += b - a;
  }
  return out;
}

/**
 * The bytes to send for the `kept` pieces of a clip (all of it when omitted).
 *
 * The whole of a file the server reads is sent byte for byte, so its speaker embedding
 * is exactly what it has always been. Anything cut, a recording, or a format the server
 * cannot read is encoded as WAV -- capped at the byte limit, which an uncut 17-minute
 * M4A would otherwise blow through.
 */
export function clipFor(ref: LoadedReference, kept?: Span[] | null): ReferenceClip {
  const { samples, rate, duration } = ref;
  if (!samples || duration === null) {
    return { bytes: ref.original, ...ref.native!, duration: null, trimmedFrom: null };
  }
  const pieces = kept ?? [{ start: 0, end: duration }];
  const whole =
    pieces.length === 1 &&
    Math.floor(pieces[0].start * rate) <= 0 &&
    Math.ceil(pieces[0].end * rate) >= samples.length;
  if (whole && ref.native) {
    return { bytes: ref.original, ...ref.native, duration, trimmedFrom: null };
  }
  const joined = whole ? samples : joinPieces(samples, rate, pieces);
  const maxSamples = Math.floor((MAX_REFERENCE_BYTES - WAV_HEADER_BYTES) / 2);
  const sent = joined.length > maxSamples ? joined.subarray(0, maxSamples) : joined;
  return {
    bytes: encodeWav(sent, rate),
    type: 'audio/wav',
    extension: 'wav',
    duration: sent.length / rate,
    trimmedFrom: sent.length < joined.length ? joined.length / rate : null,
  };
}

/**
 * Where editing starts. A recording loses its first 0.1 s and last 0.2 s, which is where
 * the clicks of the record and stop buttons land; everything else is left for the
 * visitor to see and delete. An upload starts whole, so unedited it is still sent byte
 * for byte.
 */
export function initialSpan(ref: LoadedReference, { recording = false } = {}): Span {
  const { duration } = ref;
  if (duration === null) return { start: 0, end: 0 };
  if (!recording || duration - 0.3 < MIN_SECONDS) return { start: 0, end: duration };
  return { start: 0.1, end: duration - 0.2 };
}

/** Least audio that editing may leave: the same floor as a whole clip. */
export const MIN_SPAN_SECONDS = MIN_SECONDS;
