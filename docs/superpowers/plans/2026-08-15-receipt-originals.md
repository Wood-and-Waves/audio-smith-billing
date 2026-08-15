# Retiring Receipt Originals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy every receipt original to Dropbox, verify the copy, and only then delete it from Supabase once its invoice has been paid for 30 days.

**Architecture:** All decision logic is pure and lives in `lib/`, tested with `node --test`. The archive and deletion stages run inside the existing daily cron at `app/api/cron/reminders/route.ts`, the one file permitted to hold the service-role key. A separate client-side zip export gives the same archive by hand, with no credentials at all.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres + Storage), Dropbox HTTP API (no SDK), `node --test` with native type stripping.

## Global Constraints

- **Ship order is not negotiable:** Tasks 1–3 (export) → 4–7 (archive) → **Task 8 (deletion) LAST**. A change that removes data ships after the thing that preserves it. Migration 0015 dropped a column in the same migration that replaced it and took the live app down.
- **No new runtime dependency.** The repo has nine; keep it that way. No `jszip`, no Dropbox SDK.
- `receipt_path` (the enhanced copy) is **NEVER** deleted, nulled, or modified. Only `receipt_original`.
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` are read in **exactly one file**: `app/api/cron/reminders/route.ts`. None may take a `NEXT_PUBLIC_` prefix. Never log or echo a value — names only.
- Money is **integer cents**. `parseUSD('')` returns **0, not null** — a trap that has already caused a Critical in this repo.
- Dates are plain `YYYY-MM-DD` strings pinned to UTC. Pure functions take `today` as a parameter; **never read a clock inside `lib/`**.
- Migrations are numbered, checksummed and applied once. Editing an applied migration is refused. New migration is **0019** and must be **additive only**.
- Tests: `npm test` must stay green (198 passing at plan time). Also `npx tsc --noEmit` and `npm run build` clean.
- **No test may** upload to Dropbox, delete from the live Storage bucket, write to the database, or call the Anthropic API.
- `scripts/test/*.test.ts` run under native type stripping: **types are stripped, JSX is not**. `lib/` modules import each other with relative `.ts` paths (`from '../../lib/foo.ts'`), because there is no path-alias loader in the test runner.
- Commit messages explain the failure being prevented, not the code. End every message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
|---|---|
| `lib/receiptArchiveName.ts` | **new** — turning an expense into a safe, unique archive filename |
| `lib/zipStore.ts` | **new** — a STORE-method zip writer and CRC-32 |
| `lib/dropboxContentHash.ts` | **new** — Dropbox's block hash, for verifying an upload |
| `lib/receiptRetention.ts` | **new** — pure: what may be archived, what may be deleted |
| `lib/dropbox.ts` | **new** — token exchange and upload over `fetch` |
| `scripts/sql/migrations/0019_receipt_archived_at.sql` | **new** — one nullable column |
| `app/expenses/actions.ts` | server action listing a show's originals for export |
| `components/ExpenseLog.tsx` | the export button and the archived/held counts |
| `app/api/cron/reminders/route.ts` | archive stage (Task 7), deletion stage (Task 8) |

---

### Task 1: Archive filenames

Storage names are `{stamp}-original.jpg`, meaningless in a folder. Both the zip
export and the Dropbox archive need `2026-08-22 HMS Host 19.98.jpg`.

**Files:**
- Create: `lib/receiptArchiveName.ts`
- Test: `scripts/test/receiptArchiveName.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ArchiveEntry = { spentOn: string; vendor: string | null; amountCents: number; originalPath: string }`
  - `sanitizeSegment(raw: string, fallback: string): string`
  - `archiveNames(entries: ArchiveEntry[]): string[]` — same order and length as input, every name unique.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/receiptArchiveName.test.ts`:

```ts
// Names that survive being looked at in a folder two years later, with no
// database in front of you.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeSegment, archiveNames, type ArchiveEntry,
} from '../../lib/receiptArchiveName.ts'

const e = (
  spentOn: string, vendor: string | null, amountCents: number, originalPath = 'x/y/1-original.jpg',
): ArchiveEntry => ({ spentOn, vendor, amountCents, originalPath })

test('an ordinary receipt reads as date, vendor and amount', () => {
  assert.deepEqual(archiveNames([e('2026-08-22', 'HMS Host', 1998)]), ['2026-08-22 HMS Host 19.98.jpg'])
})

test('the original keeps its own extension', () => {
  // An emailed airline receipt is a PDF. Naming it .jpg would make it open
  // in nothing.
  assert.deepEqual(
    archiveNames([e('2026-08-22', 'United', 60000, 'a/b/17-original.pdf')]),
    ['2026-08-22 United 600.00.pdf'],
  )
})

test('characters that are illegal in a filename are removed', () => {
  // A slash is the dangerous one: it would create a subfolder, or escape the
  // show's folder entirely.
  assert.deepEqual(
    archiveNames([e('2026-08-22', 'Hertz / LAX: "Rental"', 12345)]),
    ['2026-08-22 Hertz LAX Rental 123.45.jpg'],
  )
})

test('a vendor OCR never read still produces a usable name', () => {
  assert.deepEqual(archiveNames([e('2026-08-22', null, 1998)]), ['2026-08-22 Receipt 19.98.jpg'])
  assert.deepEqual(archiveNames([e('2026-08-22', '   ', 1998)]), ['2026-08-22 Receipt 19.98.jpg'])
})

test('two identical receipts on one day do not collide', () => {
  // Two $6 coffees at the same airport Starbucks is a real thing that happens.
  assert.deepEqual(
    archiveNames([e('2026-08-22', 'Starbucks', 632), e('2026-08-22', 'Starbucks', 632)]),
    ['2026-08-22 Starbucks 6.32.jpg', '2026-08-22 Starbucks 6.32 (2).jpg'],
  )
})

test('the suffix goes before the extension, not after', () => {
  const names = archiveNames([
    e('2026-08-22', 'Uber', 4310, 'a/b/1-original.pdf'),
    e('2026-08-22', 'Uber', 4310, 'a/b/2-original.pdf'),
  ])
  assert.equal(names[1], '2026-08-22 Uber 43.10 (2).pdf')
})

test('sanitizeSegment protects a show name used as a folder', () => {
  assert.equal(sanitizeSegment('PwC Tax Start', 'Show'), 'PwC Tax Start')
  assert.equal(sanitizeSegment('../../etc', 'Show'), 'etc')
  assert.equal(sanitizeSegment('GLS 2926 / PwC', 'Show'), 'GLS 2926 PwC')
  assert.equal(sanitizeSegment('   ', 'Show'), 'Show')
  assert.equal(sanitizeSegment('Trailing dots...', 'Show'), 'Trailing dots')
})

test('a very long vendor is trimmed rather than making an unopenable path', () => {
  const [name] = archiveNames([e('2026-08-22', 'A'.repeat(300), 1998)])
  assert.ok(name.length <= 120, `got ${name.length}`)
  assert.ok(name.startsWith('2026-08-22 AAA'))
  assert.ok(name.endsWith(' 19.98.jpg'))
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: FAIL — `Cannot find module '../../lib/receiptArchiveName.ts'`

- [ ] **Step 3: Implement**

Create `lib/receiptArchiveName.ts`:

```ts
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

/** Windows and macOS both refuse these, and a slash would escape the folder. */
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g

