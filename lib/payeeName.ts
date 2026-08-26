// Turning a bank descriptor into the name Dan actually uses.
//
// He has 18 rows categorized under `Starbucks`; Chase sends
// `STARBUCKS 8007827282 800-782-728`. lib/payeeMemory.ts keys on the exact
// payee string, so it never matched and every import landed uncategorized.
//
// This only ever SUGGESTS (his decision, 2026-08-25): nothing is merged
// without him confirming, because a plausible-looking auto-merge would
// eventually fold his `Hyatt Regency Greenwich` into a Grand Hyatt in San
// Diego. A wrong suggestion costs one correction and is never repeated,
// because the alias it writes is keyed on the exact raw string.
//
// Pure — no I/O, no clock, relative imports only.

/** Letters and digits only, lowercased — so `WAL-MART` and `Walmart` meet. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Noise that trails a merchant name in a card descriptor. */
const NOISE = new Set([
  'llc', 'inc', 'co', 'com', 'corp', 'ltd',
  // US state codes — a descriptor almost always ends in one.
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
  'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
  'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
  'va','wa','wv','wi','wy',
])

function isNoiseWord(w: string): boolean {
  const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (bare === '') return true
  if (/\d/.test(bare)) return true          // store numbers, phone numbers
  return NOISE.has(bare)
}

function titleCase(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
}

/**
 * Clean a raw descriptor into something readable: drop a leading processor
 * prefix (`TST*`), keep words until the first noise word, title-case them,
 * and cap at TWO words so a long location tail cannot ride along.
 */
function cleanRaw(raw: string): string {
  const stripped = raw.replace(/^[A-Z]{2,4}\*/i, '').replace(/\*/g, ' ')
  const words = stripped.split(/\s+/).filter((w) => w !== '')
  const kept: string[] = []
  for (const w of words) {
    if (isNoiseWord(w)) break
    kept.push(titleCase(w.replace(/[^A-Za-z0-9&'-]/g, '')))
    // TWO words, not three: 'GRAND HYATT SAN DIEGO F SAN DIEG' has no noise
    // word to stop at, and three would keep the stray 'San'.
    if (kept.length === 2) break
  }
  const out = kept.join(' ').trim()
  return out === '' ? raw.trim() : out
}

/**
 * The name to suggest for `raw`.
 *
 * A known payee wins whenever its squashed form appears inside the squashed
 * raw string — that is what makes his existing `Starbucks` (and its 18
 * categorized rows) start paying off. The LONGEST such match wins, so
 * `Uber Eats` is never collapsed into `Uber`. With no match it falls back to
 * a cleaned form of the raw string; the result is never empty.
 */
export function suggestDisplayName(raw: string, knownPayees: string[]): string {
  const hay = squash(raw)
  let best = ''
  if (hay !== '') {
    for (const known of knownPayees) {
      const needle = squash(known)
      if (needle === '' || !hay.includes(needle)) continue
      if (needle.length > squash(best).length) best = known
    }
  }
  if (best !== '') return best
  const cleaned = cleanRaw(raw)
  return cleaned.trim() === '' ? 'Unknown payee' : cleaned
}
