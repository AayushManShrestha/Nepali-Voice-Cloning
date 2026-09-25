# Nepali Voice Cloning — web

Zero-shot neural voice cloning for Nepali. Give it five seconds of someone speaking and
arbitrary Nepali text, and it reads the text back in that voice — without having been
trained on that speaker.

**Live:** [nepali-voice-cloning.vercel.app](https://nepali-voice-cloning.vercel.app)

This repository is the whole frontend for the project — three pages against two model
servers, each server its own Hugging Face Space and its own repository.

| Route | What | Backend |
|---|---|---|
| `/` | Zero-shot voice cloning. The demo and write-up. | [`../server`](https://huggingface.co/spaces/lord-reso/Nepali-Voice-Cloning) |
| `/tts` | Nepali text-to-speech, one fixed female voice. | [`../host`](https://huggingface.co/spaces/lord-reso/host) |
| `/mos` | The listening study: 57 raters, 50 clips, scores and caveats. | none, static |

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

## Two models, one site

`/` and `/tts` are different networks on different Spaces, sharing no weights:

| | `/` cloning | `/tts` |
|---|---|---|
| Synthesizer | Tacotron | Tacotron2 |
| Vocoder | WaveRNN, autoregressive | HiFi-GAN, one pass |
| Speaker | zero-shot, from ~5s of reference | one fixed embedding |
| Output | 16 kHz | 22.05 kHz |
| Measured latency | 13–45s, vocoder-bound | ~16s |

What they do share is the text front-end: ASCII symbol set, `unidecode` first, digits
dropped. That is why `nepali-input.ts` is shared and why the same warning appears on both.

## Stack

Astro 5, static output, TypeScript. Each page is static content around at most one
interactive island, and Astro splits per route — so `/mos` ships only the theme toggle,
and `/tts` never loads the cloning studio's canvas renderers.

The plots are drawn in the browser on `<canvas>` from raw arrays. The backend used to
render them as matplotlib PNGs — 592 kB per response, 86% of it pictures. Moving that to
the client cut the response to 68–206 kB and made the visuals interactive; it did *not*
meaningfully change latency, because the autoregressive vocoder accounts for 94–98% of
synthesis time. See the [server README](../server/README.md#performance) for the
measurements.

```
src/
  pages/        index.astro (cloning) · tts.astro (TTS) · mos.astro (study)
  components/   Hero, Pipeline, Studio, Results, Notes, header/footer
    tts/        TtsStudio, TtsResults
    mos/        Scores, Rubric, SpeakerPanel
  data/         speakers.json      — the voice library the cloning studio offers
                mos-speakers.json  — the study's 50-clip manifest
                mos-scores.json    — aggregated ratings, no rater identities
  scripts/      studio.ts · viz.ts · api.ts      — the cloning island
                tts.ts    · tts-api.ts          — the TTS island
                nepali-input.ts — romanised/Preeti entry, shared by both studios
                theme.ts        — the toggle, shared by all three pages
  styles/       tokens.css — every colour, both themes
api/warm.js     Vercel Function: cron ping for both Spaces, see below
```

### One Nepali text input, not two

`nepali-input.ts` owns romanised-as-you-type, the Preeti layout, the key map and the
digit warning. Both studios import it, and it builds as a shared chunk (~1.9 kB
gzipped) rather than shipping twice.

It exists because the TTS page used to be a separate project that solved the same
problem again with a CDN `<script>` tag and a partly-wired writenepali.com embed —
which had drifted far enough to ship two elements with the same `id`. Merging the two
frontends is what made one implementation possible.

> **The hooks are a contract.** `[data-mode]`, `[data-count]`, `[data-digit-warning]`,
> `[data-roman-hint]`, `[data-keyhelp]`, `[data-keyboard-toggle]`, `[data-preeti-map]`
> and `[data-preset]` are queried by that module. Rename one in a component and it
> silently stops working in both studios.

### The TTS backend contract lives in one file

`tts-api.ts` is the only thing that knows the TTS Space's wire format. That Space still
returns server-rendered PNGs — about 29% of a 705 KB response — where the cloning Space
returns raw arrays for the browser to draw. It is being reworked separately; when its
contract changes, `tts-api.ts` changes and `tts.ts` should not have to.

### The listening study

`/mos` was its own repository and its own Vercel project until it was folded in here.
The split cost two deploys and a duplicated design system —
`Base.astro`, `global.css` and `favicon.svg` were byte-identical in both — and buried
the one page that answers "but how good is it actually" behind a footer link on another
origin.

It ships **no JavaScript** beyond the shared theme toggle: 0.25 kB gzipped against the
studio's 9.4 kB. The bar and distribution charts are CSS, and all 50 players are
`preload="none"`, so none of the 7.7 MB of audio loads until someone presses play.

### The browser calls the model server directly

Synthesis is **not** proxied through Vercel. A Hobby serverless function caps at 60s and
synthesis can exceed that; the Space already sends `CORS: *`, so the proxy would add a hop
and a failure mode while buying nothing.

### Keeping both Spaces awake

Each Space sleeps after 48 hours idle (`gcTimeout: 172800`), and a cold start means
reloading its weights. `api/warm.js` pings both from a single invocation, concurrently,
at 06:00 and 18:00 UTC.

Both from one function on purpose: Vercel Hobby allows two cron jobs and caps frequency
at one a day, so spending a job per Space would leave no margin for a missed firing.
Two firings against a 48h timeout leaves 36h of slack even if one is skipped.

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