/** Long enough to stay readable, short enough that no filesystem objects. */
const MAX_SEGMENT = 80

/**
 * A single path segment, safe to use as a file or folder name.
 *
 * `fallback` is used when nothing legible survives — an empty vendor, or a name
 * made entirely of illegal characters. Returning '' would produce a path with an
 * empty segment, which reads as the parent directory.
 */
export function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(ILLEGAL, ' ')
    .replace(/\.+/g, ' ')       // '..' is the traversal case, and a trailing dot is illegal on Windows
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEGMENT)
    .trim()
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
    const vendor = sanitizeSegment(entry.vendor ?? '', 'Receipt')
    const ext = extensionOf(entry.originalPath)
    const stem = `${entry.spentOn} ${vendor} ${amountOf(entry.amountCents)}`

    const seen = used.get(stem) ?? 0
    used.set(stem, seen + 1)
    return seen === 0 ? `${stem}.${ext}` : `${stem} (${seen + 1}).${ext}`
  })
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: PASS — 206 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add lib/receiptArchiveName.ts scripts/test/receiptArchiveName.test.ts
git commit -m "Name a receipt so it can be found outside the app"
```

---

### Task 2: A zip writer, with no dependency

**Files:**
- Create: `lib/zipStore.ts`
- Test: `scripts/test/zipStore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `crc32(bytes: Uint8Array): number`
  - `type ZipEntry = { name: string; bytes: Uint8Array; date: string }` — `date` is `YYYY-MM-DD`
  - `buildZip(entries: ZipEntry[]): Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/zipStore.test.ts`. The test that matters shells out to the
system `unzip`: an archive only this code can read would be worthless.

```ts
// A zip with no compression, because JPEG and PDF are already compressed.
//
// The test that matters is the last one: the system `unzip` reads it. Testing a
// hand-rolled format only against its own reader proves nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, buildZip, type ZipEntry } from '../../lib/zipStore.ts'

const bytes = (s: string) => new TextEncoder().encode(s)

test('crc32 matches the known vector for "123456789"', () => {
  // The standard CRC-32 check value, from the algorithm's own specification.
  assert.equal(crc32(bytes('123456789')) >>> 0, 0xcbf43926)
})

test('crc32 of nothing is zero', () => {
  assert.equal(crc32(new Uint8Array(0)) >>> 0, 0)
})

test('an empty archive is valid rather than corrupt', () => {
  const zip = buildZip([])
  // Just the end-of-central-directory record.
  assert.equal(zip.length, 22)
  assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x05, 0x06])
})

test('the local header and central directory signatures are where they belong', () => {
  const zip = buildZip([{ name: 'a.txt', bytes: bytes('hello'), date: '2026-08-22' }])
  assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04])
  // Stored, not deflated: the compression-method field is 0.
  assert.equal(zip[8] | (zip[9] << 8), 0)
})

test('the system unzip reads it, with byte-identical contents', () => {
  // The whole point. If `unzip` cannot open it, nothing else about this
  // module matters.
  const dir = mkdtempSync(join(tmpdir(), 'zipstore-'))
  try {
    const entries: ZipEntry[] = [
      { name: '2026-08-22 HMS Host 19.98.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x11]), date: '2026-08-22' },
      { name: '2026-08-23 United 600.00.pdf', bytes: bytes('%PDF-1.4 not really'), date: '2026-08-23' },
      { name: 'empty.txt', bytes: new Uint8Array(0), date: '2026-01-01' },
    ]
    const path = join(dir, 'out.zip')
    writeFileSync(path, buildZip(entries))

    // -t tests the archive: non-zero exit or "cannot find" means we built junk.
    const listing = execFileSync('unzip', ['-t', path], { encoding: 'utf8' })
    assert.match(listing, /No errors detected/)

    execFileSync('unzip', ['-q', '-o', path, '-d', dir])
    for (const entry of entries) {
      const round = new Uint8Array(readFileSync(join(dir, entry.name)))
      assert.deepEqual(Array.from(round), Array.from(entry.bytes), entry.name)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a name with a space and a non-ASCII character survives the round trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zipstore-'))
  try {
    const name = '2026-08-22 Café Ubé 4.00.jpg'
    const path = join(dir, 'out.zip')
    writeFileSync(path, buildZip([{ name, bytes: bytes('x'), date: '2026-08-22' }]))
    execFileSync('unzip', ['-q', '-o', path, '-d', dir])
    assert.equal(readFileSync(join(dir, name), 'utf8'), 'x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: FAIL — `Cannot find module '../../lib/zipStore.ts'`

- [ ] **Step 3: Implement**

Create `lib/zipStore.ts`:

```ts
// A zip file, written by hand.
//
// Deliberately no dependency: this repo has nine, and a zip using the STORE
// method is about a hundred lines. STORE — no compression — is also the RIGHT
// method here, not merely the easy one. Every byte going in is a JPEG or a PDF,
// both already compressed, so deflate would burn CPU on a phone to save
// nothing.
//
// No zip64. A show's receipts will not approach 4GB, and the added complexity
// would be untested weight.
//
// Pure: bytes in, bytes out, no clock. Entry timestamps come from the expense's
// own spent_on date.

