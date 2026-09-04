'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatAmount, parseUSD } from '@/lib/money'
import { CATEGORY_LABEL, CATEGORY_ORDER, type ExpenseCategory } from '@/lib/expenses'
import { addExpense, extractReceipt, signedReceiptUrls } from '@/app/expenses/actions'
import {
  isPdf, detectCorners, INSET_QUAD, uploadReceiptPair, removeSuperseded,
} from '@/components/receiptCapture'
import { type Quad } from '@/lib/receiptQuad'
import { showForToday, pickerCandidates, type PickableShow } from '@/lib/showPicker'
import CornerAdjuster from '@/components/CornerAdjuster'
import Select from '@/components/ui/Select'
import { FIELD_FULL } from '@/components/ui/field'

/**
 * Snap a receipt from the mobile header.
 *
 * Design: docs/superpowers/specs/2026-08-22-snap-receipt-design.md
 *
 * The whole feature lives here — a header icon button that, in one tap,
 * resolves which show the receipt belongs to (a show page wins; otherwise
 * today's show; otherwise a picker), opens the camera, and runs the SAME
 * pipeline ExpenseLog uses (components/receiptCapture.ts — never re-inlined)
 * for exactly one file. Nothing is written until Dan taps Add on the confirm
 * screen; a dismissed confirm screen cleans up its own upload.
 *
 * State is one discriminated union (`Screen`) rather than ExpenseLog's several
 * independent pieces of state, because this feature only ever shows ONE
 * dialog at a time (unlike ExpenseLog, which can have the batch list, the
 * adjuster and a row's own fix-later dialog all relevant at once) — a single
 * `screen` variable makes "what's on top right now" unambiguous.
 */

type Capture = { enhancedPath: string; originalPath: string }

type ConfirmFields = {
  category: ExpenseCategory
  vendor: string
  amount: string
  spentOn: string
  /** Checked = Dan's own cost, never billed — mirrors ExpenseLog's `myCost`.
   *  Named for what the checkbox SAYS, not for what addExpense's `billable`
   *  field means, so `!fields.nonReimbursable` at submit time reads plainly
   *  as the inversion it is (same as ExpenseLog's `billable: !myCost`). */
  nonReimbursable: boolean
}

type ConfirmScreen = {
  kind: 'confirm'
  show: PickableShow
  /** The original file and the quad it was confirmed/skipped with — kept so
   *  "Change" can re-run the pipeline into the new show's folder without
   *  asking Dan to re-photograph anything. */
  file: File
  quad: Quad | null
  capture: Capture
  /** A signed URL for the just-uploaded enhanced image, or null if signing it
   *  failed — the receipt is safely uploaded either way, so a failed preview
   *  is not surfaced as an error, just an absent image. */
  imageUrl: string | null
  ocrNote: string | null
  fields: ConfirmFields
}

type Screen =
  | { kind: 'picker'; onChoose: (show: PickableShow) => void }
  /**
   * Saved, and offering the next shot. This screen exists for one reason:
   * iOS Safari only opens a file picker during live user activation, and the
   * gesture that tapped "Add + another" has expired by the time `addExpense`
   * resolves. Calling .click() from inside that async callback saves the
   * expense and then silently does nothing — the worst shape of bug, on the
   * one device this feature is FOR. So the next tap becomes the gesture.
   */
  | { kind: 'saved'; show: PickableShow }
  | { kind: 'adjust'; show: PickableShow; file: File; url: string; quad: Quad }
  | {
      kind: 'working'
      show: PickableShow
      file: File
      quad: Quad | null
      step: string
      error: string | null
      /** Set only when this upload is standing in for an existing confirm
       *  screen's capture (the "Change show" path): its `capture` gets
       *  cleaned up on success, and Cancel restores this exact screen rather
       *  than dropping back to nothing. Null for a first-time capture, where
       *  there is nothing yet to restore or supersede. */
      restoreTo: ConfirmScreen | null
    }
  | ConfirmScreen

/** /shows/{id}, not /shows or /shows/new — the one page this button can infer
 *  a show from without asking. */
const SHOW_PAGE = /^\/shows\/([^/]+)\/?$/

