'use client'

import { useRef, useState } from 'react'
import { formatAmount, formatUSD } from '@/lib/money'
import { parseUSDMath } from '@/lib/moneyMath'
import { validateLegs, type SplitLegInput } from '@/lib/ledgerSplits'
import { FIELD_FULL } from '@/components/ui/field'
import CategoryPicker, { type CategoryPickerOption } from '@/components/CategoryPicker'

// The split leg editor (Wave C Task 4) — Dan's YNAB screenshot, adapted:
// expands inline beneath MoneyRegister's own edit row, on the SAME live
// gridTemplate that row (and every display row) already renders on, so a
// leg's category/note/amount land under their own headers exactly like
// every other field in this register. MoneyRegister owns the actual write
// (replaceSplits/unsplitTransaction, and — when the row is pending — the
// Approve-on-save enterTransactions call, the design doc's own screenshot
// behavior): this component is deliberately dumb about persistence, the
// same boundary CategoryPicker's own onChange keeps. `onSave` is only ever
// called with a leg set validateLegs has already accepted (zero legs is its
// own accepted case — the unsplit path) or, for the "at least 2" / "must be
// nonzero" / "must sum exactly" refusals, never called at all: the Save/
// Approve button stays disabled until validateLegs returns null.
//
// One leg row = one CategoryPicker (the category column), one note input
// (the memo column), and ONE amount box matching the `direction` prop —
// the edit session's own direction, outflow stays outflow and inflow stays
// inflow for every leg (validateLegs' own sign rule) — the opposite box is
// never rendered at all here, not merely disabled, since there is nothing
// for it to hold. A live "Amount remaining" row runs the same
// parent-|amount|-minus-legs math as the gate itself, via parseUSDMath per
// box, same as every other amount field in this register (parseAmountBoxes'
// own evaluator).

export type SplitEditorSeedLeg = {
  categoryId: string | null
  amountCents: number
  note: string | null
}

type DraftLeg = {
  /** A client-only key (never sent anywhere) — replace_transaction_splits
   *  deletes and re-inserts the whole leg set wholesale, so a leg never
   *  needs a stable server id to round-trip through this editor. */
  key: number
  /** '' = uncategorized, CategoryPicker's own convention. */
  categoryId: string
  /** Raw text in the one box that matches the parent's direction. */
  amount: string
  note: string
}

/** Seeds a fresh 2-leg draft: leg 1 keeps the row's own (about-to-be-split)
 *  category at the transaction's full amount, leg 2 starts blank — Dan
 *  carves the second category out of leg 1 by typing an amount in leg 2 and
 *  editing leg 1's down to match; the remaining line reads $0.00 the
 *  instant they agree. Only MoneyRegister's "Split…" pinned row (a
 *  never-yet-split transaction) uses this — an already-split row instead
 *  seeds every real leg via `seedLegsFromRow` below. */
export function freshSplitSeed(currentCategoryId: string | null, parentAmountCents: number): SplitEditorSeedLeg[] {
  return [
    { categoryId: currentCategoryId, amountCents: parentAmountCents, note: null },
    { categoryId: null, amountCents: 0, note: null },
  ]
}

function draftFromSeed(seed: SplitEditorSeedLeg[], nextKey: () => number): DraftLeg[] {
  const legs = seed.length > 0 ? seed : [
    { categoryId: null, amountCents: 0, note: null },
    { categoryId: null, amountCents: 0, note: null },
  ]
  return legs.map((leg) => ({
    key: nextKey(),
    categoryId: leg.categoryId ?? '',
    amount: leg.amountCents === 0 ? '' : formatAmount(Math.abs(leg.amountCents)),
    note: leg.note ?? '',
  }))
}