export type ZipEntry = {
  name: string
  bytes: Uint8Array
  /** Plain YYYY-MM-DD. Becomes the DOS timestamp in the archive. */
  date: string
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS date: year since 1980 in the top 7 bits, then month, then day. */
function dosDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return (Math.max(0, y - 1980) << 9) | (m << 5) | d
}

/** Midday, so a reader in any timezone still shows the right day. */
const DOS_TIME = (12 << 11) | (0 << 5) | 0

class Writer {
  private parts: Uint8Array[] = []
  length = 0

  bytes(b: Uint8Array) {
    this.parts.push(b)
    this.length += b.length
  }

  u16(v: number) {
    this.bytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]))
  }

  u32(v: number) {
    this.bytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]))
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const part of this.parts) {
      out.set(part, at)
      at += part.length
    }
    return out
  }
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const body = new Writer()
  const central = new Writer()

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.bytes)
    const size = entry.bytes.length
    const date = dosDate(entry.date)
    const offset = body.length

    // Local file header.
    body.u32(0x04034b50)
    body.u16(20)          // version needed: 2.0, which is what STORE requires
    body.u16(0x0800)      // bit 11: the name is UTF-8, so accents survive
    body.u16(0)           // method 0 = stored
    body.u16(DOS_TIME)
    body.u16(date)
    body.u32(crc)
    body.u32(size)        // compressed
    body.u32(size)        // uncompressed — equal, because nothing is compressed
    body.u16(name.length)
    body.u16(0)           // no extra field
    body.bytes(name)
    body.bytes(entry.bytes)

    // Central directory record for the same entry.
    central.u32(0x02014b50)
    central.u16(20)       // version made by
    central.u16(20)       // version needed
    central.u16(0x0800)
    central.u16(0)
    central.u16(DOS_TIME)
    central.u16(date)
    central.u32(crc)
    central.u32(size)
    central.u32(size)
    central.u16(name.length)
    central.u16(0)        // extra
    central.u16(0)        // comment
    central.u16(0)        // disk number
    central.u16(0)        // internal attributes
    central.u32(0)        // external attributes
    central.u32(offset)   // where the local header sits
    central.bytes(name)
  }

  const out = new Writer()
  out.bytes(body.finish())
  const centralBytes = central.finish()
  out.bytes(centralBytes)

  // End of central directory.
  out.u32(0x06054b50)
  out.u16(0)                      // this disk
  out.u16(0)                      // disk holding the central directory
  out.u16(entries.length)         // entries on this disk
  out.u16(entries.length)         // entries total
  out.u32(centralBytes.length)
  out.u32(body.length)            // where the central directory starts
  out.u16(0)                      // no comment

  return out.finish()
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: PASS — 212 pass, 0 fail. If `unzip` reports anything other than
"No errors detected", the format is wrong; fix it rather than relaxing the test.

- [ ] **Step 5: Commit**

```bash
git add lib/zipStore.ts scripts/test/zipStore.test.ts
git commit -m "Write a zip without taking on a dependency to do it"
```

---

### Task 3: The export button

**Files:**
- Modify: `app/expenses/actions.ts` — add `listShowOriginals`
- Modify: `components/ExpenseLog.tsx` — the button and the counts
- Test: none new (UI state; the logic it uses is already covered by Tasks 1–2)

**Interfaces:**
- Consumes: `archiveNames`, `ArchiveEntry` (Task 1); `buildZip`, `ZipEntry` (Task 2).
- Produces:
  - `listShowOriginals(showId: string): Promise<{ error: string } | { originals: OriginalRef[]; showName: string }>`
  - `type OriginalRef = { spentOn: string; vendor: string | null; amountCents: number; originalPath: string; signedUrl: string }`

- [ ] **Step 1: Add the server action**

In `app/expenses/actions.ts`, follow the existing signed-URL helper at
`app/expenses/actions.ts:153` (`createSignedUrls`, `SIGNED_URL_SECONDS = 3600`).
Add:

```ts
export type OriginalRef = {
  spentOn: string
  vendor: string | null
  amountCents: number
  originalPath: string
  signedUrl: string
}

/**
 * Every original still held for a show, with a signed URL each.
 *
 * The browser assembles the zip itself: an 80MB archive must not pass through a
 * serverless function, which has neither the memory budget nor the time.
 */
export async function listShowOriginals(
  showId: string,
): Promise<{ error: string } | { originals: OriginalRef[]; showName: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: show, error: showError } = await supabase
    .from('shows').select('name').eq('id', showId).single()
  if (showError) return { error: showError.message }

  const { data, error } = await supabase
    .from('expenses')
    .select('spent_on, where_spent, amount_cents, receipt_original')
    .eq('show_id', showId)
    .not('receipt_original', 'is', null)
    .order('spent_on', { ascending: true })
  if (error) return { error: error.message }

  const rows = (data ?? []) as {
    spent_on: string; where_spent: string; amount_cents: number; receipt_original: string
  }[]
  if (rows.length === 0) return { originals: [], showName: show.name }

  const { data: signed, error: signError } = await supabase.storage
    .from('receipts')
    .createSignedUrls(rows.map((r) => r.receipt_original), SIGNED_URL_SECONDS)
  if (signError) return { error: signError.message }

  const urlByPath = new Map((signed ?? []).map((s) => [s.path ?? '', s.signedUrl]))

  return {
    showName: show.name,
    originals: rows.flatMap((r) => {
      const signedUrl = urlByPath.get(r.receipt_original)
      // A row whose object has already gone is skipped rather than failing the
      // export: the rest of the show is still worth saving.
      return signedUrl ? [{
        spentOn: r.spent_on,
        vendor: r.where_spent || null,
        amountCents: r.amount_cents,
        originalPath: r.receipt_original,
        signedUrl,
      }] : []
    }),
  }
}
```

- [ ] **Step 2: Add the button to `components/ExpenseLog.tsx`**

Place it beside the expense list heading. Use `FIELD_FULL`-adjacent styling —
match the existing secondary buttons in this file, not the primary one.

