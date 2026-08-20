'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatAmount, formatUSD, parseUSD } from '@/lib/money'
import { formatDateShort, todayInChicago } from '@/lib/dates'
import { CATEGORY_LABEL, CATEGORY_ORDER, expensesMissingReceipts, type ExpenseCategory } from '@/lib/expenses'
import { scaleToFit, contrastBounds, buildLut, applyContrastStretch, JPEG_QUALITY } from '@/lib/receiptImage'
import {
  addExpense, deleteExpense, extractReceipt, listShowOriginals, replaceExpenseReceipt,
  setExpenseBillable, signedReceiptUrls,
} from '@/app/expenses/actions'
import {
  dropExactRepeats, duplicateOf, markDuplicates, type NamedCandidate,
} from '@/lib/receiptDuplicates'
import { archiveNames, sanitizeSegment } from '@/lib/receiptArchiveName'
import { buildZipParts, type ZipEntry } from '@/lib/zipStore'
import type { ReceiptFields } from '@/lib/receiptExtraction'
import {
  type Quad, type GrayImage, scaleQuad, clampQuad, quadUsable,
} from '@/lib/receiptQuad'
import { DETECT_MAX_EDGE, detectReceiptQuad } from '@/lib/receiptCorners'
import { warpOutputSize, warpGray } from '@/lib/receiptWarp'
import { FIELD_FULL } from '@/components/ui/field'
import Select from '@/components/ui/Select'
import CornerAdjuster from '@/components/CornerAdjuster'

type Row = {
  id: string
  category: ExpenseCategory
  where_spent: string
  amount_cents: number
  spent_on: string
  receipt_path: string | null
  receipt_original: string | null
  // Arrives via migration 0019 — set only once an original's Dropbox copy is
  // verified by size and content hash. Necessary but not sufficient for
  // deletion: see the full mayDelete gate in lib/receiptRetention.ts.
  receipt_archived_at: string | null
  // false = Dan's own cost (per-diem meals): never billed, never blocks
  // billing. See migration 0025 and lib/expenses.ts.
  billable: boolean
}

/**
 * A row of the batch review list — a receipt picked as part of a group of
 * two or more, on its way through enhance -> upload -> OCR -> fill.
 *
 * Fields are named to match the single-receipt form's own state
 * (category/whereSpent/amount/spentOn), not the DB row above, since this is
 * what a human edits before Add all ever runs.
 */
type BatchRow = {
  id: string
  file: File
  /**
   * 'error' means the receipt uploaded but could not be READ — the photo is
   * attached and the fields need typing. 'upload-failed' means the receipt
   * itself never made it up, so the row will save without one. Two different
   * things to do about it, so two statuses.
   */
  status: 'queued' | 'reading' | 'read' | 'error' | 'upload-failed'
  category: ExpenseCategory
  whereSpent: string
  amount: string
  spentOn: string
  /** Mirrors Row's own field — true unless Dan ticks "Non-reimbursable" on this row. */
  billable: boolean
  /** Ticked rows are inserted by Add all; unticked ones are skipped and their upload cleaned up. */
  included: boolean
  /** Which earlier receipt this looks like a repeat of, named — or null. Kept even after a re-tick. */
  duplicateReason: string | null
  /** This row's OWN uploaded pair. Never shared with another row — see the trap in the design doc. */
  enhancedPath: string | null
  originalPath: string | null
  /**
   * Fields the user has personally edited, so a slow OCR read can't clobber a
   * hand correction. 'included' is in here for the same reason the four text
   * fields are: a row unticked while it was still queued would otherwise be
   * re-ticked by its own OCR landing a moment later, and re-ticked rows get
   * inserted.
   */
  touched: Set<'category' | 'vendor' | 'amount' | 'date' | 'included'>
}

/**
 * Short names for the category pickers. The long CATEGORY_LABEL wording
 * ("Meal Expenses") belongs to invoice lines, where it reads right; in an
 * 8rem dropdown trigger it truncates to "Meal Exp…", which is what made the
 * add form look clunky. Display-only — the invoice keeps the long wording.
 */
const CATEGORY_SHORT: Record<ExpenseCategory, string> = {
  meals: 'Meals', rides: 'Rides', baggage: 'Baggage', other: 'Other',
}

/** A small number in flight, not twelve — twelve createImageBitmap calls on 5MB photos exhausts a phone. */
const BATCH_CONCURRENCY = 3


/** Receipts arrive as photographs or as emailed PDFs. Both end up a JPEG. */
const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)

/** "vendor", "vendor and amount", "vendor, amount and date" — never an Oxford comma. */
function joinFieldNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Draws the first page of a PDF onto a canvas.
 *
 * Airlines, hotels and Amazon email a PDF, and that is the receipt Dan has —
 * so it has to become an image somewhere. It has to be HERE because
 * @react-pdf cannot embed one PDF inside another, and the receipt's whole
 * purpose is to reach the client attached to the invoice.
 *
 * pdf.js is imported dynamically: it is by far the largest thing this screen
 * can pull, and a photographed receipt must not pay for it.
 */
async function pdfFirstPageToCanvas(file: File): Promise<HTMLCanvasElement> {
  // The LEGACY build, deliberately — both here and for the worker.
  //
  // pdf.js 6's default build calls Map.prototype.getOrInsertComputed, a 2025
  // proposal method Safari does not implement. Uploading a PDF in Safari died
  // on "this.#rZ.getOrInsertComputed is not a function" before the file was
  // even read. The legacy bundle ships the core-js polyfill for it; the modern
  // one only calls it. Both the module and the worker need the legacy variant,
  // since the worker parses the document in its own realm and would otherwise
  // hit the same missing method with no polyfill in scope.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url,
  ).toString()

  // Destroy the loading TASK, not the document — that is what releases the
  // worker, and leaking one per receipt would accumulate across a trip.
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const doc = await task.promise
  try {
    const page = await doc.getPage(1)
    // Render at the target size directly. Rasterising at full scale and then
    // shrinking would cost memory for detail the downscale throws away.
    const base = page.getViewport({ scale: 1 })
    const { width, height } = scaleToFit(base.width, base.height)
    const viewport = page.getViewport({ scale: width / base.width })

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot process PDFs.')
    // A PDF page has no background of its own; without this it rasterises onto
    // transparency, which JPEG renders as black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
    return canvas
  } finally {
    await task.destroy()
  }
}

/**
 * The warp resamples one grayscale plane from the source photo at this cap on
 * its long edge -- 1.5x lib/receiptImage.ts's 1600 output cap, high enough
 * that flattening down to the output size still has real detail to resample
 * from, bounded so a 48MP phone photo can't blow phone memory with
 * BATCH_CONCURRENCY 3 of these in flight at once.
 */
const WARP_SOURCE_MAX_EDGE = 2400

/**
 * Draws `bitmap` onto a canvas capped to `maxEdge` on the long side and
 * converts it to a `GrayImage` via the same Rec. 601 luma expression -- and
 * the same Uint8ClampedArray-does-the-rounding treatment -- as the no-quad
 * path in `enhance` below; see the long comment there for why the array
 * store, not a separate Math.round, is what has to do the rounding.
 *
 * Sizing is `scaleToFit`'s never-enlarge math, just parameterized by
 * `maxEdge` instead of the fixed MAX_EDGE constant: detection wants a small
 * plane and the warp wants a much bigger one, and both need the same shape
 * of cap.
 */
function grayFromBitmap(bitmap: ImageBitmap, maxEdge: number): GrayImage {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images.')
  ctx.drawImage(bitmap, 0, 0, width, height)

  const px = ctx.getImageData(0, 0, width, height).data
  const data = new Uint8ClampedArray(px.length / 4)
  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    data[g] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
  }
  return { data, width, height }
}

/**
 * Encodes a `GrayImage` back to a JPEG blob -- the warp path's counterpart to
 * the RGBA canvas the no-quad path already has lying around. Same
 * Promise-wrapped toBlob and null-blob rejection as `enhance` uses below.
 */
function grayToJpeg(gray: GrayImage): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = gray.width
  canvas.height = gray.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images.')

  const image = ctx.createImageData(gray.width, gray.height)
  const px = image.data
  for (let i = 0, g = 0; g < gray.data.length; i += 4, g++) {
    const v = gray.data[g]
    px[i] = v
    px[i + 1] = v
    px[i + 2] = v
    px[i + 3] = 255
  }
  ctx.putImageData(image, 0, 0)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not process that photo.'))),
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
}

/**
 * Detects a receipt's four corners in `file`, normalized to 0..1 so the
 * result means the same thing regardless of which differently-sized gray
 * plane detection or the warp each end up working on -- see the quad path in
 * `enhance` below for the denormalize side of that trip. Photos only:
 * callers guarantee `file` isn't a PDF. Any thrown error (a browser declining
 * to decode the file) propagates for the caller to catch.
 */
async function detectCorners(file: File): Promise<Quad | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const gray = grayFromBitmap(bitmap, DETECT_MAX_EDGE)
    const quad = detectReceiptQuad(gray)
    return quad ? scaleQuad(quad, 1 / gray.width, 1 / gray.height) : null
  } finally {
    bitmap.close()
  }
}

/**
 * The adjuster's starting quad when detection finds nothing. Detection
 * failing means "not found with confidence", not "nothing to mark" -- a
 * generous 12% inset still lets Dan hand-drag the four handles onto a real
 * receipt, and "Use full photo" is one tap away if that's not worth doing.
 */
