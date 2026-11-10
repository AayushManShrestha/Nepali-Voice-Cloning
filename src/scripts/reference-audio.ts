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

/**
 * Validate a recording or upload and return the bytes to send.
 *
 * `alwaysConvert` is for recordings: re-encode even when the server could read the
 * container, so every browser's recordings take the same path.
 */
export async function prepareReference(
  input: Blob,
  { alwaysConvert = false }: { alwaysConvert?: boolean } = {},
): Promise<ReferenceClip> {
  if (input.size === 0) throw new ReferenceAudioError('That file is empty.');
  if (input.size > MAX_REFERENCE_BYTES) {
    throw new ReferenceAudioError(
      `That file is ${megabytes(input.size)}; the limit is ${megabytes(MAX_REFERENCE_BYTES)}.`,
    );
  }

  const original = await input.arrayBuffer();
  const container = sniff(new Uint8Array(original));

  let decoded: AudioBuffer | null = null;
  let samples: Float32Array | null = null;
  try {
    decoded = await decode(original);
    samples = mono(decoded);
  } catch {
    // Not fatal yet: Chromium cannot decode AIFF, but the server can.
  }

  if (decoded && samples) {
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
  }

  const native = SERVER_READS[container];
  if (native && !alwaysConvert) {
    return {
      bytes: original,
      ...native,
      duration: decoded?.duration ?? null,
      trimmedFrom: null,
    };
  }

  if (!decoded || !samples) {
    throw new ReferenceAudioError(
      container === 'unknown'
        ? `That file could not be read as audio. Use ${SUPPORTED_SUMMARY}.`
        : `This browser cannot decode that ${NAMES[container]} file. ` +
          'Convert it to WAV or MP3, or try another browser.',
    );
  }

  // Converting can grow a file (an 8 MB M4A can be ~17 minutes, ~33 MB as WAV), and
  // the server's limit applies to what is sent. Keep the first ~4 minutes, which is
  // still far more voice than the encoder needs.
  const maxSamples = Math.floor((MAX_REFERENCE_BYTES - WAV_HEADER_BYTES) / 2);
  const kept = samples.length > maxSamples ? samples.subarray(0, maxSamples) : samples;
  return {
    bytes: encodeWav(kept, decoded.sampleRate),
    type: 'audio/wav',
    extension: 'wav',
    duration: kept.length / decoded.sampleRate,
    trimmedFrom: kept.length < samples.length ? decoded.duration : null,
  };
}
