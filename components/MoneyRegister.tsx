'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD, parseUSD } from '@/lib/money'
import { formatDateShort, todayInChicago } from '@/lib/dates'
import { FIELD_FULL } from '@/components/ui/field'
import Select from '@/components/ui/Select'
import {
  createLedgerAccount, addLedgerTransaction, updateLedgerTransaction,
  deleteLedgerTransaction, setTransactionCleared,
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
  uncategorizedCount, totalCount, headerActions,
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
  totalCount: number
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

  if (!accountProp) return <CreateAccountCard />
  // A genuine `const`, not just an unreassigned parameter — TypeScript only
  // carries a null-check's narrowing into the nested functions below (add,
  // toggleCleared, ...) for a binding it can prove is never reassigned, and a
  // function parameter doesn't qualify even though this one never is.
  const account = accountProp

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

  /** The inline picker on an uncategorized row — saves the row's existing
   *  fields untouched, plus the category just picked. */
  function setRowCategory(row: LedgerTxnRow, newCategoryId: string) {
    setError(null)
    start(async () => {
      const result = await updateLedgerTransaction({
        id: row.id,
        date: row.date,
        amountCents: row.amount_cents,
        kind: row.kind,
        categoryId: newCategoryId || null,
        showId: row.show_id,
        payee: row.payee,
        memo: row.memo ?? '',
      })
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  const truncated = transactions.length < totalCount

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

      {truncated && (
        <p className="text-xs text-muted mb-2">
          Showing the latest {transactions.length} of {totalCount}.
        </p>
      )}

      {transactions.length === 0 ? (
        <p className="text-muted border-l-2 border-line pl-4 py-1">No transactions yet.</p>
      ) : (
        <ul className="border-t border-line">
          {transactions.map((t) => {
            const reconciled = t.cleared === 'reconciled'
            // Reconciled excluded even though updateLedgerTransaction would
            // refuse it anyway ("Reconciled transactions are locked.") — an
            // uncategorized row that got reconciled before anyone got to it
            // (an import, say) should read as locked, not offer a picker
            // that can only ever come back with a server error.
            const inlineCategory = t.category_id === null && (t.kind === 'income' || t.kind === 'expense')
              && !reconciled
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
