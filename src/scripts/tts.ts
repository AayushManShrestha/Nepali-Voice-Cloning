/**
 * The /tts island.
 *
 * Smaller than the cloning studio: no reference audio to resolve, and two plots
 * rather than seven. It follows the same job/SSE shape because the Space now speaks
 * the same protocol.
 *
 * Behaviour that deliberately did not survive the port from the standalone page:
 *
 *   - `alert('Audio Generated')` on success.
 *   - A failed fetch logged to the console and nothing shown to the user, so the
 *     spinner simply vanished and the page looked broken.
 *   - "Inferencing can take upto 5 minutes" -- measured at ~16s, so the message was
 *     off by an order of magnitude and read as a hang.
 *   - Enter submitting the form from inside the textarea, which made it impossible
 *     to type more than one line.
 *   - A textarea disabled until a font was chosen from a dropdown.
 */
import './theme';
import { initNepaliInput } from './nepali-input';
import type { NepaliInput } from './nepali-input';
import { estimateWithQueue, synthesize } from './tts-api';
import type { TtsJobStatus, TtsResult } from './tts-api';
import { RAMPS, drawMatrix } from './viz';

const $ = <T extends Element>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);

const STAGE_LABELS: Record<string, string> = {
  encoding: 'Reading the text',
  synthesizing: 'Generating the mel spectrogram',
  vocoding: 'Synthesising the waveform',
  packaging: 'Packaging the result',
};

let latest: TtsResult | null = null;

class Tts {
  private form: HTMLFormElement;
  private text: NepaliInput | null;
  private busy = false;
  private etaTimer: number | null = null;
  private lastUrl: string | null = null;
  private queueAhead = 0;
  private textLength = 0;

  constructor(form: HTMLFormElement) {
    this.form = form;
    this.text = initNepaliInput({ root: form, textareaId: 'tts-text' });
    form.addEventListener('submit', (event) => void this.onSubmit(event));
  }

