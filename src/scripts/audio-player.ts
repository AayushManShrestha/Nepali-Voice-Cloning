/**
 * The waveform player: a canvas with real axes and a playhead, plus a transport.
 *
 * Shared by the cloning studio and the TTS page. A bare `<audio controls>` renders
 * as whatever the OS thinks a player looks like, which is the one element on either
 * page that ignores the design system entirely -- and it cannot show the signal.
 *
 * Markup contract, per `which` key:
 *
 *   [data-audio="X"]        <audio>, the actual element that plays
 *   [data-wave="X"]         <canvas>, the waveform
 *   [data-play="X"]         play/pause button; gets [data-playing] while playing
 *   [data-player-name="X"]  subtitle slot (duration, rate, …)
 *   [data-time="X"]         current time
 *   [data-dur="X"]          total duration
 *   [data-download="X"]     <a download>, unhidden once there is something to save
 */
import { computePeaks, decodeAudio, drawWaveform } from './viz';

const $ = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);

/** Peaks are expensive to recompute, and the theme/zoom paths need them again. */
const peakCache = new Map<string, { peaks: Float32Array; duration: number }>();
const objectUrls = new Map<string, string>();

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function cachedPeaks(which: string) {
  return peakCache.get(which);
}

export function mountedPlayers(): string[] {
  return [...peakCache.keys()];
}

/** Repaint one waveform, following the audio element's position if it is playing. */
export function paintWaveform(which: string, canvas: HTMLCanvasElement): void {
  const cached = peakCache.get(which);
  if (!cached) return;
  const audio = $<HTMLAudioElement>(`[data-audio="${which}"]`);
  drawWaveform(canvas, cached.peaks, {
    duration: cached.duration,
    playhead: audio && !audio.paused ? audio.currentTime / (audio.duration || 1) : -1,
  });
}

export async function mountPlayer(
  which: string,
  bytes: ArrayBuffer,
  subtitle: string,
  filename: string,
): Promise<void> {
  const audio = $<HTMLAudioElement>(`[data-audio="${which}"]`);
  const canvas = $<HTMLCanvasElement>(`[data-wave="${which}"]`);
  const play = $<HTMLButtonElement>(`[data-play="${which}"]`);
  const name = $<HTMLElement>(`[data-player-name="${which}"]`);
  const time = $<HTMLElement>(`[data-time="${which}"]`);
  const dur = $<HTMLElement>(`[data-dur="${which}"]`);
  const download = $<HTMLAnchorElement>(`[data-download="${which}"]`);
  if (!audio || !canvas || !play) return;

  // Release the previous clip before replacing it, or every run leaks a blob.
  const previous = objectUrls.get(which);
  if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  objectUrls.set(which, url);
  audio.src = url;
  if (name) name.textContent = subtitle;
  if (download) {
    download.href = url;
    download.download = filename;
    download.hidden = false;
  }

  const { samples, duration } = await decodeAudio(bytes);
  const peaks = computePeaks(samples, Math.max(200, Math.round(canvas.clientWidth / 2)));
  peakCache.set(which, { peaks, duration });
  drawWaveform(canvas, peaks, { duration });
  if (dur) dur.textContent = formatTime(duration);

  play.onclick = () => (audio.paused ? void audio.play() : audio.pause());
  audio.onplay = () => play.setAttribute('data-playing', '');
  audio.onpause = () => play.removeAttribute('data-playing');
  audio.onended = () => {
    play.removeAttribute('data-playing');
    drawWaveform(canvas, peaks, { duration });
  };
  audio.ontimeupdate = () => {
    if (time) time.textContent = formatTime(audio.currentTime);
    drawWaveform(canvas, peaks, {
      duration,
      playhead: audio.currentTime / (audio.duration || 1),
    });
  };
  canvas.onclick = (event) => {
    const rect = canvas.getBoundingClientRect();
    // The plot is inset by the axis margins; map the click onto the plot area.
    const frac = (event.clientX - rect.left - 46) / (rect.width - 58);
    audio.currentTime = Math.min(1, Math.max(0, frac)) * (audio.duration || 0);
  };
}
