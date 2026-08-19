'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatAmount, formatUSD, parseUSD } from '@/lib/money'
import { formatDateShort, todayInChicago } from '@/lib/dates'
import { normalizePayee } from '@/lib/payeeMemory'
import { FIELD_FULL } from '@/components/ui/field'
import Select from '@/components/ui/Select'
import {
  createLedgerAccount, addLedgerTransaction, updateLedgerTransaction,
  deleteLedgerTransaction, setTransactionCleared, setTransactionCategory,
} from '@/app/money/actions'

export type LedgerKind = 'income' | 'expense' | 'owner_pay'

export type CategoryOption = { id: string; name: string }
export type ShowOption = { id: string; label: string }

export type LedgerTxnRow = {
  id: string
  date: string
  amount_cents: number
  kind: 'income' | 'expense' | 'owner_pay' | 'transfer'
  category_id: string | null
  categoryName: string | null
  show_id: string | null
  showName: string | null
  payee: string
  memo: string | null
  cleared: 'uncleared' | 'cleared' | 'reconciled'
}

export type LedgerAccountSummary = {
  id: string
  name: string
  lastReconciledAt: string | null
}

const KIND_OPTIONS = [
  { value: 'income', label: 'Income' },
  { value: 'expense', label: 'Expense' },
  { value: 'owner_pay', label: 'Owner pay' },
] as const

// Owner pay and transfer never carry a category (the DB agrees — see
// lt_nocat_for_owner_or_transfer, migration 0027), so a row of either kind
// shows its kind here instead of a category name. Transfer has no UI path to
// create one yet (schema-ready for phase 2 account pairing only), but a row
// of that kind still has to render something sane if one ever shows up.
const KIND_LABEL: Record<string, string> = {
  income: 'Income', expense: 'Expense', owner_pay: 'Owner pay', transfer: 'Transfer',
}

/**
 * "8/16/26" for last-reconciled — that column is a timestamptz (reconcileAccount
 * writes `new Date().toISOString()`), not the plain YYYY-MM-DD dates
 * lib/dates.ts's formatters expect, so it gets its own formatter here. Pinned
 * to America/Chicago, the same zone todayInChicago uses, so the server-rendered
 * HTML and the client hydration agree regardless of either machine's own zone.
 */
function formatChicagoTimestamp(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: '2-digit',
  }).format(new Date(iso))
}

/** A plain padlock, drawn to match the app's other inline SVG glyphs (Select's
 *  own trigger arrow) rather than reaching for an emoji or an icon font. */
function LockIcon() {
  return (
    <svg aria-hidden width="12" height="14" viewBox="0 0 12 14" className="shrink-0 fill-none stroke-current">
      <rect x="1.25" y="6" width="9.5" height="6.75" rx="1" strokeWidth="1.4" />
      <path d="M3.5 6V4a2.5 2.5 0 0 1 5 0v2" strokeWidth="1.4" />
    </svg>
  )
}

/**
 * The one-time card that creates the account this whole register runs on.
 * Its own state, its own transition — it never coexists on screen with the
 * rest of MoneyRegister, so there is nothing to share.
 */