const INSET_QUAD: Quad = {
  tl: { x: 0.12, y: 0.12 },
  tr: { x: 0.88, y: 0.12 },
  br: { x: 0.88, y: 0.88 },
  bl: { x: 0.12, y: 0.88 },
}

/**
 * Downscale, grayscale and contrast-stretch, entirely in the browser.
 *
 * Done here rather than on the server for two reasons: a phone photo is 3-5MB
 * and exceeds Next's 1MB server-action body limit, and twelve untouched photos
 * make a PDF most mail servers reject. The maths lives in lib/receiptImage.ts
 * where it can be tested; this is only the canvas wiring.
 *
 * A born-digital PDF already spans the full range from white paper to black
 * text, so the contrast stretch computes to roughly the identity and leaves it
 * alone. The same path serves both without a special case.
 *
 * `quadNorm` is the corner tri-state: `undefined` auto-detects (the batch
 * path, which never confirms with Dan first and never passes an argument
 * here at all); `null` skips the warp outright (Dan picked "Use full photo",
 * or detection found nothing); a `Quad` is used only if `quadUsable`, else
 * treated as `null`. PDFs never see any of this -- the PDF branch below is
 * untouched -- and a warp that fails for its own reasons (degenerate quad,
 * output too small) falls through to the same no-quad path, so "corners not
 * confidently found" can never produce anything worse than today's plain
 * downscale.
 */
async function enhance(file: File, quadNorm?: Quad | null): Promise<Blob> {
  let canvas: HTMLCanvasElement
  let width: number
  let height: number

  if (isPdf(file)) {
    canvas = await pdfFirstPageToCanvas(file)
    width = canvas.width
    height = canvas.height
  } else {
    const bitmap = await createImageBitmap(file)
    try {
      let quad: Quad | null
      if (quadNorm === undefined) {
        // Auto-detect (the batch path): run detection on THIS bitmap's own
        // downscale rather than calling detectCorners(file), which would
        // decode the file a second time for no reason.
        const detectGray = grayFromBitmap(bitmap, DETECT_MAX_EDGE)
        const detected = detectReceiptQuad(detectGray)
        quad = detected ? scaleQuad(detected, 1 / detectGray.width, 1 / detectGray.height) : null
      } else {
        quad = quadNorm && quadUsable(quadNorm) ? quadNorm : null
      }

      if (quad) {
        const gray = grayFromBitmap(bitmap, WARP_SOURCE_MAX_EDGE)
        const pixelQuad = clampQuad(scaleQuad(quad, gray.width, gray.height), gray.width, gray.height)
        const warped = warpGray(gray, pixelQuad, warpOutputSize(pixelQuad))
        if (warped) {
          applyContrastStretch(warped)
          return grayToJpeg(warped)
        }
        // Degenerate quad or too-small output -- fall through to the
        // no-quad path below exactly as if nothing had been detected.
      }

      ;({ width, height } = scaleToFit(bitmap.width, bitmap.height))
      canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const c = canvas.getContext('2d')
      if (!c) throw new Error('This browser cannot process images.')
      c.drawImage(bitmap, 0, 0, width, height)
    } finally {
      bitmap.close()
    }
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images.')

  const image = ctx.getImageData(0, 0, width, height)
  const px = image.data

  // Rec. 601 luma, then a histogram of it.
  //
  // The histogram counts grey[g] AFTER the store, not a separately rounded copy
  // of the same float. Uint8ClampedArray rounds half-to-even and Math.round
  // rounds half-up, so counting Math.round(v) filed a pixel ending in .5 one
  // bucket away from the value the LUT is later indexed by on line 191. The
  // histogram is only read to find the contrast bounds, and MIN_SPAN absorbs a
  // single bucket, so this never showed — but a histogram that does not describe
  // the pixels it is derived from is a trap for whoever tunes this next.
  const histogram = new Array(256).fill(0)
  const grey = new Uint8ClampedArray(px.length / 4)
  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    grey[g] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
    histogram[grey[g]]++
  }

  const { lo, hi } = contrastBounds(histogram)
  const lut = buildLut(lo, hi)

  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    const v = lut[grey[g]]
    px[i] = v
    px[i + 1] = v
    px[i + 2] = v
  }
  ctx.putImageData(image, 0, 0)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not process that photo.'))),
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
}

/**
 * SHA-256 of a file's exact bytes, hex-encoded.
 *
 * Lives here rather than in lib/receiptDuplicates.ts because it needs the
 * browser's crypto — that module is pure and runs under plain `node --test`.
 * Run over every picked file BEFORE anything is uploaded, so an exact repeat
 * (the same photo picked twice from the roll) is dropped for free.
 */
async function hashFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** "HMS Host on 8/22" — what a flagged row names as the receipt it repeats. */
function candidateLabel(vendor: string | null, spentOn: string | null): string {
  const who = vendor && vendor.trim() ? vendor.trim() : 'that receipt'
  return spentOn ? `${who} on ${formatDateShort(spentOn)}` : who
}

/**
 * The amount a row currently holds, for duplicate comparison — or null.
 *
 * NOT `parseUSD(amount)` directly: parseUSD('') is 0, not null, and a blank
 * amount box (every row before its own OCR resolves) must never compare as
 * "a receipt for $0.00" — that would flag every still-reading row as a
 * repeat of the last one, which is worse than not checking at all.
 */
function rowAmountCents(amount: string): number | null {
  if (amount.trim() === '') return null
  return parseUSD(amount)
}

/**
 * Enhances and uploads both receipt copies, all-or-nothing.
 *
 * This block is UNCHANGED from what used to run inside add() — only moved.
 * It now runs at file-pick time rather than at Add time, so that by the time
 * Add is clicked the receipt already exists in Storage (or the pick already
 * failed and said so), instead of the upload racing the save.
 *
 * Both files BEFORE the row: a row pointing at a failed upload is a receipt
 * that looks present and cannot be opened, and a receipt is what makes an
 * expense billable.
 *
 * Together, not one after the other. The original is the untouched 3-5MB
 * capture and the enhanced copy a few hundred KB; uploaded in sequence the
 * wait is their sum, which on hotel wifi is long enough to look like the
 * page has hung.
 *
 * `quadNorm` passes straight through to `enhance` -- see its doc comment for
 * the tri-state. Batch callers pass nothing, which auto-detects.
 */
async function uploadReceiptPair(
  supabase: ReturnType<typeof createClient>,
  showId: string,
  file: File,
  onStep: (s: string) => void,
  quadNorm?: Quad | null,
): Promise<{ error: string } | { enhancedPath: string; originalPath: string }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const base = `${user.id}/${showId}/${stamp}`

  onStep(isPdf(file) ? 'Reading the PDF…' : 'Processing the photo…')
  const enhanced = await enhance(file, quadNorm)

  // The original keeps its own type. A PDF stored as .jpg downloads
  // with an extension that lies about its contents.
  const ext = isPdf(file) ? 'pdf' : 'jpg'
  const enhancedPath = `${base}-enhanced.jpg`
  const originalPath = `${base}-original.${ext}`

  onStep('Uploading the receipt…')
  const [up1, up2] = await Promise.all([
    supabase.storage.from('receipts')
      .upload(enhancedPath, enhanced, { contentType: 'image/jpeg' }),
    supabase.storage.from('receipts')
      .upload(originalPath, file, { contentType: file.type || 'image/jpeg' }),
  ])

  // Either failing means neither is kept: a half-uploaded pair would
  // leave a receipt that cannot be opened behind a billable expense.
  if (up1.error || up2.error) {
    await supabase.storage.from('receipts').remove(
      [up1.error ? null : enhancedPath, up2.error ? null : originalPath]
        .filter(Boolean) as string[],
    )
    return { error: (up1.error ?? up2.error)!.message }
  }

  return { enhancedPath, originalPath }
}

/**
 * Best-effort removal of a receipt pair nobody will ever attach to a row —
 * a superseded pick, or a pair whose OCR read lost the token race.
 *
 * An orphaned file in Storage costs nothing but a few hundred KB; this
 * project's established safe direction (see deleteExpense's own comment in
 * app/expenses/actions.ts) is to risk that over ever blocking on, or
 * surfacing, a cleanup failure.
 */
function removeSuperseded(paths: string[]) {
  const supabase = createClient()
  void supabase.storage.from('receipts').remove(paths).catch(() => {})
}

