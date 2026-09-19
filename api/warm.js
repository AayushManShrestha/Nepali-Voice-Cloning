// Keep the Hugging Face Space out of hibernation.
//
// The Space reports gcTimeout = 172800, i.e. it sleeps after 48h idle. Waking it is
// not just a slow request: the container restarts and reloads ~490 MB of weights, so
// the first visitor after a sleep waits minutes. That is the difference between a demo
// that works when someone opens it and one that looks broken.
//
// Vercel Hobby caps cron *frequency* at once per day but allows two jobs, so this runs
// at 06:00 and 18:00 UTC -- a 12h interval against a 48h timeout. Even if one firing is
// missed or delayed (Hobby crons are best-effort, not to-the-minute), there is still
// 36h of margin.
//
// /health is used rather than / because it also reports whether the models finished
// loading, which distinguishes "awake" from "awake but still booting".

const SPACE = 'https://lord-reso-nepali-voice-cloning.hf.space';

export default async function handler(request, response) {
  const started = Date.now();
  try {
    const upstream = await fetch(`${SPACE}/health`, {
      signal: AbortSignal.timeout(60_000),
      headers: { 'user-agent': 'nepali-voice-cloning-warmup/1.0' },
    });
    const body = await upstream.json().catch(() => null);
    return response.status(200).json({
      ok: upstream.ok,
      upstreamStatus: upstream.status,
      elapsedMs: Date.now() - started,
      space: body,
    });
  } catch (error) {
    // A cold Space can exceed the timeout while it boots. That is still a successful
    // warm-up -- the request is what wakes it -- so don't report this as a failure.
    return response.status(200).json({
      ok: false,
      woke: true,
      elapsedMs: Date.now() - started,
      error: String(error?.message ?? error),
    });
  }
}