  private async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy) return;

    const text = (this.text?.value() ?? '').trim();
    if (!text) {
      this.showError('Enter some Nepali text, or pick one of the examples.');
      this.text?.focus();
      return;
    }

    this.clearError();
    this.setBusy(true);
    this.textLength = text.length;
    this.queueAhead = 0;
    this.tickEta(Date.now());

    try {
      const result = await synthesize(text, (status) => this.onProgress(status));
      this.render(result);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    } finally {
      this.setBusy(false);
    }
  }

  private onProgress(status: TtsJobStatus): void {
    const fill = $<HTMLElement>('[data-progress-fill]', this.form);
    const label = $<HTMLElement>('[data-progress-label]', this.form);

    if (status.status === 'queued') {
      // queue_position counts only waiting jobs, not the running one -- so position N
      // means N jobs to get through, not N-1.
      this.queueAhead = Math.max(1, status.queue_position ?? 1);
      if (label) {
        label.textContent =
          this.queueAhead === 1
            ? 'Queued — one job ahead of you'
            : `Queued — ${this.queueAhead} jobs ahead of you`;
      }
      if (fill) fill.style.width = '4%';
      return;
    }

    this.queueAhead = 0;
    if (fill) fill.style.width = `${Math.max(4, status.progress * 100).toFixed(1)}%`;
    if (label && status.stage) {
      label.textContent = STAGE_LABELS[status.stage] ?? status.stage;
    }
  }

  /**
   * Elapsed against expected. Same rule as the cloning studio: never promise a
   * countdown, and stop quoting a figure once it has been overtaken -- being past
   * your own estimate and saying nothing reads as a hang.
   */
  private tickEta(startedAt: number): void {
    const eta = $<HTMLElement>('[data-progress-eta]', this.form);
    if (!eta) return;
    if (this.etaTimer) window.clearInterval(this.etaTimer);

    const render = () => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const budget = estimateWithQueue(this.textLength, this.queueAhead);
      eta.textContent =
        elapsed > budget * 1.25
          ? `${elapsed}s elapsed · longer than usual`
          : `${elapsed}s elapsed · ~${budget}s expected`;
    };
    render();
    this.etaTimer = window.setInterval(render, 500);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    const button = $<HTMLButtonElement>('[data-synth]', this.form);
    const label = $<HTMLElement>('[data-synth-label]', this.form);
    const progress = $<HTMLElement>('[data-progress]', this.form);
    if (button) button.disabled = busy;
    if (label) label.textContent = busy ? 'Synthesising…' : 'Synthesise';
    if (progress) progress.hidden = !busy;
    if (!busy && this.etaTimer) {
      window.clearInterval(this.etaTimer);
      this.etaTimer = null;
    }
  }

  private showError(message: string): void {
    const node = $<HTMLElement>('[data-error]', this.form);
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
  }

  private clearError(): void {
    const node = $<HTMLElement>('[data-error]', this.form);
    if (node) node.hidden = true;
  }

  private render(result: TtsResult): void {
    const section = $<HTMLElement>('[data-tts-results]');
    const audio = $<HTMLAudioElement>('[data-tts-audio]');
    const download = $<HTMLAnchorElement>('[data-tts-download]');
    const meta = $<HTMLElement>('[data-tts-meta]');

    // Release the previous clip before replacing it, or every synthesis leaks a blob.
    if (this.lastUrl) URL.revokeObjectURL(this.lastUrl);
    this.lastUrl = result.audioUrl;

    if (audio) audio.src = result.audioUrl;
    if (download) {
      download.href = result.audioUrl;
      download.hidden = false;
    }
    if (meta) {
      meta.textContent =
        `${result.duration.toFixed(2)}s · ${(result.sampleRate / 1000).toFixed(2)} kHz · ` +
        `${result.elapsed.toFixed(1)}s round trip`;
    }

    const warning = $<HTMLElement>('[data-tts-truncated]');
    if (warning) warning.hidden = !result.reachedMaxSteps;
    const steps = $<HTMLElement>('[data-tts-steps]');
    if (steps) steps.textContent = `${result.decoderSteps} / ${result.maxDecoderSteps}`;

    latest = result;
    renderTimings(result.timings);

    // Unhide BEFORE drawing. A canvas inside a `hidden` ancestor measures 0x0, so
    // viz.fit() would size its backing store to 1x1 and the single pixel it drew
    // would then be stretched across the element -- a flat wash where the plot
    // should be. The cloning studio has always done it in this order.
    if (section) section.hidden = false;
    redrawPlots(result);

    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function redrawPlots(result: TtsResult): void {
  const mel = $<HTMLCanvasElement>('[data-tts-plot="mel"]');
  if (mel) {
    drawMatrix(mel, result.mel, {
      stops: RAMPS.viridis,
      xLabel: 'Time Steps',
      yLabel: 'Mel Channels',
    });
  }
  const alignment = $<HTMLCanvasElement>('[data-tts-plot="alignment"]');
  if (alignment) {
    // The server already transposes to (encoder, decoder), so decoder time runs along
    // x -- which is how alignment plots are conventionally read.
    drawMatrix(alignment, result.alignment, {
      smooth: false,
      stops: RAMPS.viridis,
      xLabel: 'Decoder Time Steps',
      yLabel: 'Encoder Time Steps',
    });
  }
}

function renderTimings(timings: Record<string, number>): void {
  const list = $<HTMLElement>('[data-tts-timings]');
  if (!list) return;
  const order = ['encoding', 'synthesizer', 'vocoder', 'packaging', 'total'];
  list.innerHTML = order
    .filter((key) => key in timings)
    .map(
      (key) =>
        `<li${key === 'total' ? ' data-total' : ''}><b>${key}</b><span>${timings[key].toFixed(2)}s</span></li>`,
    )
    .join('');
}

const form = $<HTMLFormElement>('[data-tts]');
if (form) new Tts(form);

// The colour ramps read CSS variables, so the plots must be redrawn on a theme flip.
document.addEventListener('themechange', () => {
  if (latest) redrawPlots(latest);
});

let resizeTimer: number | null = null;
window.addEventListener('resize', () => {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (latest) redrawPlots(latest);
  }, 150);
});
