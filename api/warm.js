// Keep the Hugging Face Space out of hibernation.
//
// The Space has gcTimeout = 172800 (48h idle), after which the next visitor pays a
// multi-minute cold start -- models alone are ~490 MB. A once-daily ping keeps it
// resident, which is the difference between a demo that works when someone opens it
// and one that appears broken.
//
// Vercel Hobby allows one cron invocation per day; 24h < 48h, so this is sufficient.

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