```tsx
const [exporting, setExporting] = useState(false)

/**
 * Saves every original for this show as one zip.
 *
 * Deliberately a desktop action. The archive is tens of megabytes and the point
 * of it is to land in a folder, which is not a thing that happens usefully on a
 * phone over hotel wifi.
 */
async function exportOriginals() {
  setExporting(true)
  setError(null)
  try {
    const result = await listShowOriginals(showId)
    if ('error' in result) { setError(result.error); return }
    if (result.originals.length === 0) { setError('No originals are held for this show.'); return }

    const names = archiveNames(result.originals)
    const entries: ZipEntry[] = []
    for (let i = 0; i < result.originals.length; i++) {
      const ref = result.originals[i]
      const response = await fetch(ref.signedUrl)
      if (!response.ok) throw new Error(`Could not download ${names[i]}.`)
      entries.push({
        name: names[i],
        bytes: new Uint8Array(await response.arrayBuffer()),
        date: ref.spentOn,
      })
    }

    const blob = new Blob([buildZip(entries)], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitizeSegment(result.showName, 'Show')} originals.zip`
    a.click()
    // Revoked on the next tick: revoking synchronously races the download in
    // Safari and produces an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Could not build the archive.')
  } finally {
    setExporting(false)
  }
}
```

Render it only when the show has originals, with the counts beside it:

```tsx
{originalsHeld > 0 && (
  <div className="flex items-center gap-3">
    <span className="text-muted">
      {originalsHeld} original{originalsHeld === 1 ? '' : 's'} — {originalsArchived} archived
    </span>
    <button type="button" onClick={() => void exportOriginals()} disabled={exporting}>
      {exporting ? 'Building…' : 'Download originals'}
    </button>
  </div>
)}
```

`originalsHeld` and `originalsArchived` are counted from the `expenses` rows the
component already receives — count non-null `receipt_original`, and non-null
`receipt_archived_at`. **Until Task 5 adds that column, hard-code
`originalsArchived` to 0 and leave a comment saying Task 5 fills it in.**

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: both clean.

Then manually, on desktop against a show with receipts: the button appears,
produces a zip, and the zip opens in Finder with correctly-named files.

- [ ] **Step 4: Commit**

```bash
git add app/expenses/actions.ts components/ExpenseLog.tsx
git commit -m "Save a show's receipt originals as one zip"
```

---

### Task 4: Dropbox's content hash

The basis for deleting anything. Dropbox returns this for an uploaded file;
computing it locally and comparing proves the stored bytes are the sent bytes.

**Files:**
- Create: `lib/dropboxContentHash.ts`
- Test: `scripts/test/dropboxContentHash.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `dropboxContentHash(bytes: Uint8Array): Promise<string>` — lowercase hex.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/dropboxContentHash.test.ts`:

```ts
// Dropbox's own hash scheme: SHA-256 over the concatenated SHA-256 of each
// 4MB block. Verified against independently computed values rather than
// against the implementation, because this is what licenses a delete.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dropboxContentHash, BLOCK_SIZE } from '../../lib/dropboxContentHash.ts'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest()
const filled = (n: number, byte: number) => new Uint8Array(n).fill(byte)

test('a file smaller than one block is the hash of its single block hash', () => {
  const bytes = new TextEncoder().encode('hello world')
  const expected = createHash('sha256').update(sha(bytes)).digest('hex')
  return dropboxContentHash(bytes).then((got) => assert.equal(got, expected))
})

test('an empty file hashes the empty concatenation', () => {
  // No blocks at all, so it is SHA-256 of nothing — not of one empty block.
  const expected = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
  return dropboxContentHash(new Uint8Array(0)).then((got) => assert.equal(got, expected))
})

test('exactly one block is still one block', () => {
  const bytes = filled(BLOCK_SIZE, 0xab)
  const expected = createHash('sha256').update(sha(bytes)).digest('hex')
  return dropboxContentHash(bytes).then((got) => assert.equal(got, expected))
})

test('one byte over a block becomes two blocks', () => {
  // The boundary that a naive implementation gets wrong, and the one that
  // matters: every real receipt is a few MB.
  const bytes = filled(BLOCK_SIZE + 1, 0xcd)
  const expected = createHash('sha256')
    .update(Buffer.concat([sha(bytes.slice(0, BLOCK_SIZE)), sha(bytes.slice(BLOCK_SIZE))]))
    .digest('hex')
  return dropboxContentHash(bytes).then((got) => assert.equal(got, expected))
})

