/**
 * Candidate Devanagari spellings for one romanised word.
 *
 * The source is Google Input Tools' transliteration endpoint (`ne-t-i0-und`), the same
 * engine family behind Gboard's Nepali keyboard. It is the reason this file exists:
 * the old input mapped one key to one glyph, so `namaste` came out as नामासते, while
 * this returns नमस्ते, काठमाडौँ for `kathmandu` and धन्यवाद for `dhanyabad`. Its first
 * guess is not always right (`aama` -> आम before आमा), which is why the IME shows a
 * list rather than silently taking the top one.
 *
 * It is an undocumented endpoint with no SLA. It answers CORS from any origin, so the
 * browser calls it directly; nothing here depends on it being up. When it fails, the
 * rule-based spelling from roman-nepali.ts is still a candidate, and the IME commits it.
 *
 * Two pieces of state, both per-viewer:
 * - an in-memory cache, so each word costs one request however often it is typed;
 * - the viewer's own picks in localStorage. Choose म over मा for `ma` once and म
 *   comes first from then on. Storage can be missing or throw (private windows, blocked
 *   site data), and every access is wrapped so the IME works the same without it.
 */
import { romanToNepali } from './roman-nepali';

const ENDPOINT = 'https://inputtools.google.com/request';
const PICKS_KEY = 'nepali-ime:picks';
const MAX_PICKS = 400;
const MAX_CACHE = 600;
const TIMEOUT_MS = 4000;

/**
 * Lowercased, with `x` spelled out. Google reads `NAMASTE` as an acronym and `xa` as
 * क्ष, but a Nepali typist means नमस्ते and छ -- `x` for छ is near-universal in chat.
 */
export const normalise = (word: string): string => word.toLowerCase().replace(/x/g, 'chh');

const cache = new Map<string, Promise<string[]>>();
const settled = new Map<string, string[]>();

async function request(query: string): Promise<string[]> {
  const params = new URLSearchParams({
    text: query,
    itc: 'ne-t-i0-und',
    num: '6',
    cp: '0',
    cs: '1',
    ie: 'utf-8',
    oe: 'utf-8',
    app: 'demopage',
  });
  const response = await fetch(`${ENDPOINT}?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`transliteration HTTP ${response.status}`);
  // ["SUCCESS", [[query, [candidate, ...], [], {...}]]]
  const body: unknown = await response.json();
  if (!Array.isArray(body) || body[0] !== 'SUCCESS') throw new Error('transliteration failed');
  const candidates = (body as any)[1]?.[0]?.[1];
  if (!Array.isArray(candidates)) throw new Error('transliteration: unexpected shape');
  return candidates.filter((c): c is string => typeof c === 'string' && c.length > 0 && !NOT_NEPALI.test(c));
}

/**
 * Spellings the engine offers that Nepali never uses: nukta forms (आम़ा, ऱ, ऩ), which
 * are Hindi/Urdu orthography, and a doubled अ (अअमा for `aama`). They only push real
 * candidates down the list.
 */
const NOT_NEPALI = /[़ऩऱऴक़-य़]|अअ/;

/** Google's candidates for a word; rejects when the service is unreachable. */
export function fetchCandidates(word: string): Promise<string[]> {
  const query = normalise(word);
  const hit = cache.get(query);
  if (hit) return hit;

  const pending = request(query).then(
    (candidates) => {
      settled.set(query, candidates);
      return candidates;
    },
    (error) => {
      // Forget failures, so the next keystroke retries rather than replaying them.
      cache.delete(query);
      throw error;
    },
  );
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
      settled.delete(oldest);
    }
  }
  cache.set(query, pending);
  return pending;
}

/** Google's candidates if they have already arrived, without waiting. */
export const cachedCandidates = (word: string): string[] | undefined =>
  settled.get(normalise(word));

function readPicks(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PICKS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let picks: Record<string, string> | null = null;

/** Record that the viewer chose `choice` for `word`, so it ranks first next time. */
export function rememberPick(word: string, choice: string): void {
  picks ??= readPicks();
  const key = normalise(word);
  delete picks[key]; // re-insert, so the key order doubles as recency
  picks[key] = choice;
  const keys = Object.keys(picks);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PICKS))) delete picks[old];
  try {
    localStorage.setItem(PICKS_KEY, JSON.stringify(picks));
  } catch {
    /* storage unavailable: the pick still holds for this page view */
  }
}

/**
 * The list the IME shows, best first: the viewer's earlier pick, then Google's
 * candidates (when known), then the rule-based spelling. Never empty.
 */
export function rankCandidates(word: string, google: string[] | undefined): string[] {
  picks ??= readPicks();
  const ordered = [picks[normalise(word)], ...(google ?? []), romanToNepali(normalise(word))];
  return [...new Set(ordered.filter((c): c is string => !!c))];
}
