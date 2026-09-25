// Keep the Hugging Face Spaces out of hibernation.
//
// Both Spaces report gcTimeout = 172800, i.e. they sleep after 48h idle. Waking one is
// not just a slow request: the container restarts and reloads its weights, so the first
// visitor after a sleep waits minutes. That is the difference between a demo that works
// when someone opens it and one that looks broken.
//
// Vercel Hobby caps cron *frequency* at once per day but allows two jobs, so this runs
// at 06:00 and 18:00 UTC -- a 12h interval against a 48h timeout. Even if one firing is
// missed or delayed (Hobby crons are best-effort, not to-the-minute), there is still
// 36h of margin.
//
// Both Spaces are pinged from the same invocation rather than from a cron each: two
// jobs is the Hobby ceiling, and spending both on one Space would leave the other
// asleep. They are pinged concurrently so a cold one cannot eat the other's budget.

// /health also reports whether the models finished loading, which distinguishes
// "awake" from "awake but still booting" -- and after a cold start both Spaces spend
// a while in the latter.
const SPACES = [
  { name: 'cloning', url: 'https://lord-reso-nepali-voice-cloning.hf.space/health' },
  { name: 'tts', url: 'https://lord-reso-tts-only.hf.space/health' },
];

async function ping(space) {
  const started = Date.now();
  try {
    const upstream = await fetch(space.url, {
      signal: AbortSignal.timeout(60_000),
      headers: { 'user-agent': 'nepali-voice-cloning-warmup/1.1' },
    });
    const body = await upstream.json().catch(() => null);
    return {
      name: space.name,
      ok: upstream.ok,
      upstreamStatus: upstream.status,
      elapsedMs: Date.now() - started,
      space: body,
    };
  } catch (error) {
    // A cold Space can exceed the timeout while it boots. That is still a successful
    // warm-up -- the request is what wakes it -- so don't report this as a failure.
    return {
      name: space.name,
      ok: false,
      woke: true,
      elapsedMs: Date.now() - started,
      error: String(error?.message ?? error),
    };
  }
}

export default async function handler(request, response) {
  const started = Date.now();
  const results = await Promise.all(SPACES.map(ping));
  return response.status(200).json({
    elapsedMs: Date.now() - started,
    results,
  });
}
