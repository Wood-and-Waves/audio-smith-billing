'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatAmount, formatUSD, parseUSD } from '@/lib/money'
import { formatDateShort, todayInChicago } from '@/lib/dates'
import { CATEGORY_LABEL, CATEGORY_ORDER, expensesMissingReceipts, type ExpenseCategory } from '@/lib/expenses'
import { scaleToFit, contrastBounds, buildLut, JPEG_QUALITY } from '@/lib/receiptImage'
import { addExpense, deleteExpense, extractReceipt } from '@/app/expenses/actions'

type Row = {
  id: string
  category: ExpenseCategory
  where_spent: string
  amount_cents: number
  spent_on: string
  receipt_path: string | null
}

const field =
  'w-full px-3 py-2 bg-surface border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none disabled:opacity-50'

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
  type Capture = { file: File; enhancedPath: string; originalPath: string; token: number }
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
      setOcrNote(uploaded.error)
      return
    }

    const { enhancedPath, originalPath } = uploaded
    setCapture({ file: f, enhancedPath, originalPath, token: myToken })

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

  // Newest first, matching PmLog's ordering of its entries.
  const sorted = [...expenses].sort((a, b) => b.spent_on.localeCompare(a.spent_on))
  const total = expenses.reduce((t, e) => t + e.amount_cents, 0)
  // Shared with billShows/expensesMissingReceipts (lib/expenses.ts) so this
  // count agrees with the billing gate about a blank (not just null) path.
  const missing = expensesMissingReceipts(expenses).length

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
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That expense could not be saved.')
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

      <div className="grid gap-2 sm:grid-cols-[8rem_1fr_7rem_9rem_auto] items-center mb-3">
        <select aria-label="Category" className={field} value={category} disabled={locked || pending}
                onChange={(e) => {
                  touchedRef.current.add('category')
                  setCategory(e.target.value as ExpenseCategory)
                }}>
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
          ))}
        </select>
        <input aria-label="Where" className={field} placeholder="Where" value={whereSpent}
               disabled={locked || pending} onChange={(e) => {
                 touchedRef.current.add('vendor')
                 setWhereSpent(e.target.value)
               }} />
        <input aria-label="Amount" inputMode="decimal" placeholder="0.00"
               className={`${field} tabular text-right`} value={amount} disabled={locked || pending}
               onChange={(e) => {
                 touchedRef.current.add('amount')
                 setAmount(e.target.value)
               }} />
        <input aria-label="Date" type="date" className={field} value={spentOn}
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
              is where a receipt actually gets photographed. */}
          <input type="file" accept="image/*,application/pdf" disabled={locked || pending || uploading}
                 onChange={(e) => { void onPickFile(e.target.files?.[0] ?? null) }}
                 className="text-xs text-muted file:mr-3 file:px-3 file:py-1.5 file:rounded-field
                            file:border file:border-line file:bg-transparent file:text-muted
                            file:text-xs file:font-semibold file:uppercase file:tracking-wider
                            disabled:opacity-40" />
          {capture
            ? ` ${capture.file.name}${ocrNote ? ` — ${ocrNote}` : ''}`
            : (ocrNote ?? ' Photo or PDF. A receipt is required before this show can be billed.')}
        </label>
      </div>

      {locked && (
        <p className="text-xs text-muted mt-3">This show is billed, so expenses are locked.</p>
      )}
      {error && <p role="alert" className="text-xs text-danger mt-3">{error}</p>}
    </section>
  )
}