test('the hash is lowercase hex, which is what Dropbox returns', () => {
  return dropboxContentHash(new TextEncoder().encode('x')).then((got) => {
    assert.match(got, /^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/dropboxContentHash.ts`:

```ts
// Dropbox's content hash.
//
// Split the file into 4MB blocks, SHA-256 each, concatenate those digests, and
// SHA-256 the result. Dropbox returns this for every uploaded file, so
// computing it locally and comparing proves the bytes it stored are the bytes
// that were sent.
//
// This is what licenses deleting the only other copy. A size check alone would
// catch a truncated upload; this also catches a corrupted one.
//
// Uses Web Crypto rather than node:crypto so the same module works in the edge
// and node runtimes without a second implementation.

export const BLOCK_SIZE = 4 * 1024 * 1024

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('')

export async function dropboxContentHash(bytes: Uint8Array): Promise<string> {
  const digests: Uint8Array[] = []
  for (let at = 0; at < bytes.length; at += BLOCK_SIZE) {
    const block = bytes.subarray(at, Math.min(at + BLOCK_SIZE, bytes.length))
    digests.push(new Uint8Array(await crypto.subtle.digest('SHA-256', block)))
  }

  // An empty file has no blocks, so this hashes an empty buffer — which is what
  // Dropbox does, and is NOT the same as hashing one empty block.
  const joined = new Uint8Array(digests.reduce((n, d) => n + d.length, 0))
  let at = 0
  for (const digest of digests) {
    joined.set(digest, at)
    at += digest.length
  }

  return toHex(await crypto.subtle.digest('SHA-256', joined))
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: PASS — 217 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add lib/dropboxContentHash.ts scripts/test/dropboxContentHash.test.ts
git commit -m "Compute Dropbox's content hash, so a copy can be proven before a delete"
```

---

### Task 5: The column, and what may be archived or deleted

**Files:**
- Create: `scripts/sql/migrations/0019_receipt_archived_at.sql`
- Create: `lib/receiptRetention.ts`
- Test: `scripts/test/receiptRetention.test.ts`
- Modify: `components/ExpenseLog.tsx` — replace the hard-coded `originalsArchived`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type RetentionRow = { expenseId: string; receiptOriginal: string | null; receiptArchivedAt: string | null; invoiceStatus: 'draft' | 'sent' | 'paid' | 'void' | null; paidOn: string | null; invoiceUpdatedAt: string | null }`
  - `GRACE_DAYS = 30`
  - `needsArchiving(rows: RetentionRow[]): RetentionRow[]`
  - `mayDelete(row: RetentionRow, today: string): boolean`
  - `deletable(rows: RetentionRow[], today: string): RetentionRow[]`

- [ ] **Step 1: Write the migration**

Create `scripts/sql/migrations/0019_receipt_archived_at.sql`:

```sql
-- 0019 — the record that an original is safely out of Supabase
--
-- Receipts are stored twice: receipt_path, the enhanced copy that goes on the
-- invoice, and receipt_original, the untouched upload. The original is ~95% of
-- what receipts cost, and the free tier's 1GB is about 250 of them.
--
-- Originals are copied to Dropbox and then deleted here. This column is what
-- makes the delete safe: it is set ONLY after an upload has been verified by
-- size and by Dropbox's own content hash, and the delete refuses to touch any
-- row where it is null. A failed or half-finished upload therefore cannot lose
-- the only untouched copy — it just gets retried tomorrow.
--
-- Inferring this by listing Dropbox each run was considered and rejected: slow,
-- rate-limited, and it would make deletion depend on a listing being correct at
-- that instant.
--
-- Additive only. Nothing is dropped, nothing is altered — 0015 dropped a column
-- that running code still read and took the live app down.
alter table expenses add column receipt_archived_at timestamptz;

-- The archive stage's query: the oldest expenses still holding an unarchived
-- original. Partial, because the rows it serves are the minority and shrink.
create index expenses_unarchived_idx on expenses (created_at)
  where receipt_original is not null and receipt_archived_at is null;
```

- [ ] **Step 2: Write the failing test**

Create `scripts/test/receiptRetention.test.ts`:

```ts
// What may be archived, and what may be deleted.
//
// The deletion rules are the dangerous half: getting one wrong destroys the
// only untouched copy of a financial record. Every rule gets a test that fails
// in the destructive direction if the rule is dropped.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  needsArchiving, mayDelete, deletable, GRACE_DAYS, type RetentionRow,
} from '../../lib/receiptRetention.ts'

const TODAY = '2026-08-15'

const row = (over: Partial<RetentionRow> = {}): RetentionRow => ({
  expenseId: 'e1',
  receiptOriginal: 'user/show/1-original.jpg',
  receiptArchivedAt: '2026-06-01T00:00:00Z',
  invoiceStatus: 'paid',
  paidOn: '2026-07-01',          // 45 days before TODAY
  invoiceUpdatedAt: '2026-07-01T00:00:00Z',
  ...over,
})

test('the grace period is 30 days', () => {
  assert.equal(GRACE_DAYS, 30)
})

test('paid, aged and archived may be deleted', () => {
  assert.equal(mayDelete(row(), TODAY), true)
})

test('an unarchived original is NEVER deletable, whatever else is true', () => {
  // The rule the whole design rests on. If this one goes, a failed upload
  // destroys the only untouched copy.
  assert.equal(mayDelete(row({ receiptArchivedAt: null }), TODAY), false)
})

test('a payment inside the grace period is not deletable', () => {
  assert.equal(mayDelete(row({ paidOn: '2026-08-01' }), TODAY), false)   // 14 days
  assert.equal(mayDelete(row({ paidOn: '2026-07-16' }), TODAY), true)    // exactly 30
  assert.equal(mayDelete(row({ paidOn: '2026-07-17' }), TODAY), false)   // 29
})

test('draft, sent and void invoices are never deletable', () => {
  // void especially: voiding frees the show to be rebilled, so those expenses
  // are live again.
  for (const status of ['draft', 'sent', 'void'] as const) {
    assert.equal(mayDelete(row({ invoiceStatus: status }), TODAY), false, status)
  }
})

test('an expense on a show that was never billed is not deletable', () => {
  assert.equal(mayDelete(row({ invoiceStatus: null, paidOn: null }), TODAY), false)
})

test('an invoice marked paid with no payment row falls back to when it changed', () => {
  // Dan can flip the status without recording a payment. Without the fallback
  // those originals would be archived forever and never reclaimed.
  assert.equal(
    mayDelete(row({ paidOn: null, invoiceUpdatedAt: '2026-07-01T12:00:00Z' }), TODAY),
    true,
  )
  assert.equal(
    mayDelete(row({ paidOn: null, invoiceUpdatedAt: '2026-08-10T12:00:00Z' }), TODAY),
    false,
  )
})

test('a row with no original left has nothing to delete', () => {
  assert.equal(mayDelete(row({ receiptOriginal: null }), TODAY), false)
})

test('deletable filters a mixed list and keeps order', () => {
  const rows = [
    row({ expenseId: 'yes-1' }),
    row({ expenseId: 'no-unarchived', receiptArchivedAt: null }),
    row({ expenseId: 'no-recent', paidOn: '2026-08-14' }),
    row({ expenseId: 'yes-2' }),
  ]
  assert.deepEqual(deletable(rows, TODAY).map((r) => r.expenseId), ['yes-1', 'yes-2'])
})

test('archiving wants every unarchived original, regardless of payment', () => {
  // Deliberately not gated on payment: archiving early spreads the work, so by
  // the time an invoice is 30 days paid its originals went across weeks ago.
  const rows = [
    row({ expenseId: 'unbilled', invoiceStatus: null, paidOn: null, receiptArchivedAt: null }),
    row({ expenseId: 'already', receiptArchivedAt: '2026-06-01T00:00:00Z' }),
    row({ expenseId: 'gone', receiptOriginal: null, receiptArchivedAt: null }),
    row({ expenseId: 'draft', invoiceStatus: 'draft', receiptArchivedAt: null }),
  ]
  assert.deepEqual(needsArchiving(rows).map((r) => r.expenseId), ['unbilled', 'draft'])
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `lib/receiptRetention.ts`:

```ts
// When an original may leave, and when it may be destroyed.
//
// Two rules, and they are not symmetric. Archiving is cheap and reversible, so
// it applies to everything. Deleting is neither, so it needs all three of:
// the invoice paid, the payment old enough to be settled, and a VERIFIED copy
// already in Dropbox.
//
// Pure — `today` is a parameter, never a clock, so these tests cannot drift
// when the suite runs on a different day. Dates are plain YYYY-MM-DD and
// compare lexically.

export type RetentionRow = {
  expenseId: string
  receiptOriginal: string | null
  /** Set only after an upload is verified by size AND content hash. */
  receiptArchivedAt: string | null
  invoiceStatus: 'draft' | 'sent' | 'paid' | 'void' | null
  /** max(payments.paid_on) for the invoice — payments are a table, so partial payments work. */
  paidOn: string | null
  /** Fallback for an invoice hand-marked paid with no payment row. */
  invoiceUpdatedAt: string | null
}

/** Long enough that a settled invoice is genuinely settled. */
export const GRACE_DAYS = 30

/** Days between two plain dates. Both are UTC-pinned, so this cannot drift. */
function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/**
 * Everything still holding an original that has not been copied out.
 *
 * Deliberately NOT gated on payment. Archiving early spreads the work across
 * many nightly runs, so by the time an invoice is 30 days paid its originals
 * went across weeks ago and the delete has nothing to wait for.
 */
export function needsArchiving(rows: RetentionRow[]): RetentionRow[] {
  return rows.filter((r) => r.receiptOriginal !== null && r.receiptArchivedAt === null)
}

/**
 * Whether this original may be destroyed.
 *
 * Every clause here is load-bearing; each one has a test that fails in the
 * destructive direction if it is removed.
 */
export function mayDelete(row: RetentionRow, today: string): boolean {
  // Nothing left to delete.
  if (row.receiptOriginal === null) return false

  // The rule the whole design rests on: no verified copy, no delete. A failed
  // or half-finished upload can therefore never lose the only untouched copy.
  if (row.receiptArchivedAt === null) return false

  // Unbilled, or billed and not yet paid. 'void' is here too, and matters:
  // voiding an invoice frees the show to be rebilled, so those expenses are
  // live work again.
  if (row.invoiceStatus !== 'paid') return false

  // Payments are a table rather than a column, so the date is the latest
  // payment. An invoice hand-marked paid has none, and without the fallback its
  // originals would be archived forever and never reclaimed.
  const settled = row.paidOn ?? row.invoiceUpdatedAt?.slice(0, 10) ?? null
  if (settled === null) return false

  return daysBetween(settled, today) >= GRACE_DAYS
}

export function deletable(rows: RetentionRow[], today: string): RetentionRow[] {
  return rows.filter((row) => mayDelete(row, today))
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: PASS — 227 pass, 0 fail.

- [ ] **Step 6: Apply the migration and fill in the UI count**

Run:
```bash
npm run db:migrate
```
Expected: `0019_receipt_archived_at` applied. Re-running reports it already
applied rather than applying it twice.

Then in `components/ExpenseLog.tsx`, replace the hard-coded `originalsArchived`
with a count of rows whose `receipt_archived_at` is non-null, and add
`receipt_archived_at` to the `expenses` select on the show page.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: both clean. The show page still loads and shows "N originals — 0 archived".

- [ ] **Step 8: Commit**

```bash
git add scripts/sql/migrations/0019_receipt_archived_at.sql lib/receiptRetention.ts \
        scripts/test/receiptRetention.test.ts components/ExpenseLog.tsx
git commit -m "Record when an original is safely archived, and gate deletion on it"
```

---

### Task 6: Talking to Dropbox

**Files:**
- Create: `lib/dropbox.ts`
- Test: `scripts/test/dropbox.test.ts` — argument construction only, no network

**Interfaces:**
- Consumes: `dropboxContentHash` (Task 4).
- Produces:
  - `type DropboxCreds = { appKey: string; appSecret: string; refreshToken: string }`
  - `getAccessToken(creds: DropboxCreds): Promise<string>`
  - `uploadArg(path: string): string`
  - `uploadAndVerify(accessToken: string, path: string, bytes: Uint8Array): Promise<{ ok: true } | { ok: false; error: string }>`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/dropbox.test.ts`. Only the pure parts are tested — the
network calls are not mocked, because a mock of `fetch` would test the mock.

```ts
// The argument Dropbox's upload endpoint takes, which travels in an HTTP HEADER
// and therefore must be plain ASCII JSON.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uploadArg } from '../../lib/dropbox.ts'

test('the upload argument names the path and refuses to overwrite', () => {
  const arg = JSON.parse(uploadArg('/receipts/2026/PwC/a.jpg'))
  assert.equal(arg.path, '/receipts/2026/PwC/a.jpg')
  assert.equal(arg.mode, 'add')       // never overwrite — an archive is append-only
  assert.equal(arg.autorename, true)  // a name collision renames rather than fails
  assert.equal(arg.mute, true)        // no notification per receipt
})

test('a non-ASCII path is escaped, because this travels in a header', () => {
  // "Café" in a raw header makes Dropbox reject the request. The escape is not
  // cosmetic — it is why an accented vendor name works at all.
  const arg = uploadArg('/receipts/2026/Café/a.jpg')
  assert.ok(!/[^\x00-\x7f]/.test(arg), `not ASCII: ${arg}`)
  assert.equal(JSON.parse(arg).path, '/receipts/2026/Café/a.jpg')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/dropbox.ts`:

```ts
// Dropbox, over plain fetch.
//
// No SDK: this needs two endpoints, and the SDK would be a tenth runtime
// dependency for the sake of them.
//
// The app is registered with the "App folder" access type, so its root IS
// /Apps/{app name}/ and it can see nothing else in Dan's Dropbox. Paths here
// are therefore written as plain /receipts/... — an app-folder app addressing
// its own root.
//
// Credentials never appear in a log line. The only thing ever reported is
// whether a variable was PRESENT, by name.

import { dropboxContentHash } from './dropboxContentHash.ts'

export type DropboxCreds = {
  appKey: string
  appSecret: string
  refreshToken: string
}

/**
 * A short-lived access token, from the long-lived refresh token.
 *
 * Dropbox access tokens expire in about four hours, which is shorter than the
 * gap between nightly runs — so every run starts by exchanging.
 */
export async function getAccessToken(creds: DropboxCreds): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
  })
  const basic = Buffer.from(`${creds.appKey}:${creds.appSecret}`).toString('base64')

  const response = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    // The status only. A body from the token endpoint can echo parts of the
    // request, and this string ends up in a JSON response.
    throw new Error(`Dropbox refused the refresh token (HTTP ${response.status}).`)
  }
  const json = await response.json() as { access_token?: string }
  if (!json.access_token) throw new Error('Dropbox returned no access token.')
  return json.access_token
}

/**
 * The Dropbox-API-Arg header value.
 *
 * It travels in an HTTP header, so it must be plain ASCII — an accented vendor
 * name would otherwise make Dropbox reject the request outright. JSON's \uXXXX
 * escaping is what makes "Café" survive.
 */
export function uploadArg(path: string): string {
  const arg = JSON.stringify({ path, mode: 'add', autorename: true, mute: true })
  return arg.replace(/[\x7f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * Uploads one file and proves Dropbox stored exactly what was sent.
 *
 * Both checks matter, and they catch different things: size catches a truncated
 * upload, the content hash catches a corrupted one. This is the whole licence
 * for deleting the other copy, so a failure here returns ok:false and the
 * caller must leave receipt_archived_at null.
 */
export async function uploadAndVerify(
  accessToken: string, path: string, bytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let response: Response
  try {
    response = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': uploadArg(path),
        'Content-Type': 'application/octet-stream',
      },
      body: bytes,
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Upload failed.' }
  }

  if (!response.ok) return { ok: false, error: `Dropbox rejected the upload (HTTP ${response.status}).` }

  const stored = await response.json() as { size?: number; content_hash?: string }
  if (stored.size !== bytes.length) {
    return { ok: false, error: `Dropbox stored ${stored.size} bytes, not ${bytes.length}.` }
  }
  const expected = await dropboxContentHash(bytes)
  if (stored.content_hash !== expected) {
    return { ok: false, error: 'Dropbox stored a file whose content hash does not match.' }
  }
  return { ok: true }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: PASS — 229 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add lib/dropbox.ts scripts/test/dropbox.test.ts
git commit -m "Upload to Dropbox and prove what was stored"
```

---

### Task 7: The archive stage in the cron

**No deletion in this task.** Deleting is Task 8, and it does not ship until
this one has been seen working against real data.

**Files:**
- Modify: `app/api/cron/reminders/route.ts`

**Interfaces:**
- Consumes: `needsArchiving`, `RetentionRow` (Task 5); `getAccessToken`, `uploadAndVerify`, `DropboxCreds` (Task 6); `archiveNames`, `sanitizeSegment` (Task 1).
- Produces: an `archived` block on the cron's JSON response.

- [ ] **Step 1: Add the stage**

In `app/api/cron/reminders/route.ts`, after the reminder work and before the
final `NextResponse.json`. Read the three variables the same way the existing
code reads its own — **names only in any message, never values**.

```ts
/** Bounded per run: Vercel's Hobby plan caps a function at 60s, and each file is a download plus an upload. */
const ARCHIVE_BATCH = 8

/**
 * Copies originals to Dropbox, oldest first.
 *
 * Runs before the deletion stage and is entirely independent of it: this only
 * ever SETS receipt_archived_at. Every failure path leaves it null, which is
 * what makes the delete safe — an original with no verified copy is never
 * touched.
 *
 * Missing credentials skip the stage rather than failing the request. The cron
 * still has reminders to send, and a receipt archive is not worth losing those.
 */
async function archiveOriginals(db: SupabaseClient): Promise<{
  archived: number; failed: string[]; skipped?: string
}> {
  const appKey = process.env.DROPBOX_APP_KEY
  const appSecret = process.env.DROPBOX_APP_SECRET
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN
  if (!appKey || !appSecret || !refreshToken) {
    const missing = [
      !appKey && 'DROPBOX_APP_KEY',
      !appSecret && 'DROPBOX_APP_SECRET',
      !refreshToken && 'DROPBOX_REFRESH_TOKEN',
    ].filter(Boolean) as string[]
    return { archived: 0, failed: [], skipped: `Not configured: ${missing.join(', ')}.` }
  }

  const { data, error } = await db
    .from('expenses')
    .select('id, spent_on, where_spent, amount_cents, receipt_original, shows(name, dates:show_days(date))')
    .not('receipt_original', 'is', null)
    .is('receipt_archived_at', null)
    .order('created_at', { ascending: true })
    .limit(ARCHIVE_BATCH)
  if (error) return { archived: 0, failed: [error.message] }

  const rows = data ?? []
  if (rows.length === 0) return { archived: 0, failed: [] }

  let accessToken: string
  try {
    accessToken = await getAccessToken({ appKey, appSecret, refreshToken })
  } catch (e) {
    return { archived: 0, failed: [e instanceof Error ? e.message : 'Dropbox auth failed.'] }
  }

  const names = archiveNames(rows.map((r) => ({
    spentOn: r.spent_on,
    vendor: r.where_spent || null,
    amountCents: r.amount_cents,
    originalPath: r.receipt_original,
  })))

  let archived = 0
  const failed: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    // The year comes from the show's FIRST day, so a trip spanning New Year
    // does not split across two folders.
    const days: string[] = (row.shows?.dates ?? []).map((d: { date: string }) => d.date)
    const year = (days.length ? days.reduce((a, b) => (a < b ? a : b)) : row.spent_on).slice(0, 4)
    const folder = sanitizeSegment(row.shows?.name ?? '', 'Unfiled')
    const path = `/receipts/${year}/${folder}/${names[i]}`

    const { data: blob, error: downloadError } = await db.storage
      .from('receipts').download(row.receipt_original)
    if (downloadError || !blob) {
      failed.push(`${names[i]}: ${downloadError?.message ?? 'could not download'}`)
      continue
    }

    const result = await uploadAndVerify(accessToken, path, new Uint8Array(await blob.arrayBuffer()))
    if (!result.ok) { failed.push(`${names[i]}: ${result.error}`); continue }

    const { error: markError } = await db
      .from('expenses')
      .update({ receipt_archived_at: new Date().toISOString() })
      .eq('id', row.id)
    if (markError) {
      // The file IS in Dropbox but the mark failed. Safe: the next run
      // re-uploads it, and mode:'add' with autorename means a duplicate lands
      // beside it rather than overwriting anything.
      failed.push(`${names[i]}: uploaded but not marked — ${markError.message}`)
      continue
    }
    archived++
  }

  return { archived, failed }
}
```

Call it and fold the result into the response:

```ts
const archive = await archiveOriginals(db)

return NextResponse.json({
  today,
  digestDay: isDigestDay(today),
  dueSoon: s.dueSoon.length,
  overdue: s.overdue.length,
  newlyOverdue: s.newlyOverdue.length,
  outstandingCents: s.totalOutstandingCents,
  sent,
  failed,
  archive,
}, { status: failed.length > 0 ? 500 : 200 })
```

Note the status deliberately does **not** go 500 on an archive failure: a
receipt that will be retried tomorrow must not mark the reminder run as broken.

- [ ] **Step 2: Confirm the credential rule still holds**

Run:
```bash
grep -rn "DROPBOX_" --include="*.ts" --include="*.tsx" . | grep -v node_modules
```
Expected: every hit is in `app/api/cron/reminders/route.ts`. **No `NEXT_PUBLIC_`
prefix anywhere.** If any other file matches, move it.

- [ ] **Step 3: Verify**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: 229 pass, both clean.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/reminders/route.ts
git commit -m "Copy receipt originals to Dropbox, a few each night"
```

- [ ] **Step 5: STOP — hand back before Task 8**

Task 8 deletes data. It does not begin until Dan has confirmed the archive is
really running: files appearing under `/Apps/{app}/receipts/{year}/{show}/`,
the show page's "N archived" count climbing, and the cron response reporting
`archived` with an empty `failed`.

---

### Task 8: The deletion stage

**Do not start this task until Task 7 has been verified against real data.**

**Files:**
- Modify: `app/api/cron/reminders/route.ts`

**Interfaces:**
- Consumes: `deletable`, `RetentionRow`, `GRACE_DAYS` (Task 5).
- Produces: a `reclaimed` block on the cron's JSON response.

- [ ] **Step 1: Add the stage**

```ts
/** Bounded like the archive stage — a delete is cheap, but the query behind it is not free. */
const DELETE_BATCH = 50

/**
 * Removes originals whose copy is verified and whose invoice has been settled
 * for GRACE_DAYS.
 *
 * The ORDER matters and is not the obvious one: the file goes first, THEN the
 * column is nulled. Nulling first and failing the delete would leave an object
 * whose path is recorded nowhere — an orphan that can never be found again.
 * This way a failed null is retried tomorrow, where the delete is a harmless
 * no-op against an object that is already gone.
 */
async function reclaimOriginals(db: SupabaseClient, today: string): Promise<{
  deleted: number; bytesFreed: number; failed: string[]
}> {
  const { data, error } = await db
    .from('expenses')
    .select(`
      id, receipt_original, receipt_archived_at,
      shows!inner(invoices(status, updated_at, payments(paid_on)))
    `)
    .not('receipt_original', 'is', null)
    .not('receipt_archived_at', 'is', null)
    .limit(DELETE_BATCH)
  if (error) return { deleted: 0, bytesFreed: 0, failed: [error.message] }

  const rows: RetentionRow[] = (data ?? []).map((r) => {
    const invoice = r.shows?.invoices ?? null
    const paidDates: string[] = (invoice?.payments ?? []).map((p: { paid_on: string }) => p.paid_on)
    return {
      expenseId: r.id,
      receiptOriginal: r.receipt_original,
      receiptArchivedAt: r.receipt_archived_at,
      invoiceStatus: invoice?.status ?? null,
      paidOn: paidDates.length ? paidDates.reduce((a, b) => (a > b ? a : b)) : null,
      invoiceUpdatedAt: invoice?.updated_at ?? null,
    }
  })

  const targets = deletable(rows, today)
  if (targets.length === 0) return { deleted: 0, bytesFreed: 0, failed: [] }

  const paths = targets.map((t) => t.receiptOriginal!) as string[]

  // Size is read BEFORE the delete, purely so the run can report what it
  // reclaimed. A failure here must not stop the delete.
  let bytesFreed = 0
  try {
    for (const path of paths) {
      const slash = path.lastIndexOf('/')
      const { data: listed } = await db.storage
        .from('receipts')
        .list(path.slice(0, slash), { search: path.slice(slash + 1) })
      bytesFreed += listed?.[0]?.metadata?.size ?? 0
    }
  } catch { /* reporting only */ }

  const { error: removeError } = await db.storage.from('receipts').remove(paths)
  if (removeError) return { deleted: 0, bytesFreed: 0, failed: [removeError.message] }

  // Only now is the column cleared — see the comment above on ordering.
  const { error: nullError } = await db
    .from('expenses')
    .update({ receipt_original: null })
    .in('id', targets.map((t) => t.expenseId))
  if (nullError) return { deleted: 0, bytesFreed, failed: [`files removed, rows not updated: ${nullError.message}`] }

  return { deleted: targets.length, bytesFreed, failed: [] }
}
```

Call it after `archiveOriginals` and add `reclaimed` to the JSON response
alongside `archive`.

- [ ] **Step 2: Prove the guard holds before trusting it**

Add a temporary `?dryRun=1` branch that runs the selection and returns what it
WOULD delete without touching anything. Hit it against production, confirm the
list is only long-settled shows and that every row has an
`receipt_archived_at`, then remove the branch.

- [ ] **Step 3: Verify**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: 229 pass, both clean.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/reminders/route.ts
git commit -m "Reclaim originals that are paid, settled and verified in Dropbox"
```

---

## Verification for the whole plan

- `npm test` — 229 passing.
- `npx tsc --noEmit` and `npm run build` clean.
- `grep -rn "DROPBOX_" --include="*.ts*" . | grep -v node_modules` — hits only in
  `app/api/cron/reminders/route.ts`, no `NEXT_PUBLIC_`.
- The zip export produces an archive that opens in Finder with readable names.
- After a night: files under `/Apps/{app}/receipts/{year}/{show}/`, the show
  page's archived count climbing, cron `archive.failed` empty.
- Nothing in `receipt_path` ever changes. Confirm with a count of non-null
  `receipt_path` before and after.

## Blast radius

Tasks 1–4 and 6 are new pure modules with no caller until wired — zero risk.
Task 5 is an additive migration. Task 7 only ever writes a timestamp. **Task 8
is the only one that destroys anything**, it runs last, it is gated on a
verified copy, and it cannot touch a row whose `receipt_archived_at` is null.