function CreateAccountCard() {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('Business Checking')
  const [openingBalance, setOpeningBalance] = useState('')
  const [openingDate, setOpeningDate] = useState(todayInChicago())

  function create() {
    setError(null)
    if (!name.trim()) { setError('Give the account a name.'); return }
    const cents = parseUSD(openingBalance)
    if (cents === null) { setError('Enter an opening balance.'); return }
    if (!openingDate) { setError('Pick an opening date.'); return }

    start(async () => {
      const result = await createLedgerAccount({ name, openingBalanceCents: cents, openingDate })
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  return (
    <section className="max-w-md">
      <h1 className="display text-3xl font-bold mb-2">Set up the ledger</h1>
      <p className="text-muted mb-6">
        One checking account to start the register from — rename it or close it later from here.
      </p>
      <div className="grid gap-3 mb-4">
        <label className="text-xs text-muted">
          Account name
          <input className={`${FIELD_FULL} mt-1`} value={name} disabled={pending}
                 onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs text-muted">
          Opening balance
          <input aria-label="Opening balance" inputMode="decimal" placeholder="0.00"
                 className={`${FIELD_FULL} mt-1 tabular`} value={openingBalance} disabled={pending}
                 onChange={(e) => setOpeningBalance(e.target.value)} />
        </label>
        <label className="text-xs text-muted">
          Opening date
          <input type="date" className={`${FIELD_FULL} mt-1`} value={openingDate} disabled={pending}
                 onChange={(e) => setOpeningDate(e.target.value)} />
        </label>
      </div>
      <button
        type="button"
        onClick={create}
        disabled={pending}
        className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                   border border-line text-muted hover:text-ink disabled:opacity-40"
      >
        {pending ? 'Creating…' : 'Create account'}
      </button>
      {error && <p role="alert" className="text-xs text-danger mt-3">{error}</p>}
    </section>
  )
}

export default function MoneyRegister({
  account: accountProp, categories, shows, transactions, workingBalanceCents, clearedBalanceCents,
  uncategorizedCount, totalCount, uncategorizedOnly, headerActions,
}: {
  /** Null in first-run mode — every other prop is meaningless then. */
  account: LedgerAccountSummary | null
  categories: CategoryOption[]
  shows: ShowOption[]
  /** Newest first, already capped at the latest 200 — see app/money/page.tsx. */
  transactions: LedgerTxnRow[]
  workingBalanceCents: number
  clearedBalanceCents: number
  uncategorizedCount: number
  /**
   * The size of whatever list `transactions` was capped from — the full
   * account when `uncategorizedOnly` is off, or just its uncategorized
   * income/expense rows when it's on (app/money/page.tsx filters before
   * capping, not after, so this is a true count either way).
   */
  totalCount: number
  /**
   * Set from `?filter=uncategorized` (app/money/page.tsx). Balances above
   * are never touched by this — only which rows the list below shows, and
   * which "showing N" message renders under the Add row.
   */
  uncategorizedOnly?: boolean
  /**
   * Import / Reconcile / "Edit categories" — built in app/money/page.tsx
   * (which is where account.id and the categories link both make sense to
   * assemble) and handed down as a slot, rather than imported here directly,
   * because the page never renders this component at all in first-run mode
   * (see CreateAccountCard above): undefined here just means "no account
   * yet", the same thing accountProp being null already means.
   */
  headerActions?: React.ReactNode
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // The add row's own state. Declared unconditionally, ABOVE the first-run
  // early return below, so the hook order never changes between "no account
  // yet" and "account just created" renders.
  const [date, setDate] = useState(todayInChicago())
  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState<LedgerKind>('expense')
  const [categoryId, setCategoryId] = useState('')
  const [showId, setShowId] = useState('')
  const [memo, setMemo] = useState('')

  // The inline edit form's own state — one row editable at a time (a single
  // set of fields, not a per-row map), so opening Edit on a second row just
  // replaces the first draft instead of tracking several at once. Same
  // "declared unconditionally, above the first-run return" rule as the add
  // row's state above.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDate, setEditDate] = useState('')
  const [editPayee, setEditPayee] = useState('')
  const [editAmount, setEditAmount] = useState('')
  const [editKind, setEditKind] = useState<LedgerKind>('expense')
  const [editCategoryId, setEditCategoryId] = useState('')
  const [editShowId, setEditShowId] = useState('')
  const [editMemo, setEditMemo] = useState('')

  // Apply-to-more: the one-line offer under a row that was just categorized,
  // to sweep every other loaded row sharing its payee, plus the briefly-shown
  // confirmation after that sweep runs. A plain timeout (not a transition),
  // same idiom as DeleteShowButton's own auto-clearing state.
  const [applyPrompt, setApplyPrompt] = useState<
    { rowId: string; payee: string; categoryId: string; count: number; atLeast: boolean } | null
  >(null)
  const [appliedNotice, setAppliedNotice] = useState<{ rowId: string; count: number } | null>(null)
  const appliedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (appliedTimeoutRef.current) clearTimeout(appliedTimeoutRef.current) }, [])

  if (!accountProp) return <CreateAccountCard />
  // A genuine `const`, not just an unreassigned parameter — TypeScript only
  // carries a null-check's narrowing into the nested functions below (add,
  // toggleCleared, ...) for a binding it can prove is never reassigned, and a
  // function parameter doesn't qualify even though this one never is.
  const account = accountProp

  // Whether the rendered `transactions` list is a strict subset of the
  // account (or, on ?filter=uncategorized, of the uncategorized queue) —
  // moved up here, ahead of the functions below, because setRowCategory
  // needs it too: the apply-to-more count it shows is only ever exact when
  // this is false.
  const truncated = transactions.length < totalCount

  const categoryOptions = [
    { value: '', label: '—' },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ]
  const showOptions = [
    { value: '', label: '—' },
    ...shows.map((s) => ({ value: s.id, label: s.label })),
  ]

  function add() {
    setError(null)
    if (!payee.trim()) { setError('Say who this was to or from.'); return }
    const typed = parseUSD(amount)
    if (typed === null || typed <= 0) { setError('Enter an amount.'); return }
    if (!date) { setError('Pick a date.'); return }

    // The user always types a positive number; the sign it posts to the
    // ledger comes from the kind they picked, mirroring the same signed-cents
    // rule addLedgerTransaction itself enforces (lt_income_positive /
    // lt_outflow_negative, migration 0027) rather than trusting a minus sign
    // Dan might or might not have typed.
    const amountCents = kind === 'income' ? typed : -typed

    start(async () => {
      const result = await addLedgerTransaction({
        accountId: account.id,
        date,
        amountCents,
        kind,
        categoryId: kind === 'owner_pay' ? null : (categoryId || null),
        showId: showId || null,
        payee,
        memo,
      })
      if ('error' in result) { setError(result.error); return }
      // Date, kind and category carry over — a batch of entries is usually
      // the same day, the same kind of money, and often the same category.
      // Payee, amount and memo are specific to the one just added.
      setPayee('')
      setAmount('')
      setMemo('')
      setShowId('')
      router.refresh()
    })
  }

  function toggleCleared(row: LedgerTxnRow) {
    setError(null)
    start(async () => {
      const next = row.cleared === 'cleared' ? 'uncleared' : 'cleared'
      const result = await setTransactionCleared(row.id, next)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  function removeRow(row: LedgerTxnRow) {
    setError(null)
    start(async () => {
      const result = await deleteLedgerTransaction(row.id)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  /** The inline picker on an uncategorized row — setTransactionCategory
   *  touches only category_id, so it works even on a reconciled row (see
   *  the action's own doc comment for why that's safe). A successful PICK
   *  (not a clear back to blank) also checks the rows already on screen for
   *  the same normalized payee, still uncategorized income/expense — when
   *  there are any, the row grows an "apply to all" offer instead of firing
   *  the sweep unasked. The count in that offer is only ever a floor: it's
   *  drawn from the rendered `transactions` list, which is capped at 200
   *  rows (`truncated`, above), while "Apply to all" itself sweeps every
   *  matching row across the whole account server-side — so when the list
   *  is capped, the offer is worded "at least N more" rather than claiming
   *  N is the exact count. A blank payee is skipped entirely, mirroring the
   *  server's own refusal to sweep from one (see setTransactionCategory's
   *  doc comment).
   */
  function setRowCategory(row: LedgerTxnRow, newCategoryId: string) {
    setError(null)
    setApplyPrompt(null)
    start(async () => {
      const result = await setTransactionCategory(row.id, newCategoryId || null)
      if ('error' in result) { setError(result.error); return }
      const key = normalizePayee(row.payee)
      if (newCategoryId && key !== '') {
        const count = transactions.filter((other) => (
          other.id !== row.id &&
          other.category_id === null &&
          (other.kind === 'income' || other.kind === 'expense') &&
          normalizePayee(other.payee) === key
        )).length
        if (count > 0) {
          setApplyPrompt({ rowId: row.id, payee: row.payee, categoryId: newCategoryId, count, atLeast: truncated })
        }
      }
      router.refresh()
    })
  }

  /** The "Apply to all" button under the prompt above — the actual sweep,
   *  via the same action with its third argument on. */
  function applyToAll() {
    if (!applyPrompt) return
    setError(null)
    const { rowId, categoryId } = applyPrompt
    start(async () => {
      const result = await setTransactionCategory(rowId, categoryId, true)
      if ('error' in result) { setError(result.error); return }
      setApplyPrompt(null)
      setAppliedNotice({ rowId, count: result.applied })
      if (appliedTimeoutRef.current) clearTimeout(appliedTimeoutRef.current)
      appliedTimeoutRef.current = setTimeout(() => setAppliedNotice(null), 4000)
      router.refresh()
    })
  }

  /** Opens a non-reconciled row into the inline edit form, prefilled from
   *  the row (amount shown positive, same as the add row's own convention —
   *  parseUSD/formatAmount round-trip it). */
  function startEdit(row: LedgerTxnRow) {
    setError(null)
    setApplyPrompt(null)
    setAppliedNotice(null)
    setEditingId(row.id)
    setEditDate(row.date)
    setEditPayee(row.payee)
    setEditAmount(formatAmount(Math.abs(row.amount_cents)))
    // 'transfer' never actually reaches here yet — nothing in this UI writes
    // one (see KIND_LABEL's own comment) — but the edit Select only offers
    // the three kinds the add row does, so a row of that kind still needs a
    // safe starting point if one ever shows up.
    setEditKind(row.kind === 'income' || row.kind === 'expense' || row.kind === 'owner_pay' ? row.kind : 'expense')
    setEditCategoryId(row.category_id ?? '')
    setEditShowId(row.show_id ?? '')
    setEditMemo(row.memo ?? '')
  }

  /** Cancel restores the row — nothing was ever sent to the server. */
  function cancelEdit() {
    setError(null)
    setEditingId(null)
  }

  function saveEdit(row: LedgerTxnRow) {
    setError(null)
    if (!editPayee.trim()) { setError('Say who this was to or from.'); return }
    const typed = parseUSD(editAmount)
    if (typed === null || typed <= 0) { setError('Enter an amount.'); return }
    if (!editDate) { setError('Pick a date.'); return }

    // Same re-derivation rule as the add row: the field always holds a
    // positive number; the sign that reaches the ledger comes from kind.
    const amountCents = editKind === 'income' ? typed : -typed

    start(async () => {
      const result = await updateLedgerTransaction({
        id: row.id,
        date: editDate,
        amountCents,
        kind: editKind,
        // Owner pay never carries a category (lt_nocat_for_owner_or_transfer)
        // — send categoryId: null outright rather than trusting the picker
        // to have already been cleared client-side.
        categoryId: editKind === 'owner_pay' ? null : (editCategoryId || null),
        showId: editShowId || null,
        payee: editPayee,
        memo: editMemo,
      })
      if ('error' in result) { setError(result.error); return }
      setEditingId(null)
      router.refresh()
    })
  }

  return (
    <section>
      <header className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div className="min-w-0">
          <h1 className="display text-3xl font-bold">{account.name}</h1>
          {uncategorizedCount > 0 && (
            <p className="text-sm font-semibold text-accent mt-1">
              {uncategorizedCount} uncategorized
            </p>
          )}
          {headerActions && (
            <div className="mt-3 flex flex-wrap items-center gap-4">
              {headerActions}
            </div>
          )}
        </div>

        <div className="text-right">
          <p className="tabular text-2xl font-bold">{formatUSD(workingBalanceCents)}</p>
          <p className="text-sm text-muted mt-1 tabular">
            Cleared {formatUSD(clearedBalanceCents)}
            {account.lastReconciledAt && ` · Reconciled ${formatChicagoTimestamp(account.lastReconciledAt)}`}
          </p>
        </div>
      </header>

      <h2 className="eyebrow mb-4">Transactions</h2>

      {/* Phone: a 2-col grid, each pair filling one row in DOM order
          (Date+Kind, Payee+Amount, Category+Show, Memo+Add) — same idiom as
          ExpenseLog's add row. The sm+ template gives every field its own
          fixed-width column instead. */}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-[9rem_8rem_1fr_7rem_9rem_9rem_1fr_auto] items-center mb-3">
        <input aria-label="Date" type="date" className={FIELD_FULL} value={date} disabled={pending}
               onChange={(e) => setDate(e.target.value)} />
        <Select
          ariaLabel="Kind"
          value={kind}
          disabled={pending}
          onChange={(v) => setKind(v as LedgerKind)}
          options={KIND_OPTIONS}
        />
        <input aria-label="Payee" className={FIELD_FULL} placeholder="Payee" value={payee} disabled={pending}
               onChange={(e) => setPayee(e.target.value)} />
        <input aria-label="Amount" inputMode="decimal" placeholder="0.00"
               className={`${FIELD_FULL} tabular text-right`} value={amount} disabled={pending}
               onChange={(e) => setAmount(e.target.value)} />
        {/* visibility, not removal from the DOM — an owner-pay row never
            carries a category (lt_nocat_for_owner_or_transfer), but hiding it
            this way keeps the grid's fixed sm+ column template aligned
            instead of shifting every field after it one slot to the left. */}
        <Select
          ariaLabel="Category"
          className={kind === 'owner_pay' ? 'invisible' : undefined}
          value={categoryId}
          disabled={pending || kind === 'owner_pay'}
          onChange={setCategoryId}
          options={categoryOptions}
        />
        <Select
          ariaLabel="Show"
          value={showId}
          disabled={pending}
          onChange={setShowId}
          options={showOptions}
        />
        <input aria-label="Memo" className={FIELD_FULL} placeholder="Memo" value={memo} disabled={pending}
               onChange={(e) => setMemo(e.target.value)} />
        <button
          type="button"
          onClick={add}
          disabled={pending}
          className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                     border border-line text-muted hover:text-ink disabled:opacity-40"
        >
          {pending ? 'Saving…' : '+ Add'}
        </button>
      </div>

      {uncategorizedOnly ? (
        <p className="text-xs text-muted mb-2">
          Showing {transactions.length}{truncated && ` of ${totalCount}`} uncategorized ·{' '}
          <Link href="/money" className="font-semibold text-accent hover:opacity-80">
            Show all
          </Link>
        </p>
      ) : truncated && (
        <p className="text-xs text-muted mb-2">
          Showing the latest {transactions.length} of {totalCount}.
        </p>
      )}

      {/* I4: a standalone notice above the list, keyed on the stored prompt
          state rather than on the categorized row's own <li> — on
          ?filter=uncategorized, router.refresh() after a successful
          categorization removes that very row from `transactions` (it's no
          longer uncategorized), which used to take the "apply to all" offer
          down with it since it lived inside that row's own <li>. Living here
          instead, it survives the row's disappearance; the payee name in the
          copy is enough to identify what it's offering without the row still
          being visible. Same dismiss (cleared at the top of setRowCategory)
          and Apply-to-all (applyToAll) behavior as before. */}
      {applyPrompt && (
        <p className="mb-3 text-xs text-muted border-l-2 border-line pl-4 py-1.5">
          Applied. {applyPrompt.atLeast ? 'At least ' : ''}{applyPrompt.count} more &ldquo;{applyPrompt.payee}&rdquo; row
          {applyPrompt.count === 1 ? '' : 's'} —{' '}
          <button
            type="button"
            disabled={pending}
            onClick={applyToAll}
            className="font-semibold text-accent hover:opacity-80 disabled:opacity-40"
          >
            Apply to all
          </button>
        </p>
      )}
      {appliedNotice && (
        <p className="mb-3 text-xs text-good border-l-2 border-line pl-4 py-1.5">
          Applied to {appliedNotice.count} more row{appliedNotice.count === 1 ? '' : 's'}.
        </p>
      )}

      {transactions.length === 0 ? (
        <p className="text-muted border-l-2 border-line pl-4 py-1">
          {uncategorizedOnly ? 'Nothing uncategorized.' : 'No transactions yet.'}
        </p>
      ) : (
        <ul className="border-t border-line">
          {transactions.map((t) => {
            const reconciled = t.cleared === 'reconciled'
            // Shown even when reconciled: setTransactionCategory has no
            // reconciled lock (a category assignment moves no money — see
            // its own doc comment), unlike updateLedgerTransaction, so an
            // uncategorized row that got swept into a reconciliation before
            // anyone got to it (an import, say) still has a working picker
            // instead of sitting stuck in the "uncategorized" count forever.
            const inlineCategory = t.category_id === null && (t.kind === 'income' || t.kind === 'expense')

            if (editingId === t.id) {
              // categoryOptions is filtered to unhidden categories
              // (app/money/page.tsx's query), so a row whose category was
              // hidden after the fact isn't in it — the Select would show
              // "—" for editCategoryId, which reads as "no category" and
              // invites overwriting a real, still-assigned one by accident.
              // editCategoryId can only hold an out-of-list id in that exact
              // case (startEdit seeds it from row.category_id and the Select
              // below only ever hands back one of its own option values), so
              // when that happens, append one extra option for it — labeled
              // from t.categoryName, the denormalized join already carried
              // on the row for exactly this "since-hidden or since-deleted"
              // case (see RawTxnRow's own comment in app/money/page.tsx) —
              // rather than leave the picker lying about there being nothing
              // there.
              const editCategoryOptions = editCategoryId && !categoryOptions.some((o) => o.value === editCategoryId)
                ? [...categoryOptions, { value: editCategoryId, label: `${t.categoryName ?? 'Unknown'} (hidden)` }]
                : categoryOptions

              // Mirrors the add row's own grid exactly (same columns, same
              // phone pairing) so editing feels like the same form, just
              // pre-filled — the only addition is the Save/Cancel pair
              // filling the trailing "auto" column instead of one "+ Add".
              return (
                <li key={t.id} className="border-b border-line py-4 pl-3 -ml-3 pr-3">
                  <div className="grid gap-2 grid-cols-2 sm:grid-cols-[9rem_8rem_1fr_7rem_9rem_9rem_1fr_auto] items-center">
                    <input aria-label="Date" type="date" className={FIELD_FULL} value={editDate} disabled={pending}
                           onChange={(e) => setEditDate(e.target.value)} />
                    <Select
                      ariaLabel="Kind"
                      value={editKind}
                      disabled={pending}
                      onChange={(v) => setEditKind(v as LedgerKind)}
                      options={KIND_OPTIONS}
                    />
                    <input aria-label="Payee" className={FIELD_FULL} placeholder="Payee" value={editPayee}
                           disabled={pending} onChange={(e) => setEditPayee(e.target.value)} />
                    <input aria-label="Amount" inputMode="decimal" placeholder="0.00"
                           className={`${FIELD_FULL} tabular text-right`} value={editAmount} disabled={pending}
                           onChange={(e) => setEditAmount(e.target.value)} />
                    <Select
                      ariaLabel="Category"
                      className={editKind === 'owner_pay' ? 'invisible' : undefined}
                      value={editCategoryId}
                      disabled={pending || editKind === 'owner_pay'}
                      onChange={setEditCategoryId}
                      options={editCategoryOptions}
                    />
                    <Select
                      ariaLabel="Show"
                      value={editShowId}
                      disabled={pending}
                      onChange={setEditShowId}
                      options={showOptions}
                    />
                    <input aria-label="Memo" className={FIELD_FULL} placeholder="Memo" value={editMemo}
                           disabled={pending} onChange={(e) => setEditMemo(e.target.value)} />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => saveEdit(t)}
                        disabled={pending}
                        className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                                   border border-line text-muted hover:text-ink disabled:opacity-40"
                      >
                        {pending ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={pending}
                        className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                                   border border-line text-muted hover:text-ink disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </li>
              )
            }

            return (
              <li key={t.id} className="border-b border-line py-4 pl-3 -ml-3 pr-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="tabular text-xs text-muted shrink-0">{formatDateShort(t.date)}</span>
                    <span className="font-semibold truncate">{t.payee || '—'}</span>
                    {t.showName && (
                      <span className="text-[11px] font-bold uppercase tracking-wider text-muted
                                       bg-surface-2 rounded-field px-1.5 py-0.5 shrink-0">
                        {t.showName}
                      </span>
                    )}
                  </div>
                  <span className="tabular font-semibold shrink-0">{formatUSD(t.amount_cents)}</span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {inlineCategory ? (
                    <Select
                      size="sm"
                      className="w-40"
                      ariaLabel={`Category for ${t.payee || 'this transaction'}`}
                      value=""
                      disabled={pending}
                      onChange={(v) => setRowCategory(t, v)}
                      options={categoryOptions}
                    />
                  ) : (
                    <span className="text-xs text-muted">
                      {t.kind === 'income' || t.kind === 'expense' ? (t.categoryName ?? 'Uncategorized') : KIND_LABEL[t.kind]}
                    </span>
                  )}

                  {reconciled ? (
                    <span className="flex items-center gap-1 text-muted" title="Reconciled — locked">
                      <LockIcon />
                      <span className="text-xs">Reconciled</span>
                    </span>
                  ) : (
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={t.cleared === 'cleared'}
                        disabled={pending}
                        onChange={() => toggleCleared(t)}
                        aria-label={`Cleared: ${t.payee || 'this transaction'}`}
                        className="h-4 w-4 accent-accent"
                      />
                      Cleared
                    </label>
                  )}

                  {/* Reconciled rows keep only the category picker above —
                      amount/date/kind/deletion stay locked through
                      updateLedgerTransaction/deleteLedgerTransaction, so
                      there is nothing here for a reconciled row to edit or
                      delete. Transfer rows hide Edit for a separate reason:
                      nothing creates transfers yet, so the edit Select's
                      kind options only cover income/expense/owner_pay and
                      startEdit falls back to 'expense' for anything else —
                      editing a transfer row would silently convert an inert
                      row into a counted expense. Hiding the control beats
                      that silent conversion. */}
                  {!reconciled && t.kind !== 'transfer' && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => startEdit(t)}
                      className="text-xs font-semibold uppercase tracking-wider text-muted hover:text-ink
                                 transition-colors disabled:opacity-40"
                    >
                      Edit
                    </button>
                  )}

                  {!reconciled && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => removeRow(t)}
                      aria-label={`Delete ${t.payee || 'this transaction'}`}
                      className="ml-auto shrink-0 text-muted hover:text-danger transition-colors
                                 text-lg leading-none disabled:opacity-40"
                    >
                      ×
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {error && <p role="alert" className="text-xs text-danger mt-3">{error}</p>}
    </section>
  )
}
