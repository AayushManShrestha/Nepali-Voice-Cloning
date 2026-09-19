# Nepali Voice Cloning — web

Zero-shot neural voice cloning for Nepali. Give it five seconds of someone speaking and
arbitrary Nepali text, and it reads the text back in that voice — without having been
trained on that speaker.

**Live:** [nepali-voice-cloning.vercel.app](https://nepali-voice-cloning.vercel.app)

This repository is the frontend. The model server lives in
[`../server`](https://huggingface.co/spaces/lord-reso/Nepali-Voice-Cloning); a separate
[listening study](https://voice-cloning-mos.vercel.app) measures how close the clones get.

---

## Architecture

Three networks in series — the SV2TTS recipe (Jia et al., 2018), adapted to Nepali:

```
  reference.wav ──▶ ┌───────────────────┐
                    │  Speaker encoder  │  GE2E, 3-layer LSTM
                    │  frozen, zero-shot│
                    └─────────┬─────────┘
                              │ 256-d embedding
                              ▼
  Nepali text ─────▶ ┌───────────────────┐
                     │   Synthesizer     │  Tacotron + location-sensitive attention
                     └─────────┬─────────┘
                               │ 80 × T mel spectrogram
                               ▼
                     ┌───────────────────┐
                     │     Vocoder       │  WaveRNN, autoregressive
                     └─────────┬─────────┘
                               │
                               ▼  16 kHz waveform
```

The speaker encoder is trained for *verification*, not synthesis: it learns to map any
voice to a point in 256-d space where the same person lands in the same place. That
objective generalises to voices it has never heard, which is what makes five seconds of
reference audio sufficient.

## It is a romanised Nepali model

Worth stating plainly, because it is not obvious from the interface. The synthesizer's
vocabulary is 68 ASCII symbols — the stock Tacotron set. The text front-end runs
`unidecode` before embedding lookup, so `नमस्ते` becomes `namaste` and Devanagari never
reaches the network. The Preeti and romanised keyboards in the UI are input aids for the
human, not the model.

Two consequences:

- **Digits are dropped.** `0-9` are not in the symbol set and nothing expands them, so
  `म २०२४ मा` transliterates to `ma 2024 ma` and the number disappears. The UI warns you.
- **Out-of-vocabulary characters vanish silently**, including the danda `।`.

## Stack

Astro 5, static output, TypeScript. The page is mostly static content around one
interactive island, so it ships **no JavaScript** outside the studio — about 7 kB gzipped
including the Nepali keyboard library.

The plots are drawn in the browser on `<canvas>` from raw arrays. The backend used to
render them as matplotlib PNGs: 592 kB per response, 86% of it pictures, and the bulk of
the request latency.

```
src/
  components/   Hero, Pipeline, Studio, Results, Notes, header/footer
  data/         speakers.json — single source of truth for the voice library
  scripts/      studio.ts (island) · viz.ts (canvas) · api.ts (backend client)
  styles/       tokens.css — every colour, both themes
api/warm.js     Vercel Function: daily cron ping, see below
```

### The browser calls the model server directly

Synthesis is **not** proxied through Vercel. A Hobby serverless function caps at 60s and
synthesis can exceed that; the Space already sends `CORS: *`, so the proxy would add a hop
and a failure mode while buying nothing.

### Keeping the Space awake

The Hugging Face Space sleeps after 48 hours idle (`gcTimeout: 172800`), and a cold start
means loading ~490 MB of weights. `api/warm.js` runs once a day on a Vercel cron so a
visitor never pays for that.

## Develop

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # astro check && astro build
npm run preview
```

Deploys automatically from `main`.

## Credit

Architecture after Jia et al., *Transfer Learning from Speaker Verification to
Multispeaker Text-To-Speech Synthesis* (2018), via Corentin Jemine's
[Real-Time-Voice-Cloning](https://github.com/CorentinJ/Real-Time-Voice-Cloning).

Please don't clone anyone's voice without their consent.