function currentShowIdFromPath(pathname: string | null): string | null {
  const m = pathname?.match(SHOW_PAGE)
  if (!m || m[1] === 'new') return null
  return m[1]
}

/** parseUSD('') is 0, not null — trim first so a blank box reads as "nothing
 *  entered" rather than "a receipt for $0.00". Same guard as ExpenseLog's
 *  own rowAmountCents. */
function amountCentsOf(amount: string): number | null {
  if (amount.trim() === '') return null
  return parseUSD(amount)
}

function defaultFields(today: string): ConfirmFields {
  return { category: 'meals', vendor: '', amount: '', spentOn: today, nonReimbursable: false }
}

export default function SnapReceipt({ shows, today }: { shows: PickableShow[]; today: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const [screen, setScreen] = useState<Screen | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const fileInputRef = useRef<HTMLInputElement>(null)
  // Which show the hidden input's next pick belongs to — set right before
  // .click(), read in onFilePicked. A ref, not state: the native picker is
  // OS-level and nothing renders off this in between.
  const pendingShowRef = useRef<PickableShow | null>(null)
  // Minted on every fresh pick and bumped whenever a capture is either
  // definitely spoken for (Add) or definitely abandoned (dismiss) — the same
  // single mechanism ExpenseLog's tokenRef uses to stop a slow OCR read from
  // rewriting a field after the moment it could still matter has passed.
  const tokenRef = useRef(0)
  // Shared across every dialog this component renders — only one is ever
  // mounted at a time, so one ref is enough. Same idiom as CornerAdjuster /
  // AddFlightDialog: focus lands on the panel on open so Escape reaches it.
  const panelRef = useRef<HTMLDivElement>(null)
  // Depends on the screen's KIND, not the screen object.
  //
  // `screen` is rebuilt on every keystroke (updateFields spreads a new object),
  // so watching it re-ran this effect per character and pulled focus out of
  // whatever input Dan was typing in. On iOS, focus leaving an input dismisses
  // the keyboard — so entering a merchant name by hand meant tapping the field
  // again after every single letter (2026-09-04). The intent was always "when a
  // panel opens, put focus in it", which is a kind-level event: picker ->
  // adjust -> working -> confirm. AddFlightDialog's copy of this idiom depends
  // on a boolean and never had the problem.
  useEffect(() => { if (screen) panelRef.current?.focus() }, [screen?.kind])

  function openFlow() {
    if (screen) return // already mid-flow; the button is disabled too, belt-and-suspenders
    setError(null)
    const onPageId = currentShowIdFromPath(pathname)
    const onPage = onPageId
      ? shows.find((s) => s.id === onPageId && s.status !== 'billed') ?? null
      : null
    const show = onPage ?? showForToday(shows, today)
    if (show) beginCapture(show)
    else setScreen({ kind: 'picker', onChoose: (s) => beginCapture(s) })
  }

  function beginCapture(show: PickableShow) {
    pendingShowRef.current = show
    setScreen(null)
    fileInputRef.current?.click()
  }

  async function onFilePicked(f: File | null) {
    if (fileInputRef.current) fileInputRef.current.value = ''
    const show = pendingShowRef.current
    if (!f || !show) return

    tokenRef.current += 1
    const myToken = tokenRef.current
    setError(null)

    if (isPdf(f)) {
      // PDFs never see the adjuster — detectCorners assumes a photo, same as
      // ExpenseLog's own onPickFile.
      void beginUpload(show, f, null, myToken)
      return
    }

    const detected = await detectCorners(f).catch(() => null)
    if (myToken !== tokenRef.current) return // superseded while detecting
    setScreen({ kind: 'adjust', show, file: f, url: URL.createObjectURL(f), quad: detected ?? INSET_QUAD })
  }

  /**
   * Enhance, upload the pair, then OCR — the entire beginUpload body
   * ExpenseLog runs, for one file. `restoreTo` is set only by "Change show":
   * on success its old capture is superseded and cleaned up and OCR is
   * skipped (the receipt hasn't changed, so a second paid read would be
   * money for nothing); on failure it travels into the error screen so
   * Cancel can put the old confirm screen back exactly as it was.
   */
  async function beginUpload(
    show: PickableShow, file: File, quad: Quad | null, myToken: number,
    restoreTo: ConfirmScreen | null = null,
  ) {
    setScreen({
      kind: 'working', show, file, quad, error: null, restoreTo,
      step: isPdf(file) ? 'Reading the PDF…' : 'Processing the photo…',
    })

    const supabase = createClient()
    let uploaded: Awaited<ReturnType<typeof uploadReceiptPair>>
    try {
      uploaded = await uploadReceiptPair(supabase, show.id, file, (s) => {
        if (myToken === tokenRef.current) {
          setScreen((cur) => (cur && cur.kind === 'working' ? { ...cur, step: s } : cur))
        }
      }, quad)
    } catch (e) {
      uploaded = { error: e instanceof Error ? e.message : 'Could not process that file.' }
    }

    if (myToken !== tokenRef.current) {
      // Superseded (dismissed, or Add already claimed a different capture)
      // while this was in flight. If it actually finished, nobody will ever
      // attach it.
      if (!('error' in uploaded)) removeSuperseded([uploaded.enhancedPath, uploaded.originalPath])
      return
    }

    if ('error' in uploaded) {
      setScreen((cur) => (cur && cur.kind === 'working' ? { ...cur, step: '', error: uploaded.error } : cur))
      return
    }

    // The new pair exists now, so the old one (if this was a show change) is
    // truly superseded — never delete it before the replacement is confirmed
    // uploaded, or a failed re-upload would strand Dan with neither copy.
    if (restoreTo) removeSuperseded([restoreTo.capture.enhancedPath, restoreTo.capture.originalPath])

    const capture: Capture = { enhancedPath: uploaded.enhancedPath, originalPath: uploaded.originalPath }
    const { urls } = await signedReceiptUrls([capture.enhancedPath])
    if (myToken !== tokenRef.current) {
      removeSuperseded([capture.enhancedPath, capture.originalPath])
      return
    }

    const confirmScreen: ConfirmScreen = {
      kind: 'confirm',
      show,
      file,
      quad,
      capture,
      imageUrl: urls[capture.enhancedPath] ?? null,
      ocrNote: restoreTo ? null : 'Reading the receipt…',
      fields: restoreTo?.fields ?? defaultFields(today),
    }
    setScreen(confirmScreen)
    if (restoreTo) return // Change: the receipt didn't change, so neither does the reading.

    try {
      const result = await extractReceipt(capture.enhancedPath)
      if (myToken !== tokenRef.current) return
      if ('error' in result || result.unreadable) {
        setScreen((cur) => (cur && cur.kind === 'confirm'
          ? { ...cur, ocrNote: 'error' in result ? null : "Couldn't read that one — type it in." }
          : cur))
        return
      }
      const read = result.fields
      setScreen((cur) => {
        if (!cur || cur.kind !== 'confirm') return cur
        return {
          ...cur,
          ocrNote: null,
          fields: {
            ...cur.fields,
            vendor: read.vendor ?? cur.fields.vendor,
            amount: read.amountCents !== null ? formatAmount(read.amountCents) : cur.fields.amount,
            spentOn: read.spentOn ?? cur.fields.spentOn,
            // Category is NOT filled from OCR — the confirm screen always
            // starts at the app's own default (per the design doc), never a
            // guess.
          },
        }
      })
    } catch {
      if (myToken === tokenRef.current) {
        setScreen((cur) => (cur && cur.kind === 'confirm'
          ? { ...cur, ocrNote: "Couldn't read that one — type it in." } : cur))
      }
    }
  }

  function cancelWorking() {
    if (!screen || screen.kind !== 'working') return
    tokenRef.current += 1
    setScreen(screen.restoreTo)
  }

  function changeShow(from: ConfirmScreen, to: PickableShow) {
    tokenRef.current += 1
    void beginUpload(to, from.file, from.quad, tokenRef.current, from)
  }

  /** Nothing was ever added: the upload this dialog was showing is an orphan
   *  nobody will attach — clean it up rather than leave storage nobody will
   *  ever look at. */
  function dismissConfirm() {
    if (!screen || screen.kind !== 'confirm') return
    removeSuperseded([screen.capture.enhancedPath, screen.capture.originalPath])
    tokenRef.current += 1
    setScreen(null)
    pendingShowRef.current = null
  }

  function updateFields(patch: Partial<ConfirmFields>) {
    setScreen((cur) => (cur && cur.kind === 'confirm' ? { ...cur, fields: { ...cur.fields, ...patch } } : cur))
  }

  function submit(andAnother: boolean) {
    if (!screen || screen.kind !== 'confirm') return
    const { show, capture, fields } = screen
    setError(null)

    const cents = amountCentsOf(fields.amount)
    if (cents === null || cents <= 0) { setError('Enter an amount.'); return }
    if (!fields.vendor.trim()) { setError('Say where the money went.'); return }

    // This capture is spoken for now. Bumped BEFORE the async save starts, so
    // an OCR read still landing for it is guaranteed stale and cannot rewrite
    // a field out from under a save already in flight — same reasoning as
    // ExpenseLog's add().
    tokenRef.current += 1

    start(async () => {
      let result: Awaited<ReturnType<typeof addExpense>>
      try {
        result = await addExpense({
          showId: show.id,
          category: fields.category,
          whereSpent: fields.vendor,
          amountCents: cents,
          spentOn: fields.spentOn,
          receiptPath: capture.enhancedPath,
          receiptOriginal: capture.originalPath,
          note: '',
          billable: !fields.nonReimbursable,
        })
      } catch {
        // Ambiguous — cannot tell "never happened" from "committed and the
        // response was lost". Keeping the confirm screen for a retry would
        // let a second Add attach this same receipt_path to a second
        // expense, so it goes rather than risk a corrupted receipt — same
        // trade ExpenseLog's own add() makes.
        setScreen(null)
        setError('That expense may or may not have been saved — check the show before adding it again.')
        return
      }
      if ('error' in result) { setError(result.error); return } // no row created; capture stays for retry

      if (andAnother) {
        // NOT beginCapture() — see the 'saved' screen's comment. The camera
        // has to open from a fresh tap, not from here.
        setScreen({ kind: 'saved', show })
        router.refresh()
      } else {
        setScreen(null)
        router.refresh()
      }
    })
  }

  return (
    <>
      <button
        type="button"
        aria-label="Snap a receipt"
        disabled={screen !== null}
        onClick={openFlow}
        className="p-2 text-ink disabled:opacity-40"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 8a2 2 0 0 1 2-2h1.7l1-1.5h6.6l1 1.5H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"
            stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
          />
          <circle cx="12" cy="13" r="3.4" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>

      {/* capture="environment" opens the camera directly, single file — this
          is a phone-and-a-show-floor control, not the multi-pick batch input
          ExpenseLog's own form keeps. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => { void onFilePicked(e.target.files?.[0] ?? null) }}
      />

      {screen?.kind === 'picker' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Choose a show"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setScreen(null) }}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            className="w-full max-w-sm max-h-[85vh] overflow-y-auto bg-bg border border-line rounded-field p-5 outline-none"
            onKeyDown={(e) => { if (e.key === 'Escape') setScreen(null) }}
          >
            <h2 className="eyebrow mb-4">Which show?</h2>
            {pickerCandidates(shows, today).length === 0 ? (
              <p className="text-sm text-muted mb-4">No open shows to pick from.</p>
            ) : (
              <ul className="border-t border-line mb-4">
                {pickerCandidates(shows, today).map((s) => (
                  <li key={s.id} className="border-b border-line">
                    <button
                      type="button"
                      onClick={() => screen.onChoose(s)}
                      className="w-full text-left py-3 text-sm text-ink hover:text-accent"
                    >
                      {s.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => setScreen(null)}
              className="text-xs text-muted hover:text-ink underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {screen?.kind === 'saved' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Receipt added"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setScreen(null) }}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            className="w-full max-w-sm bg-bg border border-line rounded-field p-5 outline-none"
            onKeyDown={(e) => { if (e.key === 'Escape') setScreen(null) }}
          >
            <h2 className="eyebrow mb-1">Added</h2>
            <p className="text-sm text-muted mb-5">{screen.show.name}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                // This tap IS the user activation the file input needs.
                onClick={() => beginCapture(screen.show)}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase
                           tracking-wider text-sm rounded-field hover:opacity-90 transition-opacity"
              >
                Take another
              </button>
              <button
                type="button"
                onClick={() => setScreen(null)}
                className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider
                           rounded-field border border-line text-muted hover:text-ink"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {screen?.kind === 'adjust' && (
        <CornerAdjuster
          src={screen.url}
          initialQuad={screen.quad}
          confirmLabel="Use these corners"
          onConfirm={(quad) => {
            const { show, file, url } = screen
            URL.revokeObjectURL(url)
            void beginUpload(show, file, quad, tokenRef.current)
          }}
          onCancel={() => {
            URL.revokeObjectURL(screen.url)
            setScreen(null)
            pendingShowRef.current = null
          }}
        />
      )}

      {screen?.kind === 'working' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Processing receipt"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && screen.error) cancelWorking() }}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            className="w-full max-w-sm bg-bg border border-line rounded-field p-5 outline-none"
            onKeyDown={(e) => { if (e.key === 'Escape' && screen.error) cancelWorking() }}
          >
            <h2 className="eyebrow mb-4">{screen.show.name}</h2>
            {screen.error ? (
              <>
                <p role="alert" className="text-sm text-danger border-l-2 border-danger pl-3 py-1 mb-4">
                  {screen.error}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void beginUpload(screen.show, screen.file, screen.quad, tokenRef.current, screen.restoreTo)}
                    className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase
                               tracking-wider text-sm rounded-field hover:opacity-90 transition-opacity"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={cancelWorking}
                    className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider
                               rounded-field border border-line text-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted">{screen.step}</p>
            )}
          </div>
        </div>
      )}

      {screen?.kind === 'confirm' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm receipt"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !pending) dismissConfirm() }}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            className="w-full max-w-sm max-h-[90vh] overflow-y-auto bg-bg border border-line rounded-field p-5 outline-none"
            onKeyDown={(e) => { if (e.key === 'Escape' && !pending) dismissConfirm() }}
          >
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 className="eyebrow truncate">{screen.show.name}</h2>
              <button
                type="button"
                disabled={pending}
                onClick={() => setScreen({ kind: 'picker', onChoose: (s) => changeShow(screen, s) })}
                className="shrink-0 text-xs text-muted hover:text-ink underline disabled:opacity-40"
              >
                Change
              </button>
            </div>

            {screen.imageUrl && (
              <img
                src={screen.imageUrl}
                alt=""
                className="w-full max-h-[42vh] object-contain rounded-field border border-line mb-4 bg-surface"
              />
            )}

            <div className="grid gap-2 mb-2">
              <Select
                ariaLabel="Category"
                value={screen.fields.category}
                disabled={pending}
                onChange={(v) => updateFields({ category: v as ExpenseCategory })}
                options={CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
              />
              <input
                aria-label="Where" className={FIELD_FULL} placeholder="Where" value={screen.fields.vendor}
                disabled={pending} onChange={(e) => updateFields({ vendor: e.target.value })}
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  aria-label="Amount" inputMode="decimal" placeholder="0.00"
                  className={`${FIELD_FULL} tabular`} value={screen.fields.amount} disabled={pending}
                  onChange={(e) => updateFields({ amount: e.target.value })}
                />
                <input
                  aria-label="Date" type="date" className={FIELD_FULL} value={screen.fields.spentOn}
                  disabled={pending} onChange={(e) => updateFields({ spentOn: e.target.value })}
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted mb-3">
              <input
                type="checkbox" checked={screen.fields.nonReimbursable} disabled={pending}
                onChange={(e) => updateFields({ nonReimbursable: e.target.checked })}
                className="h-4 w-4 accent-accent"
              />
              Non-reimbursable
            </label>

            {screen.ocrNote && <p className="text-xs text-muted mb-3">{screen.ocrNote}</p>}
            {error && <p role="alert" className="text-xs text-danger mb-3">{error}</p>}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button" onClick={() => submit(false)} disabled={pending}
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-field
                           bg-accent-surface text-accent-ink disabled:opacity-50"
              >
                {pending ? 'Saving…' : 'Add'}
              </button>
              <button
                type="button" onClick={() => submit(true)} disabled={pending}
                className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                           border border-line text-muted hover:text-ink disabled:opacity-40"
              >
                Add + another
              </button>
              <button
                type="button" onClick={dismissConfirm} disabled={pending}
                className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