export default function ExpenseLog({
  showId, expenses, locked,
}: {
  showId: string
  expenses: Row[]
  locked: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // True only while a zip is being fetched and assembled — see exportOriginals.
  const [exporting, setExporting] = useState(false)
  // What the SAVE is doing right now (addExpense only — see `pending`
  // above). The upload no longer happens here; it happens at file pick.
  const [step, setStep] = useState<string | null>(null)

  const [category, setCategory] = useState<ExpenseCategory>('meals')
  const [whereSpent, setWhereSpent] = useState('')
  const [amount, setAmount] = useState('')
  const [spentOn, setSpentOn] = useState(todayInChicago())
  // Checked = Dan's own per-diem cost, never billed to the client — see
  // migration 0025. Defaults unchecked (billable) since most expenses are.
  // Reset to false after every successful Add, same as the fields above.
  const [myCost, setMyCost] = useState(false)

  // The picked file's already-uploaded receipt pair, ready to attach to the
  // next Add. Null until upload finishes; also null again the instant a new
  // file is picked, an upload fails, or a save consumes it.
  type Capture = { file: File; enhancedPath: string; originalPath: string }
  const [capture, setCapture] = useState<Capture | null>(null)
  // True only while enhance+upload are running (between pick and capture).
  // OCR, which runs after, deliberately does NOT set this — see onPickFile.
  const [uploading, setUploading] = useState(false)
  // Status line for the capture/OCR pipeline. Rendered under the file input,
  // NEVER in the role="alert" paragraph below — that paragraph means "your
  // expense was not saved" and nothing that happens before Add is clicked
  // may borrow it.
  const [ocrNote, setOcrNote] = useState<string | null>(null)

  // A just-picked photo waiting on Dan to confirm/adjust its corners before
  // anything uploads. `url` is an object URL for the adjuster's <img> --
  // revoked on every exit (confirm, cancel, or superseded by a new pick; see
  // onPickFile). `token` mirrors this pick's tokenRef value at pick time, so
  // the render below can refuse to show a stale adjuster even if some future
  // change stopped clearing it eagerly on supersession. Null means either
  // nothing is pending or the file was a PDF, which skips this entirely.
  const [pendingAdjust, setPendingAdjust] = useState<{
    file: File; url: string; quad: Quad; token: number
  } | null>(null)
  // Confirm, cancel and a superseding pick (all in onPickFile/the adjuster's
  // own callbacks below) already revoke pendingAdjust's object URL on their
  // own. The one exit none of them can reach is ExpenseLog itself unmounting
  // — a client-side navigation away from this show while a photo sits
  // unconfirmed in the adjuster — so this ref+effect pair exists solely to
  // catch THAT case at actual unmount, via a ref because an effect keyed on
  // pendingAdjust would also fire (harmlessly, but needlessly) on every
  // ordinary confirm/cancel transition alongside the explicit revoke calls.
  const pendingAdjustRef = useRef(pendingAdjust)
  useEffect(() => { pendingAdjustRef.current = pendingAdjust }, [pendingAdjust])
  useEffect(() => () => {
    if (pendingAdjustRef.current) URL.revokeObjectURL(pendingAdjustRef.current.url)
  }, [])

  // Fix-later: re-adjusting a SAVED expense's corners from its untouched
  // original. `file` is the original re-fetched from Storage (as a File, for
  // `enhance`); `url` is its object URL for the adjuster's <img>; `busy` is
  // true only while enhance+upload+replaceExpenseReceipt are in flight, so
  // Cancel/handles disable and the dialog stays open on a failure instead of
  // losing the pick. Same unmount-only leak guard as pendingAdjust above.
  const [fixLater, setFixLater] = useState<{
    expenseId: string; file: File; url: string; quad: Quad; busy: boolean
  } | null>(null)
  const fixLaterRef = useRef(fixLater)
  useEffect(() => { fixLaterRef.current = fixLater }, [fixLater])
  useEffect(() => () => {
    if (fixLaterRef.current) URL.revokeObjectURL(fixLaterRef.current.url)
  }, [])

  // Minted fresh on every file pick; an async result is applied only if it
  // still matches. This one mechanism covers three otherwise-separate races:
  // a pick superseded by a later pick, a save that landed while OCR was
  // still reading, and an upload pair that got rolled back after failing.
  const tokenRef = useRef(0)
  // Which fields the user has personally edited via their own onChange —
  // NOT which fields differ from their defaults. spentOn and category start
  // with real (non-empty) defaults, so "differs from default" would forever
  // block a receipt from correcting today's date or the guessed category;
  // "the user moved the control" is the only signal that means "hands off".
  const touchedRef = useRef<Set<'vendor' | 'amount' | 'date' | 'category'>>(new Set())

  // The review list, open only when two or more files were picked at once.
  // Null means "not in batch mode" — the single-file form above is what
  // renders. Non-null replaces it entirely until Add all or Cancel.
  const [batchRows, setBatchRows] = useState<BatchRow[] | null>(null)
  // How many of the just-picked files were dropped as exact byte-for-byte
  // repeats, before anything was uploaded. Told to Dan, never decided for him
  // beyond the drop itself — see lib/receiptDuplicates.ts.
  const [batchSkipped, setBatchSkipped] = useState(0)
  // Set once by Add all, then shown until the next batch pick clears it.
  const [batchSummary, setBatchSummary] = useState<{ added: number; total: number; failed: string[] } | null>(null)
  // Minted fresh for each batch pick and bumped by cancelBatch — the same
  // mechanism tokenRef gives the single-receipt flow above, for the same kind
  // of race. The worker pool closes over a local `rows` array and used to
  // consult nothing else, so Cancel stopped nothing: with nine of twelve still
  // queued, all nine went on enhancing, uploading and paying for a vision call
  // apiece. Their results then landed in `setBatchRows(prev => prev && …)`
  // updaters that no-op against null, so those pairs were recorded on no row
  // and deleted by nobody — two permanently orphaned objects each. The
  // design's "a failed delete is ignored" covers deletes that were ATTEMPTED;
  // these were never attempted at all.
  const batchTokenRef = useRef(0)
  // Add all is in flight. A ref and not `pending`, because `pending` is state:
  // it is only true once React has re-rendered, and two taps can both land
  // before that. See addAllBatch.
  const savingRef = useRef(false)

  /**
   * Reads a just-picked file. PDFs go straight to `beginUpload` -- the
   * adjuster only understands photos, and detection never runs on one (see
   * `detectCorners`'s own doc comment). A photo runs corner detection first
   * and stops at `pendingAdjust`: nothing uploads until Dan confirms,
   * adjusts, or explicitly skips via "Use full photo" -- see the render
   * below and `beginUpload`, which is the entire upload body this function
   * used to run inline before the adjuster existed.
   *
   * The ONLY caller is the file input's onChange, below. No useEffect may
   * ever key this off form state (category, whereSpent, amount, spentOn) —
   * that is the plausible-looking future edit that turns one photo pick into
   * a paid API call per keystroke.
   */
  async function onPickFile(f: File | null) {
    // Whatever was previously picked (uploaded, still uploading, or still
    // waiting on the adjuster) is superseded now, whether or not a new file
    // follows it. The adjuster's object URL is revoked HERE rather than in a
    // useEffect cleanup -- this is the one place a pick is superseded, so
    // there is nothing a separate effect would catch that this doesn't.
    if (capture) removeSuperseded([capture.enhancedPath, capture.originalPath])
    setCapture(null)
    if (pendingAdjust) URL.revokeObjectURL(pendingAdjust.url)
    setPendingAdjust(null)
    setOcrNote(null)
    // A stale error from a previous failed save (or a previous failed
    // upload) must not sit in the alert paragraph forever once the user has
    // moved on to a new pick — see the enhance/upload failure below, which
    // now writes here instead of to ocrNote.
    setError(null)

    tokenRef.current += 1
    const myToken = tokenRef.current
    if (!f) return

    if (isPdf(f)) {
      // PDFs never see the adjuster -- detectCorners assumes a photo.
      void beginUpload(f, null, myToken)
      return
    }

    const detected = await detectCorners(f).catch(() => null)
    if (myToken !== tokenRef.current) return // superseded while detecting
    // The fix-later adjuster opened while this detection ran: two overlaid
    // dialogs would fight for the screen, so the pick loses. Re-picking
    // after the other dialog closes recovers it.
    if (fixLaterRef.current) return
    setPendingAdjust({ file: f, url: URL.createObjectURL(f), quad: detected ?? INSET_QUAD, token: myToken })
  }

  /**
   * Enhances and uploads both receipt copies, then kicks off OCR -- the
   * entire body `onPickFile` used to run inline, unchanged apart from
   * `quadNorm` threading through to `uploadReceiptPair` and the token being
   * a parameter rather than a freshly-minted local. Callers: `onPickFile`
   * for a PDF (quadNorm always null, no adjuster involved) and the adjuster's
   * `onConfirm` below (quadNorm is whatever Dan confirmed, or null for "use
   * full photo").
   */
  async function beginUpload(f: File, quadNorm: Quad | null, myToken: number) {
    const supabase = createClient()
    setUploading(true)
    let uploaded: { error: string } | { enhancedPath: string; originalPath: string }
    try {
      uploaded = await uploadReceiptPair(supabase, showId, f, (s) => {
        if (myToken === tokenRef.current) setOcrNote(s)
      }, quadNorm)
    } catch (e) {
      uploaded = { error: e instanceof Error ? e.message : 'Could not process that file.' }
    } finally {
      setUploading(false)
    }

    if (myToken !== tokenRef.current) {
      // A newer pick (or a save) won the race while this was uploading. If
      // it actually finished, nobody will ever attach it — clean it up.
      if (!('error' in uploaded)) removeSuperseded([uploaded.enhancedPath, uploaded.originalPath])
      return
    }

    if ('error' in uploaded) {
      // An upload failure is not an OCR note — small muted text under the
      // file input is easy to miss, especially on a phone, and the expense
      // would go on to save receipt-less with nothing louder than that to
      // show for it. This is what the role="alert" paragraph is for. Add
      // stays enabled regardless: logging the amount now and attaching the
      // photo later is legitimate, so this must not block the save, only
      // announce that the photo itself didn't make it up.
      setError(uploaded.error)
      return
    }

    const { enhancedPath, originalPath } = uploaded
    setCapture({ file: f, enhancedPath, originalPath })

    setOcrNote('Reading the receipt…')
    try {
      const result = await extractReceipt(enhancedPath)
      if (myToken !== tokenRef.current) return // superseded, or already saved

      if ('error' in result) {
        // The action's own message — shown verbatim, per its doc comment in
        // app/expenses/actions.ts (e.g. a missing ANTHROPIC_API_KEY, named).
        setOcrNote(result.error)
        return
      }
      if (result.unreadable) {
        setOcrNote("Couldn't read that one — type it in.")
        return
      }

      const { fields } = result
      // Read separately from filledFields: typing all four fields before
      // attaching the photo — normal, since the amount is often noted
      // before it's photographed — means every field below is already
      // touched and none get written, even on a flawless read. Without
      // this, that case fell through to "Couldn't read that one", which
      // reads as an OCR failure and invites a re-shoot: another
      // multi-megabyte upload pair and another paid API call, for a
      // receipt that was read just fine the first time.
      const extractedAnything =
        fields.vendor !== null || fields.amountCents !== null
        || fields.spentOn !== null || fields.category !== null

      // Named, not just counted — the note below says exactly which fields
      // came from the photo. "Filled in from the photo — check it" used to
      // claim the whole form when only some fields were empty to fill, which
      // is what let a stale spentOn/category (now reset above on save, but
      // still possible mid-batch before Add) hide in plain sight next to a
      // note that implied the photo vouched for it too.
      const filledFields: string[] = []
      if (fields.vendor !== null && !touchedRef.current.has('vendor')) {
        setWhereSpent(fields.vendor)
        filledFields.push('vendor')
      }
      if (fields.amountCents !== null && !touchedRef.current.has('amount')) {
        setAmount(formatAmount(fields.amountCents))
        filledFields.push('amount')
      }
      if (fields.spentOn !== null && !touchedRef.current.has('date')) {
        setSpentOn(fields.spentOn)
        filledFields.push('date')
      }
      if (fields.category !== null && !touchedRef.current.has('category')) {
        setCategory(fields.category)
        filledFields.push('category')
      }

      setOcrNote(
        filledFields.length > 0
          ? `Filled in the ${joinFieldNames(filledFields)} — check the rest.`
          : extractedAnything
            ? 'Receipt read — your entries kept.'
            : "Couldn't read that one — type it in.",
      )
    } catch {
      if (myToken === tokenRef.current) setOcrNote("Couldn't read that one — type it in.")
    }
  }

  // The show's own expenses as of RIGHT NOW, read through a ref rather than
  // captured from the render the pick happened in. The list above keeps its ×
  // buttons live while a batch runs, so deleting an expense mid-batch used to
  // leave rows flagged as repeats of something that no longer exists — the
  // duplicate check has to see the same list Dan is looking at.
  const expensesRef = useRef(expenses)
  useEffect(() => { expensesRef.current = expenses }, [expenses])

  /** What a new receipt can be a repeat OF, from the show's side. */
  function existingCandidates(list = expensesRef.current): NamedCandidate[] {
    return list.map((e) => ({
      vendor: e.where_spent,
      amountCents: e.amount_cents,
      spentOn: e.spent_on,
      label: `${e.where_spent} on ${formatDateShort(e.spent_on)}, already on this show`,
    }))
  }

  function updateBatchRow(
    id: string,
    field: 'category' | 'vendor' | 'amount' | 'date',
    patch: Partial<BatchRow>,
  ) {
    setBatchRows((prev) => prev && prev.map((r) => (
      r.id === id ? { ...r, ...patch, touched: new Set(r.touched).add(field) } : r
    )))
  }

  function toggleBatchRow(id: string) {
    setBatchRows((prev) => prev && prev.map((r) => (
      r.id === id ? { ...r, included: !r.included, touched: new Set(r.touched).add('included') } : r
    )))
  }

  /**
   * Flips one row's my-cost tick. Not routed through updateBatchRow: that
   * function's `touched` set only exists to keep a slow OCR read from
   * clobbering a hand-typed field, and OCR never reads or writes billable —
   * there is nothing here for a re-read to race.
   */
  function toggleBatchBillable(id: string) {
    setBatchRows((prev) => prev && prev.map((r) => (
      r.id === id ? { ...r, billable: !r.billable } : r
    )))
  }

  /**
   * Runs one row through enhance -> upload pair -> extractReceipt -> fill,
   * exactly the order the single-file flow follows above — reusing
   * uploadReceiptPair and extractReceipt rather than any of it again.
   *
   * Every `setBatchRows` update here is functional and keyed by `id`, never
   * by array index or a captured row snapshot: rows finish in whatever order
   * their own upload+OCR happen to land in, not the order they were picked,
   * and a stale closure would silently discard whatever the user had already
   * typed into a field the OCR result was racing against.
   *
   * `token` is checked after every await. A stale one means Cancel ran while
   * this row was in flight, and this row stops where it stands.
   */
  async function runBatchRow(
    supabase: ReturnType<typeof createClient>, id: string, file: File, token: number,
  ) {
    const live = () => token === batchTokenRef.current
    if (!live()) return

    setBatchRows((prev) => prev && prev.map((r) => (r.id === id ? { ...r, status: 'reading' } : r)))

    let uploaded: { error: string } | { enhancedPath: string; originalPath: string }
    try {
      uploaded = await uploadReceiptPair(supabase, showId, file, () => {})
    } catch (e) {
      uploaded = { error: e instanceof Error ? e.message : 'Could not process that file.' }
    }

    if (!live()) {
      // Cancel landed while this pair was uploading. cancelBatch can only
      // delete pairs already recorded on a row, and this one never got that
      // far — this worker is the only thing that knows it exists.
      if (!('error' in uploaded)) removeSuperseded([uploaded.enhancedPath, uploaded.originalPath])
      return
    }

    if ('error' in uploaded) {
      // Not the same failure as an unreadable photo, and it must not read as
      // one. "Couldn't read — type it in" says the receipt is attached and
      // only the reading failed, so Dan types the vendor and amount and Add
      // all saves an expense with NO receipt — and the show cannot be billed
      // until the "needs a receipt" counter is noticed days later. The
      // single-receipt flow routes this to the role="alert" paragraph rather
      // than the muted note for exactly this reason; the row carries its own
      // status as well, because one alert paragraph cannot name twelve rows.
      setBatchRows((prev) => prev && prev.map((r) => (
        r.id === id ? { ...r, status: 'upload-failed' } : r
      )))
      setError(`${file.name}: ${uploaded.error}`)
      return
    }
    const { enhancedPath, originalPath } = uploaded
    setBatchRows((prev) => prev && prev.map((r) => (
      r.id === id ? { ...r, enhancedPath, originalPath } : r
    )))

    let fields: ReceiptFields | null = null
    let unreadable = true
    try {
      const result = await extractReceipt(enhancedPath)
      if (!('error' in result)) {
        fields = result.fields
        unreadable = result.unreadable
      }
    } catch {
      // fields stays null — falls through to the "couldn't read" branch below.
    }

    if (!live()) {
      // Cancel landed during the read. The pair above was recorded on the row
      // a moment ago, so cancelBatch has probably already removed it — but
      // "probably" is a render commit landing before the click, and an
      // orphaned pair is the thing being fixed here. Removing a path twice
      // costs nothing; each row's stamp is its own, so this can never touch
      // another row's pair.
      removeSuperseded([enhancedPath, originalPath])
      return
    }

    if (!fields || unreadable) {
      setBatchRows((prev) => prev && prev.map((r) => (r.id === id ? { ...r, status: 'error' } : r)))
      return
    }
    const read = fields

    // Duplicates: everything ABOVE this row in the batch (by position, not
    // completion order — the first occurrence keeps its place, same rule as
    // dropExactRepeats), plus every expense already on the show.
    setBatchRows((prev) => {
      if (!prev) return prev
      const index = prev.findIndex((r) => r.id === id)
      const earlierInBatch: NamedCandidate[] = prev.slice(0, index).map((r) => ({
        vendor: r.whereSpent || null,
        amountCents: rowAmountCents(r.amount),
        spentOn: r.spentOn || null,
        label: candidateLabel(r.whereSpent || null, r.spentOn || null),
      }))
      const match = duplicateOf(
        { vendor: read.vendor, amountCents: read.amountCents, spentOn: read.spentOn },
        [...earlierInBatch, ...existingCandidates()],
      )

      return prev.map((r) => {
        if (r.id !== id) return r
        return {
          ...r,
          status: 'read',
          category: read.category !== null && !r.touched.has('category') ? read.category : r.category,
          whereSpent: read.vendor !== null && !r.touched.has('vendor') ? read.vendor : r.whereSpent,
          amount: read.amountCents !== null && !r.touched.has('amount')
            ? formatAmount(read.amountCents) : r.amount,
          spentOn: read.spentOn !== null && !r.touched.has('date') ? read.spentOn : r.spentOn,
          // The tick gets the same protection as the four fields above. A row
          // unticked while it was still queued — one Dan recognises as already
          // logged, a blurry retake, a personal expense photographed by
          // mistake — had its own OCR landing seconds later put the tick back,
          // and Add all then inserted it. Silent, in a list of twelve.
          included: r.touched.has('included') ? r.included : match === null,
          duplicateReason: match,
        }
      })
    })
  }

  /**
   * The duplicate check, run once more after every row has been read.
   *
   * The check each row does as it finishes is what makes the warning appear
   * promptly, but it can only compare against rows that have already been read.
   * With three receipts in flight, a row that finishes early sees the rows above
   * it still blank — so two photographs of one receipt at positions 1 and 3 slip
   * through whenever 3 finishes first, which is exactly the case this feature
   * exists to catch.
   *
   * This pass walks by POSITION rather than by completion order, so it gives the
   * same answer every time. It only ever ADDS a flag: a row already flagged
   * keeps its flag and whatever Dan has since done with its tick.
   *
   * Returns the settled rows rather than setting them, because Add all needs
   * the ANSWER and not just the render — see addAllBatch, which re-runs this
   * over the rows as hand-typed and would otherwise insert the snapshot it
   * held before the check.
   */
  function settleRows(rows: BatchRow[]): BatchRow[] {
    const asCandidates: NamedCandidate[] = rows.map((r) => ({
      vendor: r.whereSpent || null,
      amountCents: rowAmountCents(r.amount),
      spentOn: r.spentOn || null,
      label: candidateLabel(r.whereSpent || null, r.spentOn || null),
    }))
    const matches = markDuplicates(asCandidates, existingCandidates())

    return rows.map((r, i) => {
      const match = matches[i]
      if (match === null || r.duplicateReason !== null) return r
      // Label it either way — but the tick is Dan's, not this pass's. If he
      // has already made his own decision about this row, a late settle
      // must not quietly reverse it.
      return {
        ...r,
        included: r.touched.has('included') ? r.included : false,
        duplicateReason: match,
      }
    })
  }

  function settleDuplicates() {
    setBatchRows((prev) => prev && settleRows(prev))
  }

  /** A worker pool of BATCH_CONCURRENCY, so twelve photos never decode at once. */
  function runBatch(rows: BatchRow[], token: number) {
    const supabase = createClient()
    let cursor = 0
    const worker = async () => {
      // The token, not just the cursor: `rows` is a local array that Cancel
      // cannot shorten, so this is what stops the queue.
      while (cursor < rows.length && token === batchTokenRef.current) {
        const row = rows[cursor]
        cursor += 1
        await runBatchRow(supabase, row.id, row.file, token)
      }
    }
    const workerCount = Math.min(BATCH_CONCURRENCY, rows.length)
    void Promise.all(Array.from({ length: workerCount }, worker))
      .catch(() => {
        // Nothing in runBatchRow throws today — it catches its own upload and
        // read failures. If that ever changes, a rejected worker leaves its
        // rows on 'queued', and Add all is disabled until every row is done:
        // the batch would be stranded with no way out but Cancel, throwing
        // away every upload and every paid read in it.
        setBatchRows((prev) => prev && prev.map((r) => (
          r.status === 'queued' || r.status === 'reading' ? { ...r, status: 'error' } : r
        )))
      })
      .then(() => { if (token === batchTokenRef.current) settleDuplicates() })
  }

  /**
   * Two or more files picked at once: hash them, drop exact repeats, open
   * the review list. The single-file input's own onPickFile is untouched and
   * is the only path a single pick ever takes — see onChange below.
   */
  async function onPickFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    const files = Array.from(fileList)
    if (files.length === 1) {
      void onPickFile(files[0])
      return
    }

    setError(null)
    setBatchSummary(null)

    // One at a time, not Promise.all. Twelve arrayBuffer() calls in flight is
    // 60MB of live buffers on the phone whose memory ceiling is the whole
    // reason BATCH_CONCURRENCY exists — spent before the bounded stage even
    // starts. Hashing is fast; the pick is not where the wait is.
    const withHashes: { file: File; hash: string }[] = []
    // The whole rest of the pick sits inside this, because the caller is
    // `void onPickFiles(...)`: anything that escapes here is an unhandled
    // rejection, and an unhandled rejection is a blank screen after picking
    // twelve photos.
    try {
      for (const [i, file] of files.entries()) {
        let hash: string
        try {
          hash = await hashFile(file)
        } catch {
          // A photo not yet materialised from iCloud throws NotReadableError
          // on read. Under Promise.all that one rejection took down the whole
          // pick — unhandled, since the caller is `void onPickFiles(...)`, so
          // nothing at all appeared on screen: no list, no error, no note.
          // One unreadable photo out of twelve killed the other eleven.
          //
          // A value nothing else can equal, so the file is kept and simply
          // cannot take part in exact-duplicate detection. It still gets a
          // row: enhance reads the file again and will say so if it is
          // genuinely unreadable.
          hash = `unhashable-${i}-${Math.random().toString(36).slice(2)}`
        }
        withHashes.push({ file, hash })
      }

      const { kept, dropped } = dropExactRepeats(withHashes)
      setBatchSkipped(dropped)

      const rows: BatchRow[] = kept.map(({ file }, i) => ({
        id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        status: 'queued',
        category: 'meals',
        whereSpent: '',
        amount: '',
        spentOn: todayInChicago(),
        // Inherits the form's "My cost" tick: ticking it and then snapping
        // eight per-diem receipts in one go must not silently bill all eight
        // to the client. Each row keeps its own checkbox, so the inherited
        // value is visible and correctable in the review list.
        billable: !myCost,
        included: true,
        duplicateReason: null,
        enhancedPath: null,
        originalPath: null,
        touched: new Set(),
      }))
      // A fresh token per batch, exactly as onPickFile mints one per pick.
      batchTokenRef.current += 1
      setBatchRows(rows)
      runBatch(rows, batchTokenRef.current)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read those files.')
    }
  }

  /**
   * Nothing is written until this runs. Ticked rows become ordinary
   * addExpense inserts, in order; unticked rows are never inserted, and
   * their upload — which only exists because OCR needed something to read —
   * is best-effort removed. A row's own paths only ever get deleted here or
   * by cancelBatch below, never a path belonging to any other row.
   *
   * A row that is NOT added keeps its place in the list, with its uploaded
   * pair. The list is the only place its amount can be typed, so clearing it
   * out from under "1 could not be added — HMS Host: enter an amount" left Dan
   * reading that next to an empty screen: recovering meant re-picking every
   * photo, re-uploading it and paying for the reads again.
   */
  function addAllBatch() {
    if (!batchRows) return
    // Synchronous, because `pending` is not — it only goes true once React has
    // re-rendered, and a double-tap lands two clicks before that. The second
    // pass would insert every row again, both copies pointing at the one
    // uploaded pair: two expenses sharing a receipt, where deleting either
    // takes the file the other depends on. add() bumps tokenRef before its own
    // transition for exactly this reason.
    if (savingRef.current) return
    savingRef.current = true
    setError(null)

    // The duplicate check once more, over what the rows now SAY rather than
    // what OCR read. Until here it ran only from the worker pool, so a receipt
    // that came back unreadable and was typed in by hand — the spec's "an
    // unreadable receipt is still an expense, it just needs typing" — was
    // never checked against anything at all. Two unreadable photos of one
    // receipt, typed identically, both went in unflagged. This is the one
    // moment a hand edit still matters, so this is where the check belongs.
    const settled = settleRows(batchRows)
    // Rows this pass has just flagged and unticked are HELD BACK, not dropped:
    // still in the list, upload intact, named in the summary. Flagging is as
    // far as the design goes — Dan decides whether the second identical $6
    // coffee was real, and ticking it says so.
    const heldBack = new Set(
      settled.filter((r, i) => (
        r.duplicateReason !== null && batchRows[i].duplicateReason === null && !r.included
      )).map((r) => r.id),
    )
    setBatchRows(settled)
    const intended = batchRows.filter((r) => r.included).length

    start(async () => {
      setStep('Saving…')
      // Rows that are finished with — inserted, or deliberately discarded.
      // Only these leave the list.
      const handled = new Set<string>()
      let added = 0
      const failed: string[] = []
      const toDelete: string[] = []
      let lost: string | null = null

      try {
        for (const row of settled) {
          const name = row.whereSpent.trim() || row.file.name

          if (heldBack.has(row.id)) {
            failed.push(`${name}: possibly a repeat of ${row.duplicateReason} — tick it to add it anyway`)
            continue
          }

          if (!row.included) {
            if (row.enhancedPath) toDelete.push(row.enhancedPath)
            if (row.originalPath) toDelete.push(row.originalPath)
            handled.add(row.id)
            continue
          }

          // Never a truthiness check on cents — parseUSD('') is 0, not null,
          // and rowAmountCents already turns a blank box into null for us.
          const cents = rowAmountCents(row.amount)
          if (cents === null || cents <= 0) {
            failed.push(`${name}: enter an amount`)
            continue
          }
          if (!row.whereSpent.trim()) {
            failed.push(`${name}: say where the money went`)
            continue
          }

          let result: Awaited<ReturnType<typeof addExpense>>
          try {
            result = await addExpense({
              showId,
              category: row.category,
              whereSpent: row.whereSpent,
              amountCents: cents,
              spentOn: row.spentOn,
              receiptPath: row.enhancedPath,
              receiptOriginal: row.originalPath,
              note: '',
              billable: row.billable,
            })
          } catch {
            // The ambiguity add() documents at length: a THROWN insert cannot
            // tell "never happened" from "committed and the response was
            // lost". Keeping this row for a retry would let a second expense
            // claim the pair a committed row may already own, so the row goes
            // and its pair stays behind. One re-pick beats one corrupted
            // receipt. Everything below it was never attempted and stays.
            handled.add(row.id)
            lost = name
            break
          }
          if ('error' in result) failed.push(`${name}: ${result.error}`)
          else {
            added += 1
            handled.add(row.id)
          }
        }
      } finally {
        if (toDelete.length) removeSuperseded(toDelete)

        const remaining = settled.filter((r) => !handled.has(r.id))
        setBatchRows(remaining.length > 0 ? remaining : null)
        // Same reason add() resets it: a my-cost tick left on would silently
        // carry into the next entry. Cleared only when the batch is done —
        // rows still in review keep the mode they inherited.
        if (remaining.length === 0) setMyCost(false)
        if (remaining.length === 0) setBatchSkipped(0)
        setBatchSummary({ added, total: intended, failed })
        if (lost) {
          setError(`${lost} may or may not have been saved — check the list before adding it again.`)
        }
        router.refresh()
        setStep(null)
        savingRef.current = false
      }
    })
  }

  /** Abandons the batch without saving anything, cleaning up whatever had already uploaded. */
  function cancelBatch() {
    if (!batchRows) return
    // Bumped FIRST, so it is already stale for every worker still in flight:
    // the queue stops advancing, and any pair that finishes uploading after
    // this line gets deleted by the worker that made it, since it is not on a
    // row yet and the sweep below cannot see it.
    batchTokenRef.current += 1
    const paths = batchRows.flatMap((r) => [r.enhancedPath, r.originalPath]).filter((p): p is string => p !== null)
    if (paths.length) removeSuperseded(paths)
    setBatchRows(null)
    setBatchSkipped(0)
  }

  // Newest first, matching PmLog's ordering of its entries.
  const sorted = [...expenses].sort((a, b) => b.spent_on.localeCompare(a.spent_on))
  // Split, not summed together: "Billable" is what the client eventually
  // sees on the invoice (expenseLines skips my-cost rows the same way), and
  // "My costs" is Dan's own per-diem money, which never reaches either.
  // `!== false` / `=== false`, not truthiness — same dropped-select reason
  // lib/expenses.ts gives at length: undefined must fail toward the OLD
  // behavior (billable), never silently toward my-cost.
  const billableTotal = expenses.reduce((t, e) => t + (e.billable !== false ? e.amount_cents : 0), 0)
  const myCostTotal = expenses.reduce((t, e) => t + (e.billable === false ? e.amount_cents : 0), 0)
  // Shared with billShows/expensesMissingReceipts (lib/expenses.ts) so this
  // count agrees with the billing gate about a blank (not just null) path.
  const missing = expensesMissingReceipts(expenses).length
  const originalsHeld = expenses.filter((e) => e.receipt_original !== null).length
  const originalsArchived = expenses.filter((e) => e.receipt_archived_at !== null).length

  function add() {
    setError(null)
    const cents = parseUSD(amount)
    if (cents === null || cents <= 0) { setError('Enter an amount.'); return }
    if (!whereSpent.trim()) { setError('Say where the money went.'); return }

    // Freeze what this Add attaches. Bumping the token here — before the
    // async save even starts — means an OCR read still in flight for this
    // same capture ("a save that landed mid-read") is guaranteed to find its
    // token stale by the time it resolves and will not silently rewrite a
    // field on whatever the NEXT expense turns out to be.
    const attached = capture
    tokenRef.current += 1

    start(async () => {
      try {
        setStep('Saving…')

        const result = await addExpense({
          showId, category, whereSpent, amountCents: cents, spentOn,
          receiptPath: attached?.enhancedPath ?? null,
          receiptOriginal: attached?.originalPath ?? null,
          note: '',
          billable: !myCost,
        })
        if ('error' in result) { setError(result.error); return }

        setWhereSpent('')
        setAmount('')
        // spentOn and category reset too, not just whereSpent/amount. Before
        // OCR they could only hold todayInChicago() or something Dan
        // personally chose, so carrying them into the next entry was a
        // convenience. Now they can hold the PREVIOUS receipt's OCR values,
        // and if the next photo's read comes back null for date or category
        // (which the extractor does on purpose when it isn't sure), that
        // stale value would silently ride along under a note that claims the
        // photo filled it in. A batch of receipts is common enough (a whole
        // trip's worth at once) that this is worth the retyping.
        setSpentOn(todayInChicago())
        setCategory('meals')
        // Same reasoning as spentOn/category just above: a my-cost tick left
        // on would silently carry into the next entry, quietly excluding an
        // ordinary billable expense from the client's invoice.
        setMyCost(false)
        // THE SHARP EDGE: clear the capture — file, both paths, the token
        // (already bumped above) and the touched set — right alongside the
        // fields already reset above. Leaving any of it would let the next
        // Add attach this SAME receipt_path to a second expense: two rows
        // pointing at one file, where deleteExpense on either removes the
        // file the other still depends on.
        setCapture(null)
        setOcrNote(null)
        touchedRef.current = new Set()
        router.refresh()
      } catch {
        // Unlike the `{ error }` return above — no row was created there, so
        // keeping `capture` for a retry is correct — this branch cannot tell
        // "the insert never happened" from "it committed and the response
        // was lost" (a dropped connection, an aborted fetch). Before this
        // guard, a retry after either kind of failure reused `capture`,
        // whose receipt_path/receipt_original a committed row can now
        // already own: Add again and a second row shares that same path
        // with the first (deleting either one deletes the file the other
        // depends on), or pick a new file and removeSuperseded deletes
        // objects the committed row still needs. Before this branch existed
        // a retry always uploaded a fresh pair with a new stamp, so two rows
        // could never share paths — clearing capture here restores that.
        // Losing the upload on a genuinely-failed save costs one re-pick;
        // reusing paths a committed row owns corrupts a receipt.
        setCapture(null)
        setOcrNote(null)
        setError('That expense may or may not have been saved — check the list before adding it again.')
      } finally {
        setStep(null)
      }
    })
  }

  function remove(id: string) {
    setError(null)
    start(async () => {
      const result = await deleteExpense(id)
      if ('error' in result) { setError(result.error); return }
      // The expense is gone either way — a storage warning here is not a
      // rollback, just Dan's heads-up that a receipt file was left behind.
      if (result.warning) setError(result.warning)
      router.refresh()
    })
  }

  /**
   * Flips a logged expense between billable and my-cost — the fix for typing
   * the wrong one at Add time, without deleting the row and re-uploading its
   * receipt. Same shape as remove() above: one call, same transition, same
   * alert paragraph for the error.
   */
  function toggleBillable(id: string, next: boolean) {
    setError(null)
    start(async () => {
      const result = await setExpenseBillable(id, next)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  /**
   * Re-fetches a saved expense's untouched original, re-detects its
   * corners, and opens the shared adjuster on it. Wrapped in `start` (same
   * `pending` the row buttons already disable on) purely so a second click
   * on this or any other row button can't fire while the fetch is still in
   * flight — nothing here updates a `pending`-gated row until `setFixLater`
   * at the very end.
   */
  function openFixLater(row: Row) {
    setError(null)
    start(async () => {
      const original = row.receipt_original
      if (!original) return // belt-and-suspenders: the button itself is gated on this

      const { urls, storageError } = await signedReceiptUrls([original])
      if (storageError) {
        setError("That receipt's original is no longer in storage.")
        return
      }
      const signedUrl = urls[original]
      if (!signedUrl) {
        setError("That receipt's original is no longer in storage.")
        return
      }

      let response: Response
      try {
        response = await fetch(signedUrl)
      } catch {
        setError("That receipt's original is no longer in storage.")
        return
      }
      if (!response.ok) {
        setError("That receipt's original is no longer in storage.")
        return
      }

      const blob = await response.blob()
      const file = new File([blob], 'original.jpg', { type: blob.type || 'image/jpeg' })
      const detected = await detectCorners(file).catch(() => null)
      // Mirror of onPickFile's guard: if the single-add adjuster mounted
      // while this fetch/detect ran, this tap loses rather than stacking a
      // second dialog on top of it.
      if (pendingAdjustRef.current) return
      setFixLater({
        expenseId: row.id, file, url: URL.createObjectURL(blob), quad: detected ?? INSET_QUAD, busy: false,
      })
    })
  }

  /**
   * The adjuster's confirm for fix-later: re-flatten the untouched original
   * with the (possibly hand-adjusted) quad, upload it under a NEW stamped
   * path — never upsert in place, so a half-failed swap can never leave the
   * row pointing at a half-written object — then swap it onto the row via
   * `replaceExpenseReceipt`. `busy` is local state, not `pending`/`start`:
   * the dialog must stay open and re-enable on a failure, which a shared
   * transition flag can't express per-dialog.
   */
  async function confirmFixLater(quad: Quad | null) {
    if (!fixLater) return
    const { expenseId, file, url } = fixLater
    setError(null)
    setFixLater((prev) => (prev ? { ...prev, busy: true } : prev))

    const supabase = createClient()
    let newPath: string
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not signed in.')
      const enhanced = await enhance(file, quad)
      newPath = `${user.id}/${showId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-adjusted-enhanced.jpg`
      const { error: uploadError } = await supabase.storage.from('receipts')
        .upload(newPath, enhanced, { contentType: 'image/jpeg' })
      if (uploadError) throw new Error(uploadError.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not process that photo.')
      setFixLater((prev) => (prev ? { ...prev, busy: false } : prev))
      return
    }

    const result = await replaceExpenseReceipt(expenseId, newPath)
    if ('error' in result) {
      // The row was never touched -- the freshly uploaded file is now an
      // orphan nobody will ever attach, same policy as removeSuperseded's
      // other callers.
      removeSuperseded([newPath])
      setError(result.error)
      setFixLater((prev) => (prev ? { ...prev, busy: false } : prev))
      return
    }

    URL.revokeObjectURL(url)
    setFixLater(null)
    router.refresh()
    // The expense is swapped either way -- a storage warning here is not a
    // rollback, same as remove()'s own handling of deleteExpense's warning.
    if (result.warning) setError(result.warning)
  }

  /**
   * Saves every original for this show as one zip.
   *
   * Deliberately a desktop action. The archive is tens of megabytes and the
   * point of it is to land in a folder, which is not a thing that happens
   * usefully on a phone over hotel wifi.
   *
   * Not wrapped in useTransition/`start`: that flag also gates the Add button
   * and the batch review list, and a five-minute download of eighty photos
   * has no reason to freeze either of those.
   */
  async function exportOriginals() {
    setExporting(true)
    setError(null)
    try {
      const result = await listShowOriginals(showId)
      if ('error' in result) { setError(result.error); return }
      if (result.originals.length === 0) {
        // This button only renders when originalsHeld > 0, so an empty list here
        // does NOT mean the show has no originals. It means listShowOriginals
        // could not sign a URL for a single one of them — it skips rows whose
        // object has gone from Storage — which is the one case actually worth
        // telling him about, and the old wording described the opposite.
        setError('This show’s originals are recorded, but none of their files could be fetched from storage.')
        return
      }

      const names = archiveNames(result.originals)
      const entries: ZipEntry[] = []
      const missed: string[] = []
      for (let i = 0; i < result.originals.length; i++) {
        const ref = result.originals[i]
        // A dead signed URL skips this receipt and keeps the rest — the same
        // policy listShowOriginals already applies on the server, where a row
        // with no object is dropped because "the rest of the show is still worth
        // saving". Throwing here contradicted that and discarded every byte
        // already downloaded, which for a tour is a long download to lose. It
        // also becomes likelier once the deletion stage exists and an original
        // can disappear under a page that is already open.
        let bytes: Uint8Array
        try {
          const response = await fetch(ref.signedUrl)
          if (!response.ok) { missed.push(names[i]); continue }
          bytes = new Uint8Array(await response.arrayBuffer())
        } catch {
          missed.push(names[i])
          continue
        }
        entries.push({ name: names[i], bytes, date: ref.spentOn })
      }

      if (entries.length === 0) {
        setError('None of this show’s originals could be downloaded. Nothing was saved.')
        return
      }

      // The parts, unconcatenated, straight into Blob. Measured for the 80 x 4MB
      // show the spec contemplates: the entry bytes are 320MB, buildZip copied
      // them into one buffer for 1280MB, and .slice() copied that again for
      // 1600MB — a copy that existed only to satisfy BlobPart, which rejects
      // Uint8Array<ArrayBufferLike> because that admits a SharedArrayBuffer
      // backing store. Blob takes the array of parts directly and does the
      // joining itself, so all three copies go. A twelve-receipt show was always
      // fine; a tour was going to OOM the tab.
      // The cast, and only a cast: BlobPart rejects Uint8Array<ArrayBufferLike>
      // because that admits a SharedArrayBuffer backing store. Nothing here is
      // shared — every part comes from a fresh Uint8Array — and unlike the
      // .slice() this replaces, a cast allocates nothing.
      const blob = new Blob(buildZipParts(entries) as BlobPart[], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${sanitizeSegment(result.showName, 'Show')} originals.zip`
      a.click()
      // Revoked on the next tick: revoking synchronously races the download in
      // Safari and produces an empty file.
      setTimeout(() => URL.revokeObjectURL(url), 0)

      // After the download starts, not instead of it. The zip is real and worth
      // keeping; this says which receipts are not in it, by the same name they
      // would have had inside it.
      if (missed.length > 0) {
        setError(`Saved ${entries.length} of ${result.originals.length}. Could not download: ${missed.join(', ')}.`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the archive.')
    } finally {
      setExporting(false)
    }
  }

  // The single-add form's repeat check, against the show's saved expenses —
  // the batch rows get the same treatment in markDuplicates. Over `expenses`
  // directly, not expensesRef: refs sync in an effect and would be one render
  // stale here. Warns and never blocks, same policy as the batch: matching
  // vendor, amount and date is strong evidence, not proof.
  const singleRepeat = duplicateOf(
    {
      vendor: whereSpent.trim() ? whereSpent : null,
      amountCents: rowAmountCents(amount),
      spentOn: spentOn || null,
    },
    existingCandidates(expenses),
  )

  return (
    <section className="mb-10">
      {/* Single-photo confirm screen. Guarded on the token too, not just
          on pendingAdjust being non-null: onPickFile already clears
          pendingAdjust (and revokes its object URL) the instant a new pick
          supersedes it, but this is the belt to that suspenders in case a
          future code path sets pendingAdjust without going through there. */}
      {pendingAdjust && pendingAdjust.token === tokenRef.current && (
        <CornerAdjuster
          src={pendingAdjust.url}
          initialQuad={pendingAdjust.quad}
          confirmLabel="Use these corners"
          onConfirm={(quad) => {
            const { file, url, token } = pendingAdjust
            URL.revokeObjectURL(url)
            setPendingAdjust(null)
            void beginUpload(file, quad, token)
          }}
          onCancel={() => {
            // Nothing uploaded yet, so this is revoke-and-clear only — never
            // setError, which means "your expense was not saved" and there
            // was no save attempt here to fail.
            URL.revokeObjectURL(pendingAdjust.url)
            setPendingAdjust(null)
          }}
        />
      )}

      {/* Fix-later: re-adjusting a saved expense's corners. Cancel is
          disabled by CornerAdjuster itself while busy, so this only ever
          runs between attempts -- never while a save is in flight. */}
      {fixLater && (
        <CornerAdjuster
          src={fixLater.url}
          initialQuad={fixLater.quad}
          confirmLabel="Save"
          busy={fixLater.busy}
          onConfirm={(quad) => void confirmFixLater(quad)}
          onCancel={() => {
            URL.revokeObjectURL(fixLater.url)
            setFixLater(null)
          }}
        />
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
        <h2 className="eyebrow">Expenses</h2>
        {expenses.length > 0 && (
          <p className="tabular text-sm text-muted">
            {/* The split — and its "Billable" label — appears only once a
                my-cost row exists. A show with none (every show, before this
                feature existed) reads exactly as before: just the total. */}
            {myCostTotal > 0
              ? `Billable ${formatUSD(billableTotal)} · Non-reimbursable ${formatUSD(myCostTotal)}`
              : formatUSD(billableTotal)}
            {missing > 0 && (
              <span className="text-danger">
                {' · '}{missing} {missing === 1 ? 'needs a receipt' : 'need receipts'}
              </span>
            )}
          </p>
        )}
      </div>

      {originalsHeld > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span className="text-xs text-muted">
            {originalsHeld} original{originalsHeld === 1 ? '' : 's'} — {originalsArchived} archived
          </span>
          <button
            type="button"
            onClick={() => void exportOriginals()}
            disabled={exporting}
            className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                       border border-line text-muted hover:text-ink disabled:opacity-40"
          >
            {exporting ? 'Building…' : 'Download originals'}
          </button>
        </div>
      )}

      {sorted.length === 0 ? (
        <p className="text-muted border-l-2 border-line pl-4 py-1 mb-4">No expenses yet.</p>
      ) : (
        <ul className="border-t border-line mb-4">
          {sorted.map((e) => (
            // Two deliberate lines rather than six columns: at 375px — a phone
            // in an airport, which is where this screen is actually used — six
            // fixed-width items wrap into ragged unaligned rows. Vendor and
            // amount are the headline; `basis-full` forces the rest beneath it
            // at every width instead of leaving the break to chance.
            <li key={e.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line py-2 text-sm">
              <span className="flex-1 min-w-0 truncate">{e.where_spent}</span>
              <span className="tabular shrink-0">{formatUSD(e.amount_cents)}</span>
              <button
                type="button"
                disabled={locked || pending}
                onClick={() => remove(e.id)}
                aria-label={`Remove ${e.where_spent}`}
                className="shrink-0 text-muted hover:text-danger transition-colors text-lg leading-none disabled:opacity-40"
              >
                ×
              </button>
              <span className="basis-full text-xs text-muted flex flex-wrap items-baseline gap-x-2">
                <span className="tabular">{formatDateShort(e.spent_on)}</span>
                <span>{CATEGORY_LABEL[e.category]}</span>
                {e.billable === false && (
                  <span className="text-[11px] font-bold uppercase tracking-wider text-muted
                                   bg-surface-2 rounded-field px-1.5 py-0.5">
                    Non-reimbursable
                  </span>
                )}
                {/* Danger only reaches a billable row — that is the one kind
                    of missing receipt that actually blocks billing. A
                    non-reimbursable row without one is a non-issue and says
                    nothing at all (Dan: "I understand what is happening"). */}
                {!e.receipt_path && e.billable !== false && (
                  <span className="text-danger">needs a receipt</span>
                )}
                <button
                  type="button"
                  disabled={locked || pending}
                  onClick={() => toggleBillable(e.id, !e.billable)}
                  aria-label={`${e.billable !== false ? 'Make non-reimbursable' : 'Make billable'}: ${e.where_spent}`}
                  className="underline hover:text-ink disabled:opacity-40"
                >
                  {e.billable !== false ? 'Make non-reimbursable' : 'Make billable'}
                </button>
                {/* PDFs skip detection entirely (see detectCorners), so this
                    only ever shows for a photo receipt still attached. */}
                {e.receipt_original && !e.receipt_original.endsWith('.pdf') && e.receipt_path && (
                  <button
                    type="button"
                    disabled={locked || pending}
                    onClick={() => openFixLater(e)}
                    aria-label={`Adjust corners: ${e.where_spent}`}
                    className="underline hover:text-ink disabled:opacity-40"
                  >
                    Adjust corners
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {batchRows ? (
        <div className="mb-3">
          {batchSkipped > 0 && (
            <p className="text-xs text-muted mb-2">
              {batchSkipped} {batchSkipped === 1 ? 'was' : 'were'} skipped — the same photo, picked twice.
            </p>
          )}

          {/* One card per receipt, not a table: at 375px six columns would not
              fit, so every field stacks full-width and only breathes into a
              row at sm: and up, matching the single-add grid below. */}
          <ul className="border-t border-line mb-3">
            {batchRows.map((row, i) => (
              <li key={row.id} className="border-b border-line py-3">
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={row.included}
                    disabled={locked || pending}
                    onChange={() => toggleBatchRow(row.id)}
                    aria-label={`Include ${row.whereSpent || row.file.name}`}
                    className="mt-3 h-4 w-4 shrink-0 accent-accent"
                  />
                  <div className="min-w-0 flex-1 grid gap-2 sm:grid-cols-[8rem_1fr_7rem_9rem] items-center">
                    <Select
                      ariaLabel={`Category for receipt ${i + 1}`}
                      value={row.category}
                      disabled={locked || pending}
                      onChange={(v) => updateBatchRow(row.id, 'category', { category: v as ExpenseCategory })}
                      options={CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_SHORT[c] }))}
                    />
                    <input aria-label={`Where for receipt ${i + 1}`} className={FIELD_FULL} placeholder="Where"
                           value={row.whereSpent} disabled={locked || pending}
                           onChange={(e) => updateBatchRow(row.id, 'vendor', { whereSpent: e.target.value })} />
                    <input aria-label={`Amount for receipt ${i + 1}`} inputMode="decimal" placeholder="0.00"
                           className={`${FIELD_FULL} tabular text-right`} value={row.amount}
                           disabled={locked || pending}
                           onChange={(e) => updateBatchRow(row.id, 'amount', { amount: e.target.value })} />
                    <input aria-label={`Date for receipt ${i + 1}`} type="date" className={FIELD_FULL}
                           value={row.spentOn} disabled={locked || pending}
                           onChange={(e) => updateBatchRow(row.id, 'date', { spentOn: e.target.value })} />
                  </div>
                </div>
                {/* Same `ml-6` indent as the status/duplicate lines below —
                    it lines up under the fields, past the include tick. */}
                <label className="ml-6 mt-1 flex items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={!row.billable}
                    disabled={locked || pending}
                    onChange={() => toggleBatchBillable(row.id)}
                    aria-label={`Non-reimbursable for receipt ${i + 1}`}
                    className="h-4 w-4 accent-accent"
                  />
                  Non-reimbursable
                </label>
                <p className="ml-6 mt-1 text-xs text-muted truncate">
                  {row.file.name}
                  {' — '}
                  {row.status === 'queued' && 'Queued…'}
                  {row.status === 'reading' && 'Reading…'}
                  {row.status === 'read' && 'Read'}
                  {row.status === 'error' && "Couldn't read — type it in"}
                  {/* Says the receipt is NOT attached, in the danger colour.
                      "Couldn't read" here would invite typing the amount and
                      adding a receiptless expense without knowing it. */}
                  {row.status === 'upload-failed' && (
                    <span className="text-danger">
                      Receipt didn&rsquo;t upload — this will save without one
                    </span>
                  )}
                </p>
                {row.duplicateReason && (
                  <p className="ml-6 mt-1 text-xs text-danger">
                    Possibly a repeat of {row.duplicateReason}.
                  </p>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={addAllBatch}
              disabled={locked || pending
                        || !batchRows.every((r) => r.status !== 'queued' && r.status !== 'reading')}
              className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                         border border-line text-muted hover:text-ink disabled:opacity-40"
            >
              {pending ? (step ?? 'Saving…') : 'Add all'}
            </button>
            <button
              type="button"
              onClick={cancelBatch}
              disabled={pending}
              className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-[8rem_1fr_7rem_9rem_auto] items-center mb-3">
          {/* Phone: a 2-col grid — category full width, then Where|Amount and
              Date|Add paired — instead of five stacked full-width fields. The
              sm layout is the original single row. */}
          <Select
            className="col-span-2 sm:col-span-1"
            ariaLabel="Category"
            value={category}
            disabled={locked || pending}
            onChange={(v) => {
              touchedRef.current.add('category')
              setCategory(v as ExpenseCategory)
            }}
            options={CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_SHORT[c] }))}
          />
          <input aria-label="Where" className={FIELD_FULL} placeholder="Where" value={whereSpent}
                 disabled={locked || pending} onChange={(e) => {
                   touchedRef.current.add('vendor')
                   setWhereSpent(e.target.value)
                 }} />
          <input aria-label="Amount" inputMode="decimal" placeholder="0.00"
                 className={`${FIELD_FULL} tabular text-right`} value={amount} disabled={locked || pending}
                 onChange={(e) => {
                   touchedRef.current.add('amount')
                   setAmount(e.target.value)
                 }} />
          {/* Date and Add share a private two-column row on phones (sm:contents
              dissolves it back into the outer grid). iOS paints type=date at
              its own intrinsic width regardless of the track it sits in —
              appearance-none makes it obey like a normal field, and the auto
              column keeps the button clear of it no matter what. */}
          <div className="col-span-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-center sm:contents">
            <input aria-label="Date" type="date" value={spentOn}
                   className={`${FIELD_FULL} min-w-0 appearance-none`}
                   disabled={locked || pending} onChange={(e) => {
                     touchedRef.current.add('date')
                     setSpentOn(e.target.value)
                   }} />
            <button type="button" onClick={add} disabled={locked || pending || uploading}
                    className="shrink-0 px-4 py-2 text-xs font-bold uppercase tracking-wider
                               rounded-field bg-accent-surface text-accent-ink disabled:opacity-50">
              {pending ? (step ?? 'Saving…') : uploading ? 'Uploading…' : '+ Add'}
            </button>
          </div>

          {singleRepeat && (
            <p className="col-span-2 sm:col-span-5 text-xs text-danger">
              Possibly a repeat of {singleRepeat}.
            </p>
          )}

          {/* One line, not two: the receipt picker and the non-reimbursable
              flag are both metadata of the same entry, and a lone checkbox row
              between the fields and the picker read as clutter. flex-wrap lets
              the flag drop under the picker on a narrow phone. */}
          <div className="col-span-2 sm:col-span-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <label className="text-xs text-muted">
            {/* capture="environment" opens the camera directly on a phone, which
                is where a receipt actually gets photographed. `multiple` is what
                lets a dozen receipts from a trip be picked in one go — picking
                just one still lands in onPickFile below, untouched. */}
            {/* The input is visually hidden and the button is our own span:
                the native control insists on printing "no files selected"
                next to its button, and that text can be hidden but never
                restyled or removed. The wrapping label keeps the whole thing
                clickable and the sr-only input keeps it keyboard-reachable. */}
            <input type="file" accept="image/*,application/pdf" multiple disabled={locked || pending || uploading}
                   onChange={(e) => { void onPickFiles(e.target.files) }}
                   className="sr-only peer" />
            <span className="inline-block mr-3 px-3 py-1.5 rounded-field border border-line
                             text-muted text-xs font-semibold uppercase tracking-wider cursor-pointer
                             peer-focus-visible:border-accent peer-disabled:opacity-40
                             peer-disabled:cursor-default">
              Choose files
            </span>
            {/* Just the format. The receipt REQUIREMENT is enforced by the
                red row hint and the billing gate at the moment it matters —
                repeating it here was one instruction too many (Dan). */}
            {capture
              ? ` ${capture.file.name}${ocrNote ? ` — ${ocrNote}` : ''}`
              : (ocrNote ?? ' Photo or PDF.')}
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={myCost}
              disabled={locked || pending}
              onChange={(e) => setMyCost(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            Non-reimbursable
          </label>
          </div>
        </div>
      )}

      {locked && (
        <p className="text-xs text-muted mt-3">This show is billed, so expenses are locked.</p>
      )}
      {batchSummary && (
        <p className="text-xs mt-3">
          <span className="text-muted">Added {batchSummary.added} of {batchSummary.total}.</span>
          {batchSummary.failed.length > 0 && (
            <span className="text-danger">
              {' '}{batchSummary.failed.length} could not be added — {batchSummary.failed.join('; ')}.
            </span>
          )}
        </p>
      )}
      {error && <p role="alert" className="text-xs text-danger mt-3">{error}</p>}
    </section>
  )
}
