/**
 * Offline, rule-based romanised Nepali -> Devanagari, one word at a time.
 *
 * This is the floor under the IME, not the main engine. Google's transliterator (see
 * transliterate.ts) is far better -- it knows काठमाडौँ, धन्यवाद, that `khana` is खाना --
 * but it is a network call. This runs when that call is slow, fails, or the page is
 * offline, and it is always offered as one candidate, so a user who knows the rules
 * can still spell a word exactly.
 *
 * The scheme is the one most Nepali typists already know from the phonetic unicode
 * converters: a consonant followed by another consonant takes a halant (namaste ->
 * नमस्ते), a word-final consonant keeps its inherent vowel (ghar -> घर, not घर्),
 * `a` is that inherent vowel and `aa` is the matra ा. Double vowels lengthen
 * (ee/ii -> ी, oo/uu -> ू), and `x` is the chat spelling of छ.
 *
 * Input is lowercased first. Capitals are how some schemes spell retroflex consonants
 * (T -> ट), but a casual typist capitalises the first word of a sentence, and turning
 * "Namaste" into णमस्ते is the worse failure.
 */

const HALANT = '्';

/** Longest keys first, so `chh` wins over `ch`, and `ch` over `c`. */
const CONSONANTS: ReadonlyArray<readonly [string, string]> = [
  ['ksh', 'क्ष'],
  ['chh', 'छ'],
  ['shh', 'ष'],
  ['kh', 'ख'], ['gh', 'घ'], ['ch', 'च'], ['jh', 'झ'], ['th', 'थ'], ['dh', 'ध'],
  ['ph', 'फ'], ['bh', 'भ'], ['sh', 'श'], ['gy', 'ज्ञ'], ['tr', 'त्र'],
  ['k', 'क'], ['g', 'ग'], ['c', 'च'], ['j', 'ज'], ['t', 'त'], ['d', 'द'],
  ['n', 'न'], ['p', 'प'], ['f', 'फ'], ['b', 'ब'], ['m', 'म'], ['y', 'य'],
  ['r', 'र'], ['l', 'ल'], ['v', 'व'], ['w', 'व'], ['s', 'स'], ['h', 'ह'],
  ['x', 'छ'], ['q', 'क'], ['z', 'ज'],
];

/** [romanised, independent vowel, matra]. `a` has no matra: it is the inherent vowel. */
const VOWELS: ReadonlyArray<readonly [string, string, string]> = [
  ['aa', 'आ', 'ा'], ['ai', 'ऐ', 'ै'], ['au', 'औ', 'ौ'], ['ou', 'औ', 'ौ'],
  ['ee', 'ई', 'ी'], ['ii', 'ई', 'ी'], ['oo', 'ऊ', 'ू'], ['uu', 'ऊ', 'ू'],
  ['a', 'अ', ''], ['i', 'इ', 'ि'], ['u', 'उ', 'ु'], ['e', 'ए', 'े'], ['o', 'ओ', 'ो'],
];

const match = <T extends readonly [string, ...string[]]>(
  table: ReadonlyArray<T>,
  text: string,
  at: number,
): T | undefined => table.find(([key]) => text.startsWith(key, at));

export function romanToNepali(word: string): string {
  const text = word.toLowerCase();
  let out = '';
  // True while the last thing written is a consonant still carrying its inherent
  // vowel: a following consonant must kill it with a halant, a following vowel
  // replaces it with a matra.
  let bare = false;

  for (let i = 0; i < text.length; ) {
    const vowel = match(VOWELS, text, i);
    if (vowel) {
      const [key, independent, matra] = vowel;
      out += bare ? matra : independent;
      bare = false;
      i += key.length;
      continue;
    }
    const consonant = match(CONSONANTS, text, i);
    if (consonant) {
      const [key, glyph] = consonant;
      out += (bare ? HALANT : '') + glyph;
      bare = true;
      i += key.length;
      continue;
    }
    // Not a letter this scheme knows; pass it through untouched.
    out += text[i];
    bare = false;
    i += 1;
  }
  return out;
}
