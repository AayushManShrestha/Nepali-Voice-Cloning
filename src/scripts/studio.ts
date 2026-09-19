/**
 * The one interactive island on the page.
 *
 * Everything else is static HTML; this hydrates the reference picker, the Nepali
 * input, the synthesis call, and the canvas plots.
 */
import nepalify from 'nepalify';
import { checkHealth, estimateWithQueue, synthesize, STAGES } from './api';
import type { JobStatus, SynthesisResult } from './api';
import {
  RAMPS,
  base64ToBytes,
  embeddingCellAt,
  computePeaks,
  decodeAudio,
  drawEmbedding,
  drawMatrix,
  drawWaveform,
} from './viz';

type Source = 'library' | 'record' | 'upload';

const $ = <T extends Element>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);
const $$ = <T extends Element>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));

/* --------------------------------------------------------------------------
   Theme
   -------------------------------------------------------------------------- */
function initTheme(): void {
  const button = $<HTMLButtonElement>('[data-theme-toggle]');
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

/* --------------------------------------------------------------------------
   Backend status
   -------------------------------------------------------------------------- */
function initStatus(): void {
  const dot = $<HTMLElement>('[data-backend-status] .dot');
  const label = $<HTMLElement>('[data-backend-label]');
  if (!dot || !label) return;

  const set = (state: string, text: string) => {
    dot.dataset.state = state;
    label.textContent = text;
  };

  void (async () => {
    const health = await checkHealth();
    if (health?.models_loaded) {
      set('ready', health.queue_depth > 0 ? `queue ${health.queue_depth}` : 'model server ready');
      return;
    }
    // Either asleep or still loading. The probe above already started waking it.
    set('waking', 'waking model server');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((r) => setTimeout(r, 6000));
      const again = await checkHealth();
      if (again?.models_loaded) {
        set('ready', 'model server ready');
        return;
      }
    }
    set('down', 'model server unreachable');
  })();
}

/* --------------------------------------------------------------------------
   Studio
   -------------------------------------------------------------------------- */
class Studio {
  private form: HTMLFormElement;
  private source: Source = 'library';
  private recordedBlob: Blob | null = null;
  private uploadedFile: File | null = null;
  private recorder: MediaRecorder | null = null;
  private recordTimer: number | null = null;
  private previewAudio = new Audio();
  private interceptors = new Map<string, ReturnType<typeof nepalify.interceptElementById>>();
  private busy = false;

  constructor(form: HTMLFormElement) {
    this.form = form;
    this.initTabs();
    this.initPreviews();
    this.initRecorder();
    this.initUpload();
    this.initText();
    this.form.addEventListener('submit', (e) => this.onSubmit(e));
  }

