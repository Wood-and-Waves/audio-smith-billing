// What a receipt is called once it leaves the app.
//
// In Supabase a receipt is {stamp}-original.jpg, which is right for a key and
// useless in a folder. The archive exists to be readable years later with no
// database in front of you, so the name carries the three things that identify
// a receipt: when, who, how much.
//
// Pure: no clock, no filesystem. The awkward cases are real ones — a vendor OCR
// could not read, a hire company with a slash in its name, and two $6 coffees
// at the same airport Starbucks on the same day.

export type ArchiveEntry = {
  spentOn: string
  vendor: string | null
  amountCents: number
  /** The storage key, read only for its extension. */
  originalPath: string
}

/**
 * Windows and macOS both refuse the ASCII set, and a slash would escape the
 * folder. The Unicode ranges are format/bidi characters, not visible glyphs:
 * U+200B-U+200F (zero-width space and friends) render nothing, and
 * U+202A-U+202E / U+2066-U+2069 (bidi overrides/isolates) can flip how the
 * rest of the name displays — U+202E is the classic "malware.exe" ->
 * "malwarexe.e" filename-spoofing trick. U+FEFF is a byte-order mark that
 * behaves the same as a zero-width space outside position zero.
 */
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Long enough to stay readable, short enough that no filesystem objects. */
const MAX_SEGMENT = 80

/**
 * `.slice(0, MAX_SEGMENT)` cuts by UTF-16 code unit, which can land exactly
 * between a surrogate pair (e.g. 79 ASCII characters followed by an emoji).
 * A lone high surrogate left at the end isn't a real character — encoders
 * disagree about what to do with it, and `Buffer.from(str, 'utf8')` silently
 * rewrites it to U+FFFD, corrupting the name instead of erroring.
 */
function dropTrailingUnpairedSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s
}

/**
 * A single path segment, safe to use as a file or folder name.
 *
 * `fallback` is used when nothing legible survives — an empty vendor, or a name
 * made entirely of illegal characters. Returning '' would produce a path with an
 * empty segment, which reads as the parent directory.
 */
export function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = dropTrailingUnpairedSurrogate(
    raw
      .replace(ILLEGAL, ' ')
      .replace(/\.+/g, ' ')       // '..' is the traversal case, and a trailing dot is illegal on Windows
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SEGMENT),
  ).trim()
  return cleaned === '' ? fallback : cleaned
}

/** jpg or pdf — taken from the stored key, never guessed. */
function extensionOf(originalPath: string): string {
  const dot = originalPath.lastIndexOf('.')
  if (dot === -1) return 'jpg'
  const ext = originalPath.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '')
  return ext === '' ? 'jpg' : ext
}

/** Cents as plain decimal — no currency symbol, which is illegal on some systems. */
function amountOf(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(cents))
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * A name per entry, in the same order, every one unique.
 *
 * Uniqueness is positional rather than content-based: two genuinely different
 * receipts can share a vendor, a day and an amount, and the archive must keep
 * both. The second becomes "… (2)", with the suffix BEFORE the extension so the
 * file still opens.
 */
export function archiveNames(entries: ArchiveEntry[]): string[] {
  const used = new Map<string, number>()

  return entries.map((entry) => {
    // spentOn is typed as a bare string, not a branded "already clean" date.
    // Today it always arrives as a Postgres `date` (YYYY-MM-DD), but nothing
    // stops a future caller passing a raw OCR guess, and this is the same
    // interpolation-into-a-path-segment the vendor field needed protecting from.
    const spentOn = sanitizeSegment(entry.spentOn, 'unknown-date')
    const vendor = sanitizeSegment(entry.vendor ?? '', 'Receipt')
    const ext = extensionOf(entry.originalPath)
    const stem = `${spentOn} ${vendor} ${amountOf(entry.amountCents)}`

    const seen = used.get(stem) ?? 0
    used.set(stem, seen + 1)
    return seen === 0 ? `${stem}.${ext}` : `${stem} (${seen + 1}).${ext}`
  })
}
