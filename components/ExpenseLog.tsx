'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatAmount, formatUSD, parseUSD } from '@/lib/money'
import { formatDateShort, todayInChicago } from '@/lib/dates'
import { CATEGORY_LABEL, CATEGORY_ORDER, expensesMissingReceipts, type ExpenseCategory } from '@/lib/expenses'
import { scaleToFit, contrastBounds, buildLut, JPEG_QUALITY } from '@/lib/receiptImage'
import { addExpense, deleteExpense, extractReceipt, listShowOriginals } from '@/app/expenses/actions'
import {
  dropExactRepeats, duplicateOf, markDuplicates, type NamedCandidate,
} from '@/lib/receiptDuplicates'
import { archiveNames, sanitizeSegment } from '@/lib/receiptArchiveName'
import { buildZip, type ZipEntry } from '@/lib/zipStore'
import type { ReceiptFields } from '@/lib/receiptExtraction'
import { FIELD_FULL } from '@/components/ui/field'
import Select from '@/components/ui/Select'

type Row = {
  id: string
  category: ExpenseCategory
  where_spent: string
  amount_cents: number
  spent_on: string
  receipt_path: string | null
  receipt_original: string | null
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
 */
async function enhance(file: File): Promise<Blob> {
  let canvas: HTMLCanvasElement
  let width: number
  let height: number

  if (isPdf(file)) {
    canvas = await pdfFirstPageToCanvas(file)
    width = canvas.width
    height = canvas.height
  } else {
    const bitmap = await createImageBitmap(file)
    ;({ width, height } = scaleToFit(bitmap.width, bitmap.height))
    canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const c = canvas.getContext('2d')
    if (!c) throw new Error('This browser cannot process images.')
    c.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images.')

  const image = ctx.getImageData(0, 0, width, height)
  const px = image.data

  // Rec. 601 luma, then a histogram of it.
  const histogram = new Array(256).fill(0)
  const grey = new Uint8ClampedArray(px.length / 4)
  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
    grey[g] = v
    histogram[Math.round(v)]++
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
 */
async function uploadReceiptPair(
  supabase: ReturnType<typeof createClient>,
  showId: string,
  file: File,
  onStep: (s: string) => void,
): Promise<{ error: string } | { enhancedPath: string; originalPath: string }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const base = `${user.id}/${showId}/${stamp}`

  onStep(isPdf(file) ? 'Reading the PDF…' : 'Processing the photo…')
  const enhanced = await enhance(file)

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
   * Reads a just-picked file: enhance, upload both copies, then OCR.
   *
   * The ONLY caller is the file input's onChange, below. No useEffect may
   * ever key this off form state (category, whereSpent, amount, spentOn) —
   * that is the plausible-looking future edit that turns one photo pick into
   * a paid API call per keystroke.
   *
   * The OCR call deliberately runs outside useTransition, in its own state
   * (`ocrNote`), so it never contributes to `pending` and never gates the
   * Add button — a receipt that fails to read must never block recording
   * the expense. Uploads finish first, so Add is already usable (once
   * `capture` is set) while OCR is still going in the background.
   */
  async function onPickFile(f: File | null) {
    // Whatever was previously picked (uploaded or still in flight) is
    // superseded now, whether or not a new file follows it.
    if (capture) removeSuperseded([capture.enhancedPath, capture.originalPath])
    setCapture(null)
    setOcrNote(null)
    // A stale error from a previous failed save (or a previous failed
    // upload) must not sit in the alert paragraph forever once the user has
    // moved on to a new pick — see the enhance/upload failure below, which
    // now writes here instead of to ocrNote.
    setError(null)

    tokenRef.current += 1
    const myToken = tokenRef.current
    if (!f) return

    const supabase = createClient()
    setUploading(true)
    let uploaded: { error: string } | { enhancedPath: string; originalPath: string }
    try {
      uploaded = await uploadReceiptPair(supabase, showId, f, (s) => {
        if (myToken === tokenRef.current) setOcrNote(s)
      })
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

  /** What a batch row can be a repeat OF, from the show's side. */
  function existingCandidates(): NamedCandidate[] {
    return expensesRef.current.map((e) => ({
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
  const total = expenses.reduce((t, e) => t + e.amount_cents, 0)
  // Shared with billShows/expensesMissingReceipts (lib/expenses.ts) so this
  // count agrees with the billing gate about a blank (not just null) path.
  const missing = expensesMissingReceipts(expenses).length
  const originalsHeld = expenses.filter((e) => e.receipt_original !== null).length
  // Hard-coded until a later task adds receipt_archived_at to the expenses
  // table and the Dropbox archive step starts setting it — there is nothing
  // to count yet.
  const originalsArchived = 0

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

      // .slice() rather than the raw Uint8Array: TS types buildZip's return as
      // Uint8Array<ArrayBufferLike>, which admits a SharedArrayBuffer backing
      // store and so is not assignable to BlobPart. slice() always allocates a
      // fresh, non-shared buffer, which satisfies it.
      const blob = new Blob([buildZip(entries).slice()], { type: 'application/zip' })
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

  return (
    <section className="mb-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
        <h2 className="eyebrow">Expenses</h2>
        {expenses.length > 0 && (
          <p className="tabular text-sm text-muted">
            {formatUSD(total)}
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
                {!e.receipt_path && <span className="text-danger">needs a receipt</span>}
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
                      options={CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
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
        <div className="grid gap-2 sm:grid-cols-[8rem_1fr_7rem_9rem_auto] items-center mb-3">
          <Select
            ariaLabel="Category"
            value={category}
            disabled={locked || pending}
            onChange={(v) => {
              touchedRef.current.add('category')
              setCategory(v as ExpenseCategory)
            }}
            options={CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
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
          <input aria-label="Date" type="date" className={FIELD_FULL} value={spentOn}
                 disabled={locked || pending} onChange={(e) => {
                   touchedRef.current.add('date')
                   setSpentOn(e.target.value)
                 }} />
          <button type="button" onClick={add} disabled={locked || pending || uploading}
                  className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                             border border-line text-muted hover:text-ink disabled:opacity-40">
            {pending ? (step ?? 'Saving…') : uploading ? 'Uploading…' : '+ Add'}
          </button>

          <label className="sm:col-span-5 text-xs text-muted">
            {/* capture="environment" opens the camera directly on a phone, which
                is where a receipt actually gets photographed. `multiple` is what
                lets a dozen receipts from a trip be picked in one go — picking
                just one still lands in onPickFile below, untouched. */}
            <input type="file" accept="image/*,application/pdf" multiple disabled={locked || pending || uploading}
                   onChange={(e) => { void onPickFiles(e.target.files) }}
                   className="text-xs text-muted file:mr-3 file:px-3 file:py-1.5 file:rounded-field
                              file:border file:border-line file:bg-transparent file:text-muted
                              file:text-xs file:font-semibold file:uppercase file:tracking-wider
                              disabled:opacity-40" />
            {capture
              ? ` ${capture.file.name}${ocrNote ? ` — ${ocrNote}` : ''}`
              : (ocrNote ?? ' Photo or PDF. A receipt is required before this show can be billed.')}
          </label>
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