  /* --- tabs ------------------------------------------------------------- */
  private initTabs(): void {
    const tabs = $$<HTMLButtonElement>('[data-tab]', this.form);
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => this.selectTab(tab.dataset.tab as Source));
      tab.addEventListener('keydown', (event) => {
        const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!delta) return;
        event.preventDefault();
        const next = tabs[(tabs.indexOf(tab) + delta + tabs.length) % tabs.length];
        next.focus();
        this.selectTab(next.dataset.tab as Source);
      });
    });
  }

  private selectTab(which: Source): void {
    this.source = which;
    $$<HTMLButtonElement>('[data-tab]', this.form).forEach((tab) => {
      const on = tab.dataset.tab === which;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    $$<HTMLElement>('[data-panel]', this.form).forEach((panel) => {
      panel.hidden = panel.dataset.panel !== which;
    });
  }

  /* --- library previews -------------------------------------------------- */
  private initPreviews(): void {
    $$<HTMLButtonElement>('[data-preview]', this.form).forEach((button) => {
      button.addEventListener('click', () => {
        const src = button.dataset.preview!;
        const wasPlaying = button.hasAttribute('data-playing');
        this.previewAudio.pause();
        $$('[data-preview]', this.form).forEach((b) => b.removeAttribute('data-playing'));
        if (wasPlaying) return;
        this.previewAudio.src = src;
        void this.previewAudio.play();
        button.setAttribute('data-playing', '');
        this.previewAudio.onended = () => button.removeAttribute('data-playing');
      });
    });
  }

  /* --- recorder ---------------------------------------------------------- */
  private initRecorder(): void {
    const button = $<HTMLButtonElement>('[data-record]', this.form);
    const label = $<HTMLElement>('[data-record-label]', this.form);
    const timer = $<HTMLElement>('[data-record-timer]', this.form);
    const player = $<HTMLAudioElement>('[data-recorded-player]', this.form);
    if (!button || !label || !timer || !player) return;

    const stop = () => {
      if (this.recorder?.state === 'recording') this.recorder.stop();
      if (this.recordTimer) {
        window.clearInterval(this.recordTimer);
        this.recordTimer = null;
      }
      button.removeAttribute('data-active');
      label.textContent = 'Record again';
    };

    button.addEventListener('click', async () => {
      if (this.recorder?.state === 'recording') {
        stop();
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks: Blob[] = [];
        this.recorder = new MediaRecorder(stream);
        this.recorder.ondataavailable = (e) => chunks.push(e.data);
        this.recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          this.recordedBlob = new Blob(chunks, { type: this.recorder!.mimeType });
          player.src = URL.createObjectURL(this.recordedBlob);
          player.hidden = false;
        };
        this.recorder.start();

        button.setAttribute('data-active', '');
        label.textContent = 'Stop';
        let elapsed = 0;
        timer.textContent = '0.0s';
        this.recordTimer = window.setInterval(() => {
          elapsed += 0.1;
          timer.textContent = `${elapsed.toFixed(1)}s`;
          if (elapsed >= 10) stop();
        }, 100);
      } catch {
        this.showError('Microphone access was refused, so recording is unavailable.');
      }
    });
  }

  /* --- upload ------------------------------------------------------------ */
  private initUpload(): void {
    const input = $<HTMLInputElement>('[data-file]', this.form);
    const drop = $<HTMLElement>('[data-drop]', this.form);
    const label = $<HTMLElement>('[data-file-label]', this.form);
    const player = $<HTMLAudioElement>('[data-upload-player]', this.form);
    if (!input || !drop || !label || !player) return;

    const accept = (file: File | undefined) => {
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) {
        this.showError(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB; the limit is 8 MB.`);
        return;
      }
      this.uploadedFile = file;
      label.textContent = file.name;
      player.src = URL.createObjectURL(file);
      player.hidden = false;
      this.clearError();
    };

    input.addEventListener('change', () => accept(input.files?.[0]));
    ['dragenter', 'dragover'].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.setAttribute('data-over', '');
      }),
    );
    ['dragleave', 'drop'].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.removeAttribute('data-over');
      }),
    );
    drop.addEventListener('drop', (e) => accept((e as DragEvent).dataTransfer?.files?.[0]));
  }

  /* --- Nepali text ------------------------------------------------------- */
  private initText(): void {
    const textarea = $<HTMLTextAreaElement>('[data-text]', this.form);
    const count = $<HTMLElement>('[data-count]', this.form);
    const warning = $<HTMLElement>('[data-digit-warning]', this.form);
    const romanHint = $<HTMLElement>('[data-roman-hint]', this.form);
    if (!textarea || !count) return;

    // nepalify intercepts keypress per layout. Build both up-front and toggle.
    for (const layout of ['romanized', 'traditional'] as const) {
      this.interceptors.set(layout, nepalify.interceptElementById('text', { layout, enable: false }));
    }

    const setMode = (mode: string) => {
      this.interceptors.forEach((i) => i.disable());
      if (mode === 'romanized') this.interceptors.get('romanized')?.enable();
      if (mode === 'preeti') this.interceptors.get('traditional')?.enable();
      if (romanHint) romanHint.hidden = mode !== 'romanized';
      const keyhelp = $<HTMLElement>('[data-keyhelp]', this.form);
      if (keyhelp) keyhelp.hidden = mode !== 'preeti';
      $$<HTMLButtonElement>('[data-mode]', this.form).forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.mode === mode)),
      );
    };

    $$<HTMLButtonElement>('[data-mode]', this.form).forEach((button) =>
      button.addEventListener('click', () => setMode(button.dataset.mode!)),
    );
    setMode('romanized');

    const sync = () => {
      count.textContent = String(textarea.value.length);
      if (warning) {
        // Devanagari and ASCII digits alike are absent from the model's symbol set.
        warning.hidden = !/[0-9०-९]/.test(textarea.value);
      }
    };
    textarea.addEventListener('input', sync);

    const keyToggle = $<HTMLButtonElement>('[data-keyboard-toggle]', this.form);
    const keyFigure = $<HTMLElement>('#preeti-map', this.form);
    keyToggle?.addEventListener('click', () => {
      const open = keyFigure?.hidden ?? true;
      if (keyFigure) keyFigure.hidden = !open;
      keyToggle.setAttribute('aria-expanded', String(open));
      keyToggle.textContent = open ? 'Hide the Preeti key map' : 'Show the Preeti key map';
    });

    $$<HTMLButtonElement>('[data-preset]', this.form).forEach((button) =>
      button.addEventListener('click', () => {
        textarea.value = button.dataset.preset!;
        sync();
        textarea.focus();
      }),
    );
    sync();
  }

  /* --- reference resolution ---------------------------------------------- */
  private async referenceBytes(): Promise<{ bytes: ArrayBuffer; label: string }> {
    if (this.source === 'library') {
      const checked = $<HTMLInputElement>('input[name="speaker"]:checked', this.form);
      if (!checked) throw new Error('Choose a voice from the library first.');
      const response = await fetch(checked.dataset.src!);
      if (!response.ok) throw new Error('Could not load that reference clip.');
      const label = checked.closest('li')?.querySelector('.vname')?.textContent ?? 'Library voice';
      return { bytes: await response.arrayBuffer(), label };
    }
    if (this.source === 'record') {
      if (!this.recordedBlob) throw new Error('Record a clip first, or pick one from the library.');
      return { bytes: await this.recordedBlob.arrayBuffer(), label: 'Your recording' };
    }
    if (!this.uploadedFile) throw new Error('Choose an audio file first, or pick one from the library.');
    return { bytes: await this.uploadedFile.arrayBuffer(), label: this.uploadedFile.name };
  }

  /* --- submit ------------------------------------------------------------ */
  private async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy) return;

    const textarea = $<HTMLTextAreaElement>('[data-text]', this.form)!;
    const text = textarea.value.trim();
    if (!text) {
      this.showError('Enter some Nepali text, or pick one of the examples.');
      textarea.focus();
      return;
    }

    this.clearError();
    this.setBusy(true);

    try {
      const { bytes, label } = await this.referenceBytes();
      const base64 = btoa(
        Array.from(new Uint8Array(bytes), (b) => String.fromCharCode(b)).join(''),
      );

      this.textLength = text.length;
      this.queueAhead = 0;
      this.queuedForMs = 0;
      this.queuedAt = null;
      this.tickEta(Date.now());

      const result = await synthesize(text, base64, (status) => this.onProgress(status), undefined, true);
      await this.render(result, bytes, label);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showError(message);
      this.resetPipeline();
    } finally {
      this.setBusy(false);
    }
  }

  private etaTimer: number | null = null;
  private queueAhead = 0;
  private textLength = 0;
  private queuedForMs = 0;
  private queuedAt: number | null = null;

  /**
   * Show elapsed time against the expected duration.
   *
   * Two things this deliberately does NOT do: promise a countdown (the estimate is a
   * fit, not a guarantee), and keep quoting a stale figure once it has been exceeded.
   * Being overtaken by your own estimate and saying nothing reads as a hang.
   */
  private tickEta(startedAt: number): void {
    const eta = $<HTMLElement>('[data-progress-eta]');
    if (!eta) return;
    if (this.etaTimer) window.clearInterval(this.etaTimer);

    const render = () => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      // Recomputed every tick, so the figure tracks the queue draining ahead of you.
      // Time already spent queued stays in the budget once we start running -- elapsed
      // counts from submit, so dropping it would make every queued job look overdue.
      const budget =
        Math.round(this.queuedForMs / 1000) +
        estimateWithQueue(this.textLength, this.queueAhead);
      if (elapsed > budget * 1.25) {
        eta.textContent = `${elapsed}s elapsed · longer than usual`;
      } else {
        eta.textContent = `${elapsed}s elapsed · ~${budget}s expected`;
      }
    };
    render();
    this.etaTimer = window.setInterval(render, 500);
  }

  private onProgress(status: JobStatus): void {
    const fill = $<HTMLElement>('[data-progress-fill]');
    const label = $<HTMLElement>('[data-progress-label]');

    if (status.status === 'queued') {
      // The server's queue_position counts only *waiting* jobs, not the one currently
      // running. But being queued at all means something is ahead of us -- otherwise we
      // would be running. So position N means N jobs to get through, not N-1.
      this.queueAhead = Math.max(1, status.queue_position ?? 1);
      if (label) {
        label.textContent =
          this.queueAhead === 1
            ? 'Queued — one job ahead of you'
            : `Queued — ${this.queueAhead} jobs ahead of you`;
      }
      if (fill) fill.style.width = '4%';
      this.queuedAt ??= Date.now();
      return;
    }
    // First non-queued update: bank however long we actually waited.
    if (this.queuedAt !== null) {
      this.queuedForMs = Date.now() - this.queuedAt;
      this.queuedAt = null;
    }
    this.queueAhead = 0;

    if (fill) fill.style.width = `${Math.max(4, status.progress * 100).toFixed(1)}%`;
    if (label && status.stage) {
      const pretty: Record<string, string> = {
        decoding: 'Reading the reference clip',
        encoding: 'Extracting the speaker embedding',
        synthesizing: 'Generating the mel spectrogram',
        vocoding: 'Synthesising the waveform',
        packaging: 'Packaging the result',
      };
      label.textContent = pretty[status.stage] ?? status.stage;
    }
    this.lightPipeline(status.stage);
  }

  /** Mirror the backend's stage onto the architecture diagram. */
  private lightPipeline(stage: string | null): void {
    const order = STAGES as readonly string[];
    const current = stage ? order.indexOf(stage) : -1;
    $$<HTMLElement>('[data-pipeline] .stage').forEach((node) => {
      const own = order.indexOf(node.dataset.stage!);
      node.toggleAttribute('data-active', own === current);
      node.toggleAttribute('data-done', current > own && current !== -1);
    });
  }

  private resetPipeline(): void {
    $$<HTMLElement>('[data-pipeline] .stage').forEach((node) => {
      node.removeAttribute('data-active');
      node.removeAttribute('data-done');
    });
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    const button = $<HTMLButtonElement>('[data-synth]');
    const label = $<HTMLElement>('[data-synth-label]');
    const progress = $<HTMLElement>('[data-progress]');
    if (button) button.disabled = busy;
    if (label) label.textContent = busy ? 'Synthesising…' : 'Synthesise';
    if (progress) progress.hidden = !busy;
    if (!busy && this.etaTimer) {
      window.clearInterval(this.etaTimer);
      this.etaTimer = null;
    }
  }

  private showError(message: string): void {
    const node = $<HTMLElement>('[data-error]');
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
  }

  private clearError(): void {
    const node = $<HTMLElement>('[data-error]');
    if (node) node.hidden = true;
  }

  /* --- rendering ---------------------------------------------------------- */
  private async render(
    result: SynthesisResult,
    referenceBytes: ArrayBuffer,
    referenceLabel: string,
  ): Promise<void> {
    const section = $<HTMLElement>('[data-results]');
    if (section) section.hidden = false;
    this.lightPipeline(null);
    $$<HTMLElement>('[data-pipeline] .stage').forEach((n) => n.setAttribute('data-done', ''));

    const clonedBytes = base64ToBytes(result.audio);
    await Promise.all([
      mountPlayer('reference', referenceBytes, referenceLabel, 'reference.wav'),
      mountPlayer(
        'cloned',
        clonedBytes.buffer as ArrayBuffer,
        `${result.duration}s · ${result.sample_rate} Hz`,
        'cloned.wav',
      ),
    ]);

    redrawPlots(result);
    renderTimings(result.timings);
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* --------------------------------------------------------------------------
   Players and plots (module scope so theme changes can re-run them)
   -------------------------------------------------------------------------- */
let latest: SynthesisResult | null = null;
let showEmbedValues = false;
const peakCache = new Map<string, { peaks: Float32Array; duration: number }>();
const objectUrls = new Map<string, string>();

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

async function mountPlayer(
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

/**
 * Cosine similarity between the reference and re-extracted embeddings, returned with
 * its intermediate terms so the page can show the working rather than just a number.
 */
function cosine(a: number[], b: number[]): {
  value: number;
  dot: number;
  normA: number;
  normB: number;
} {
  let dot = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    sa += a[i] * a[i];
    sb += b[i] * b[i];
  }
  const normA = Math.sqrt(sa);
  const normB = Math.sqrt(sb);
  return { value: dot / (normA * normB || 1), dot, normA, normB };
}

/** Hovered embedding dimension, mirrored across both grids. */
let hoveredCell: number | null = null;

function wireEmbeddingHover(): void {
  const readout = $<HTMLElement>('[data-embed-readout]');
  for (const which of ['original', 'cloned'] as const) {
    const canvas = $<HTMLCanvasElement>(`[data-plot="embedding-${which}"]`);
    if (!canvas) continue;
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('mousemove', (event) => {
      const hit = embeddingCellAt(canvas, event.clientX, event.clientY);
      const next = hit ? hit.index : null;
      if (next === hoveredCell) return;
      hoveredCell = next;
      if (readout && latest) {
        if (hit) {
          const o = latest.embedding[hit.index];
          const c = (latest.cloned_embedding ?? latest.embedding)[hit.index];
          readout.textContent =
            `dim ${hit.index} (row ${hit.row}, col ${hit.col}) · ` +
            `original ${o.toFixed(3)} · cloned ${c.toFixed(3)} · Δ ${(c - o).toFixed(3)}`;
        } else {
          readout.textContent = '';
        }
      }
      if (latest) redrawPlots(latest);
    });
    canvas.addEventListener('mouseleave', () => {
      hoveredCell = null;
      if (readout) readout.textContent = '';
      if (latest) redrawPlots(latest);
    });
  }
}

function redrawPlots(result: SynthesisResult): void {
  latest = result;

  const melOriginal = $<HTMLCanvasElement>('[data-plot="mel-original"]');
  const melCloned = $<HTMLCanvasElement>('[data-plot="mel-cloned"]');
  const alignment = $<HTMLCanvasElement>('[data-plot="alignment"]');
  const embedOriginal = $<HTMLCanvasElement>('[data-plot="embedding-original"]');
  const embedCloned = $<HTMLCanvasElement>('[data-plot="embedding-cloned"]');

  const melAxes = { xLabel: 'Time Steps', yLabel: 'Mel Channels', stops: RAMPS.magma };
  if (melOriginal && result.reference_mel) drawMatrix(melOriginal, result.reference_mel, melAxes);
  if (melCloned) drawMatrix(melCloned, result.mel, melAxes);

  if (alignment) {
    // The array is (decoder steps, encoder steps). Transpose so decoder time runs
    // along x, which is how alignment plots are conventionally read.
    drawMatrix(alignment, result.alignment, {
      transpose: true,
      flipY: true,
      smooth: false,
      stops: RAMPS.viridis,
      xLabel: 'Decoder Time Steps',
      yLabel: 'Encoder Time Steps',
    });
  }

  const embedOpts = { showValues: showEmbedValues, highlight: hoveredCell };
  if (embedOriginal) drawEmbedding(embedOriginal, result.embedding, embedOpts);
  if (embedCloned) {
    drawEmbedding(embedCloned, result.cloned_embedding ?? result.embedding, embedOpts);
  }

  const cosBox = $<HTMLElement>('[data-cosine]');
  if (cosBox) {
    if (result.cloned_embedding) {
      const { value, dot, normA, normB } = cosine(result.embedding, result.cloned_embedding);
      const set = (sel: string, text: string) => {
        const node = $<HTMLElement>(sel);
        if (node) node.textContent = text;
      };
      set('[data-cos-dot]', dot.toFixed(3));
      set('[data-cos-na]', normA.toFixed(3));
      set('[data-cos-nb]', normB.toFixed(3));
      set('[data-cos-value]', value.toFixed(3));
      cosBox.hidden = false;
    } else {
      cosBox.hidden = true;
    }
  }

  for (const [which, { peaks, duration }] of peakCache) {
    const canvas = $<HTMLCanvasElement>(`[data-wave="${which}"]`);
    const audio = $<HTMLAudioElement>(`[data-audio="${which}"]`);
    if (!canvas) continue;
    drawWaveform(canvas, peaks, {
      duration,
      playhead: audio && !audio.paused ? audio.currentTime / (audio.duration || 1) : -1,
    });
  }
}

function renderTimings(timings: Record<string, number>): void {
  const list = $<HTMLElement>('[data-timings]');
  if (!list) return;
  const order = ['decode', 'encoder', 'synthesizer', 'vocoder', 'packaging', 'total'];
  list.innerHTML = order
    .filter((key) => key in timings)
    .map(
      (key) =>
        `<li${key === 'total' ? ' data-total' : ''}><b>${key}</b><span>${timings[key].toFixed(2)}s</span></li>`,
    )
    .join('');
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */
initTheme();
initStatus();

const form = $<HTMLFormElement>('[data-studio]');
if (form) new Studio(form);

// The colour ramps read CSS variables, so the plots must be redrawn when the theme
// flips. Registered once, against whatever the most recent result is.
document.addEventListener('themechange', () => {
  if (latest) redrawPlots(latest);
});

wireEmbeddingHover();

const embedToggle = $<HTMLInputElement>('[data-embed-values]');
embedToggle?.addEventListener('change', () => {
  showEmbedValues = embedToggle.checked;
  if (latest) redrawPlots(latest);
});

let resizeTimer: number | null = null;
window.addEventListener('resize', () => {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (latest) redrawPlots(latest);
  }, 150);
});
