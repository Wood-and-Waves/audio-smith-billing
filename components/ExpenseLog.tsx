'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatUSD, parseUSD } from '@/lib/money'
import { formatDateShort, todayInChicago } from '@/lib/dates'
import { CATEGORY_LABEL, CATEGORY_ORDER, expensesMissingReceipts, type ExpenseCategory } from '@/lib/expenses'
import { scaleToFit, contrastBounds, buildLut, JPEG_QUALITY } from '@/lib/receiptImage'
import { addExpense, deleteExpense } from '@/app/expenses/actions'

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
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url,
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
  // What the upload is doing right now. Processing a photo and pushing a few
  // megabytes takes long enough that a silent button reads as a hung page.
  const [step, setStep] = useState<string | null>(null)

  const [category, setCategory] = useState<ExpenseCategory>('meals')
  const [whereSpent, setWhereSpent] = useState('')
  const [amount, setAmount] = useState('')
  const [spentOn, setSpentOn] = useState(todayInChicago())
  const [file, setFile] = useState<File | null>(null)

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

    start(async () => {
      try {
        let receiptPath: string | null = null
        let receiptOriginal: string | null = null

        if (file) {
          const supabase = createClient()
          const { data: { user } } = await supabase.auth.getUser()
          if (!user) { setError('Not signed in.'); return }

          const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const base = `${user.id}/${showId}/${stamp}`

          setStep(isPdf(file) ? 'Reading the PDF…' : 'Processing the photo…')
          const enhanced = await enhance(file)

          // The original keeps its own type. A PDF stored as .jpg downloads
          // with an extension that lies about its contents.
          const ext = isPdf(file) ? 'pdf' : 'jpg'
          const enhancedPath = `${base}-enhanced.jpg`
          const originalPath = `${base}-original.${ext}`

          // Both files BEFORE the row: a row pointing at a failed upload is a
          // receipt that looks present and cannot be opened, and a receipt is
          // what makes an expense billable.
          //
          // Together, not one after the other. The original is the untouched
          // 3-5MB capture and the enhanced copy a few hundred KB; uploaded in
          // sequence the wait is their sum, which on hotel wifi is long enough
          // to look like the page has hung.
          setStep('Uploading the receipt…')
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
            setError((up1.error ?? up2.error)!.message)
            return
          }

          receiptPath = enhancedPath
          receiptOriginal = originalPath
        }

        setStep('Saving…')

        const result = await addExpense({
          showId, category, whereSpent, amountCents: cents, spentOn,
          receiptPath, receiptOriginal, note: '',
        })
        if ('error' in result) { setError(result.error); return }

        setWhereSpent('')
        setAmount('')
        setFile(null)
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
                onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
          ))}
        </select>
        <input aria-label="Where" className={field} placeholder="Where" value={whereSpent}
               disabled={locked || pending} onChange={(e) => setWhereSpent(e.target.value)} />
        <input aria-label="Amount" inputMode="decimal" placeholder="0.00"
               className={`${field} tabular text-right`} value={amount} disabled={locked || pending}
               onChange={(e) => setAmount(e.target.value)} />
        <input aria-label="Date" type="date" className={field} value={spentOn}
               disabled={locked || pending} onChange={(e) => setSpentOn(e.target.value)} />
        <button type="button" onClick={add} disabled={locked || pending}
                className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                           border border-line text-muted hover:text-ink disabled:opacity-40">
          {pending ? (step ?? 'Saving…') : '+ Add'}
        </button>

        <label className="sm:col-span-5 text-xs text-muted">
          {/* capture="environment" opens the camera directly on a phone, which
              is where a receipt actually gets photographed. */}
          <input type="file" accept="image/*,application/pdf" disabled={locked || pending}
                 onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                 className="text-xs text-muted file:mr-3 file:px-3 file:py-1.5 file:rounded-field
                            file:border file:border-line file:bg-transparent file:text-muted
                            file:text-xs file:font-semibold file:uppercase file:tracking-wider
                            disabled:opacity-40" />
          {file ? ` ${file.name}` : ' Photo or PDF. A receipt is required before this show can be billed.'}
        </label>
      </div>

      {locked && (
        <p className="text-xs text-muted mt-3">This show is billed, so expenses are locked.</p>
      )}
      {error && <p role="alert" className="text-xs text-danger mt-3">{error}</p>}
    </section>
  )
}