export default function SplitEditor({
  parentAmountCents,
  parentAmountHint,
  direction,
  seedLegs,
  categoryOptions,
  pending,
  approveOnSave,
  gridTemplate,
  desktop,
  onSave,
  onCancel,
}: {
  /** The signed amount the edit session's own Outflow/Inflow boxes
   *  currently hold (2026-08-25 — the opposite of this prop's original
   *  contract, deliberately: Dan types the new total and splits it in the
   *  SAME session, "that is how YNAB works", and MoneyRegister's saveSplit
   *  now persists boxes + legs in one atomic call, so the boxes ARE the
   *  total these legs must reconcile to). null while the boxes are blank
   *  or invalid — Save disables with the boxes' own refusal message until
   *  they hold exactly one positive amount. */
  parentAmountCents: number | null
  /** The refusal parseAmountBoxes gave for the edit boxes whenever
   *  parentAmountCents is null — shown as the hint, so Save's disablement
   *  explains itself in the boxes' own words ('Enter an amount.' for a
   *  typed 0, not the generic pick-a-box line). */
  parentAmountHint?: string | null
  /** Which box every leg here gets — the edit boxes' own direction, falling
   *  back to the row's saved sign while they're blank/invalid (so the leg
   *  boxes never jump sides mid-keystroke). MoneyRegister computes it
   *  beside parentAmountCents; separate props because direction stays
   *  well-defined even while the amount is momentarily null. */
  direction: 'outflow' | 'inflow'
  seedLegs: SplitEditorSeedLeg[]
  categoryOptions: readonly CategoryPickerOption[]
  pending: boolean
  /** True when the row is UNREVIEWED (entered_at null, migration 0042) — the
   *  Save button reads "Approve" instead, Dan's own screenshot button. Not
   *  "pending": that word means UNCLEARED here, the bank's axis, and the
   *  `pending` prop right above is this component's unrelated busy flag.
   *  MoneyRegister is the one that actually calls enterTransactions after
   *  a successful onSave; this component only relabels. */
  approveOnSave: boolean
  gridTemplate: string
  /** true for the sm+ copy (the live resizable template via `style`), false
   *  for the phone copy (the register's other 2-col stacked idiom) — same
   *  two-literal-copies split as MoneyRegister's own renderEditRow, for the
   *  same reason (a `style` attribute always wins over a class). */
  desktop: boolean
  /** Called ONLY with a leg set validateLegs has already accepted (`[]`
   *  included — that's the unsplit path, MoneyRegister routes it to
   *  unsplitTransaction). */
  onSave: (legs: SplitLegInput[]) => void
  onCancel: () => void
}) {
  const keyRef = useRef(0)
  function nextKey(): number {
    keyRef.current += 1
    return keyRef.current
  }
  const [legs, setLegs] = useState<DraftLeg[]>(() => draftFromSeed(seedLegs, nextKey))

  function updateLeg(key: number, patch: Partial<DraftLeg>) {
    setLegs((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  function removeLeg(key: number) {
    setLegs((prev) => prev.filter((l) => l.key !== key))
  }
  function addLeg() {
    setLegs((prev) => [...prev, { key: nextKey(), categoryId: '', amount: '', note: '' }])
  }

  // Every leg's typed amount, via parseUSDMath — the SAME evaluator every
  // other amount box in this register reads through (onOutflowChange's own
  // header comment). A blank box reads as 0 (parseUSDMath's own contract),
  // so a freshly-added, not-yet-typed leg contributes nothing to Remaining
  // rather than poisoning it to NaN.
  const parsedAmounts = legs.map((l) => parseUSDMath(l.amount))
  // null while the edit boxes above hold no valid amount — there is no
  // total to reconcile against yet, so the remaining line shows an em dash
  // and the hint below carries the boxes' own message instead of a phantom
  // dollar figure (the pre-2026-08-25 bug: a freshly-typed total the row
  // hadn't saved yet made this read "−$400.00 remaining" against the stale
  // saved amount).
  const remainingCents = parentAmountCents === null
    ? null
    : Math.abs(parentAmountCents)
      - parsedAmounts.reduce((sum: number, v) => sum + (v ?? 0), 0)

  // The exact leg set onSave would receive right now — signed to the
  // PARENT's direction (never the leg's own typed sign; there isn't one,
  // the box already fixes it), an unparseable box's amount going through as
  // NaN so validateLegs' own `!Number.isInteger` check refuses it with the
  // same "enter a nonzero amount" message a blank box gets, rather than a
  // silently-wrong 0 that could pass the sum check by accident.
  function preparedLegs(): SplitLegInput[] {
    return legs.map((l, i) => {
      const magnitude = parsedAmounts[i] ?? NaN
      return {
        categoryId: l.categoryId || null,
        amountCents: direction === 'outflow' ? -magnitude : magnitude,
        note: l.note.trim() || null,
      }
    })
  }

  // validateLegs is total over the zero-leg case (its own doc comment) —
  // "removing all legs + Save = unsplit" falls straight out of that: an
  // empty draft always validates clean, no special case needed here. A
  // null parent amount means the edit row's own boxes are the problem —
  // their message (parseAmountBoxes' own) is the hint, and Save stays
  // disabled until they hold exactly one positive amount.
  const hint = parentAmountCents === null
    ? (parentAmountHint ?? 'Enter an amount in Outflow or Inflow.')
    : validateLegs(parentAmountCents, preparedLegs())
  const saveDisabled = pending || hint !== null

  function handleSave() {
    if (saveDisabled) return
    onSave(preparedLegs())
  }

  const saveLabel = pending
    ? (approveOnSave ? 'Approving…' : 'Saving…')
    : (approveOnSave ? 'Approve' : 'Save')

  function legRow(leg: DraftLeg) {
    const categoryPicker = (
      <CategoryPicker
              pinnedOptions={[{ id: '', label: 'Uncategorized' }]}
        size="sm"
        ariaLabel="Split category"
        value={leg.categoryId}
        disabled={pending}
        onChange={(v) => updateLeg(leg.key, { categoryId: v })}
        options={categoryOptions}
      />
    )
    const noteInput = (
      <input
        aria-label="Split note" placeholder="Note" className={FIELD_FULL}
        value={leg.note} disabled={pending}
        onChange={(e) => updateLeg(leg.key, { note: e.target.value })}
      />
    )
    const amountInput = (
      <input
        aria-label="Split amount" inputMode="decimal" placeholder="0.00"
        className={`${FIELD_FULL} tabular text-right`}
        value={leg.amount} disabled={pending}
        onChange={(e) => updateLeg(leg.key, { amount: e.target.value })}
      />
    )
    const removeButton = (
      <button
        type="button" aria-label="Remove this split leg" disabled={pending}
        onClick={() => removeLeg(leg.key)}
        className="flex h-6 w-6 items-center justify-center rounded-field text-muted
                   hover:text-danger hover:bg-surface-2 disabled:opacity-40"
      >
        −
      </button>
    )

    if (desktop) {
      return (
        <div key={leg.key} className="grid items-center gap-x-3" style={{ gridTemplateColumns: gridTemplate }}>
          <span aria-hidden />
          <span aria-hidden />
          <span aria-hidden />
          {categoryPicker}
          {noteInput}
          {direction === 'outflow' ? amountInput : <span aria-hidden />}
          {direction === 'inflow' ? amountInput : <span aria-hidden />}
          <span aria-hidden />
          {removeButton}
        </div>
      )
    }
    return (
      <div key={leg.key} className="pb-2 mb-2 border-b border-line last:border-b-0 last:mb-0 last:pb-0">
        <div className="grid gap-2 grid-cols-2 items-center">
          {categoryPicker}
          {noteInput}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="w-28">{amountInput}</div>
          {removeButton}
        </div>
      </div>
    )
  }

  const remainingLabel = remainingCents === null ? '—' : formatUSD(remainingCents)
  const remainingLine = desktop ? (
    <div className="grid items-center gap-x-3" style={{ gridTemplateColumns: gridTemplate }}>
      <span aria-hidden />
      <span aria-hidden />
      <span aria-hidden />
      <span aria-hidden />
      <span className="text-xs text-muted text-right">Amount remaining</span>
      {direction === 'outflow'
        ? <span className="tabular text-right text-xs font-semibold">{remainingLabel}</span>
        : <span aria-hidden />}
      {direction === 'inflow'
        ? <span className="tabular text-right text-xs font-semibold">{remainingLabel}</span>
        : <span aria-hidden />}
      <span aria-hidden />
      <span aria-hidden />
    </div>
  ) : (
    <p className="flex items-center justify-between text-xs">
      <span className="text-muted">Amount remaining</span>
      <span className="tabular font-semibold">{remainingLabel}</span>
    </p>
  )

  return (
    <div className={desktop ? 'mt-2' : 'mt-3 sm:pl-9'}>
      {legs.map(legRow)}
      {remainingLine}
      <div className={`mt-2 flex flex-wrap items-center gap-3 ${desktop ? 'sm:pl-9' : ''}`}>
        <button
          type="button" onClick={addLeg} disabled={pending}
          className="text-xs font-semibold text-accent hover:opacity-80 disabled:opacity-40"
        >
          ＋ Add another split
        </button>
      </div>
      <div className={`mt-2 flex flex-wrap items-center gap-3 ${desktop ? 'sm:pl-9' : ''}`}>
        <button
          type="button" onClick={handleSave} disabled={saveDisabled}
          className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                     border border-line text-muted hover:text-ink disabled:opacity-40"
        >
          {saveLabel}
        </button>
        <button
          type="button" onClick={onCancel} disabled={pending}
          className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                     border border-line text-muted hover:text-ink disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
      {hint && (
        // role="alert" (M7, Wave C final review): `hint` is WHY Save is
        // disabled (saveDisabled above is gated on `hint !== null`, not
        // merely decorative help text), but text-muted styling carried no
        // live region — a screen reader user tabbing to the disabled Save
        // button heard nothing explaining the refusal. An alert region
        // announces its own text on mount/change without needing focus, the
        // same reasoning LoadError's own role="alert" (app/money/
        // matches/page.tsx) already applies to a load failure.
        <p role="alert" className={`text-xs text-muted mt-2 ${desktop ? 'sm:pl-9' : ''}`}>{hint}</p>
      )}
    </div>
  )
}
