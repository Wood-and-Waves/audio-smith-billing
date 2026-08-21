'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatAmount, formatUSD, parseUSD } from '@/lib/money'
import { formatDateLong, formatDateShort, todayInChicago } from '@/lib/dates'
import { normalizePayee } from '@/lib/payeeMemory'
import { type Quad } from '@/lib/receiptQuad'
import { FIELD_FULL } from '@/components/ui/field'
import Select from '@/components/ui/Select'
import CornerAdjuster from '@/components/CornerAdjuster'
import ReceiptLightbox from '@/components/ReceiptLightbox'
import {
  isPdf, detectCorners, INSET_QUAD, enhance, uploadReceiptPair, removeSuperseded,
} from '@/components/receiptCapture'
import { signedReceiptUrls } from '@/app/expenses/actions'
import {
  createLedgerAccount, addLedgerTransaction, updateLedgerTransaction,
  deleteLedgerTransaction, setTransactionCleared, setTransactionCategory,
  attachLedgerReceipt, replaceLedgerReceipt, removeLedgerReceipt,
} from '@/app/money/actions'

export type LedgerKind = 'income' | 'expense' | 'owner_pay'

export type CategoryOption = { id: string; name: string; grp: string }
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
  balanceCents: number
  receipt_path: string | null
  receipt_original: string | null
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

/** A click inside a cell that carries its own control (a Select, a button, a
 *  link) must never also fire the row's own click-to-edit — Select is not a
 *  portal (components/ui/Select renders its open listbox as a plain DOM
 *  descendant, not into document.body), so stopping the bubble here at the
 *  cell wrapper is enough to catch a pick from the open menu too, not just a
 *  tap on the trigger. */
function stopPropagation(e: React.MouseEvent) {
  e.stopPropagation()
}

/** The sm+ register table's fixed column template (repo idiom: CSS grid, not
 *  a real <table>) — a slim receipt-icon rail, DATE, PAYEE (grows), CATEGORY,
 *  MEMO (grows, muted), OUTFLOW/INFLOW/BALANCE right-aligned and tabular, a
 *  slim cleared rail. Screenshot-derived widths (2026-08-21 plan). */
const REGISTER_GRID =
  'grid-cols-[2.25rem_5.5rem_minmax(0,1fr)_12rem_minmax(0,1fr)_6rem_6rem_7rem_2.25rem]'

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

/** A receipt already attached — a torn-bottom paper glyph, filled. */
function ReceiptIcon() {
  return (
    <svg aria-hidden width="11" height="13" viewBox="0 0 11 13" className="shrink-0 fill-current">
      <path d="M0 0h11v13l-2-1.3L7 13l-2-1.3L3 13l-2-1.3L0 13z" />
    </svg>
  )
}

/** No receipt yet — a faint plus; tap opens the attach flow. */
function AddReceiptIcon() {
  return (
    <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" className="shrink-0 stroke-current fill-none">
      <path d="M5 0v10M0 5h10" strokeWidth="1.4" />
    </svg>
  )
}

/**
 * The cleared checkmark, everywhere it appears — a circled "C" toggle
 * (aria-pressed, disabled while pending), or the LockIcon once reconciled.
 * One control shared by both layouts (sm+ table cell and phone's line1
 * glyph) so a change to what "cleared" means visually never drifts between
 * them. Always stops its own click from bubbling into the row's
 * click-to-edit — see stopPropagation's own comment.
 */
function ClearedControl({
  row, pending, onToggle,
}: {
  row: LedgerTxnRow
  pending: boolean
  onToggle: () => void
}) {
  if (row.cleared === 'reconciled') {
    return (
      <span className="flex items-center justify-center text-muted" title="Reconciled — locked">
        <LockIcon />
      </span>
    )
  }
  const isCleared = row.cleared === 'cleared'
  return (
    <button
      type="button"
      aria-pressed={isCleared}
      aria-label={`Cleared: ${row.payee || 'this transaction'}`}
      disabled={pending}
      onClick={(e) => { e.stopPropagation(); onToggle() }}
      className={
        `flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold
         transition-colors disabled:opacity-40 ${
           isCleared ? 'border-good/40 bg-good/15 text-good' : 'border-line text-muted hover:text-ink'
         }`
      }
    >
      C
    </button>
  )
}

/**
 * The receipt column/chip, everywhere it appears — a filled receipt glyph
 * that opens the lightbox when one exists, a faint plus that starts the
 * attach flow when neither column is set. Same stopPropagation discipline as
 * ClearedControl above.
 */
function ReceiptControl({
  row, pending, onView, onAttach,
}: {
  row: LedgerTxnRow
  pending: boolean
  onView: (row: LedgerTxnRow) => void
  onAttach: (row: LedgerTxnRow) => void
}) {
  if (row.receipt_path) {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={(e) => { e.stopPropagation(); onView(row) }}
        aria-label={`View receipt: ${row.payee || 'this transaction'}`}
        className="flex items-center justify-center text-ink hover:text-accent disabled:opacity-40"
      >
        <ReceiptIcon />
      </button>
    )
  }
  // Attach is only ever offered when BOTH receipt columns are null — the
  // action itself refuses otherwise (attachLedgerReceipt's own guard). A row
  // with only one column set (shouldn't happen: the upload pair is written
  // together) shows neither icon rather than risk offering a second attach.
  if (row.receipt_original) return null
  return (
    <button
      type="button"
      disabled={pending}
      onClick={(e) => { e.stopPropagation(); onAttach(row) }}
      aria-label={`Add receipt: ${row.payee || 'this transaction'}`}
      className="flex items-center justify-center text-muted opacity-50 hover:text-ink hover:opacity-100 disabled:opacity-30"
    >
      <AddReceiptIcon />
    </button>
  )
}

/**
 * "Group: Name" — a categorized row's category, muted-group. Owner pay and
 * transfer rows show their kind instead (see KIND_LABEL's own comment); an
 * uncategorized income/expense row is never passed here at all (its cell
 * renders the inline Select instead — see inlineCategory in both row
 * renderers below). The group comes from `categories` (the page's own
 * not-hidden list, which already carries grp for the Select) matched by
 * category_id — a row whose category has since been hidden or deleted still
 * has its plain categoryName (denormalized on the row itself) to fall back
 * to, just without the group prefix.
 */
function CategoryText({ row, categories }: { row: LedgerTxnRow; categories: CategoryOption[] }) {
  if (row.kind === 'owner_pay' || row.kind === 'transfer') {
    return <span className="text-muted">{KIND_LABEL[row.kind]}</span>
  }
  if (!row.categoryName) return <span className="text-muted">Uncategorized</span>
  const grp = categories.find((c) => c.id === row.category_id)?.grp
  return (
    <span className="truncate">
      {grp && <span className="text-muted">{grp}: </span>}
      <span>{row.categoryName}</span>
    </span>
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
        className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-field
                   bg-accent-surface text-accent-ink disabled:opacity-50"
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
  /**
   * Newest first, already capped at the latest 200 — see app/money/page.tsx.
   * Each row carries the true ledger balance after it posted (balanceCents),
   * computed there over the full account before this list was capped or
   * filtered, so it's correct regardless of what subset is being rendered.
   */
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

  // Tapping the receipt icon (view) opens the ENHANCED copy in a lightbox —
  // same component ExpenseLog shares, ported unchanged.
  const [viewer, setViewer] = useState<{ url: string; label: string } | null>(null)

  // Fix-later: re-adjusting a SAVED transaction's corners from its untouched
  // original. Ported from ExpenseLog with expenseId -> txnId; same shape,
  // same unmount-only leak guard.
  const [fixLater, setFixLater] = useState<{
    txnId: string; file: File; url: string; quad: Quad; busy: boolean
  } | null>(null)
  const fixLaterRef = useRef(fixLater)
  useEffect(() => { fixLaterRef.current = fixLater }, [fixLater])
  useEffect(() => () => {
    if (fixLaterRef.current) URL.revokeObjectURL(fixLaterRef.current.url)
  }, [])

  // "Add receipt" on a row saved without one — ported from ExpenseLog with
  // expenseId -> txnId. Result attaches to the EXISTING row via
  // attachLedgerReceipt; no OCR anywhere in this component.
  const [attach, setAttach] = useState<{
    txnId: string; file: File; url: string; quad: Quad; busy: boolean
  } | null>(null)
  const attachRef = useRef(attach)
  useEffect(() => { attachRef.current = attach }, [attach])
  useEffect(() => () => {
    if (attachRef.current) URL.revokeObjectURL(attachRef.current.url)
  }, [])
  const attachInputRef = useRef<HTMLInputElement>(null)
  // Which row the hidden shared input is picking for — set on button tap,
  // read in onChange. A ref, not state: nothing renders from it.
  const attachTargetRef = useRef<string | null>(null)

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

  // Cleared + Uncleared = Working, the header equation — uncleared is never
  // stored, only derived: every row not yet cleared or reconciled still
  // counts toward workingBalanceCents but not clearedBalanceCents.
  const unclearedCents = workingBalanceCents - clearedBalanceCents

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
      // The row is gone either way — a storage warning here is not a
      // rollback, just Dan's heads-up that a receipt file was left behind.
      if (result.warning) setError(result.warning)
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

  /** The "Add receipt" tap: remember the row, open the shared picker. Guards
   *  against the fix-later or attach dialog already being open exactly like
   *  ExpenseLog's own openAttach — two overlaid dialogs would fight for the
   *  screen. */
  function openAttach(row: LedgerTxnRow) {
    if (fixLaterRef.current || attachRef.current) return
    setError(null)
    attachTargetRef.current = row.id
    attachInputRef.current?.click()
  }

  function onAttachPick(fileList: FileList | null) {
    const txnId = attachTargetRef.current
    const f = fileList?.[0]
    // Reset so re-picking the same file still fires change — same reason as
    // LedgerImport's input reset.
    if (attachInputRef.current) attachInputRef.current.value = ''
    if (!f || !txnId) return

    if (isPdf(f)) {
      // PDFs never see the adjuster (already-flat documents) — straight to
      // upload+attach, under the shared transition so row controls disable.
      start(async () => { await runAttach(txnId, f, null) })
      return
    }
    void (async () => {
      const detected = await detectCorners(f).catch(() => null)
      // Same anti-stacking guard as the other dialog flow.
      if (fixLaterRef.current || attachRef.current) return
      setAttach({
        txnId, file: f, url: URL.createObjectURL(f), quad: detected ?? INSET_QUAD, busy: false,
      })
    })()
  }

  /** Upload the pair under the 'ledger' subfolder, then point the row at it.
   *  Shared by the PDF path (quad null, no dialog) and the adjuster's
   *  confirm. */
  async function runAttach(txnId: string, file: File, quad: Quad | null): Promise<boolean> {
    const supabase = createClient()
    const uploaded = await uploadReceiptPair(supabase, 'ledger', file, () => {}, quad)
    if ('error' in uploaded) {
      setError(uploaded.error)
      return false
    }
    const result = await attachLedgerReceipt(txnId, uploaded.enhancedPath, uploaded.originalPath)
    if ('error' in result) {
      // The row never adopted the files, so they are orphans — same
      // best-effort cleanup as a superseded pick.
      removeSuperseded([uploaded.enhancedPath, uploaded.originalPath])
      setError(result.error)
      return false
    }
    router.refresh()
    return true
  }

  async function confirmAttach(quad: Quad | null) {
    if (!attach) return
    const { txnId, file, url } = attach
    setAttach({ ...attach, busy: true })
    const ok = await runAttach(txnId, file, quad)
    if (ok) {
      URL.revokeObjectURL(url)
      setAttach(null)
    } else {
      // Error is on screen; the dialog stays open so the corners survive a
      // retry — same policy as confirmFixLater.
      setAttach((a) => (a ? { ...a, busy: false } : a))
    }
  }

  function openReceipt(row: LedgerTxnRow) {
    const path = row.receipt_path
    if (!path) return
    setError(null)
    start(async () => {
      const { urls, storageError } = await signedReceiptUrls([path])
      const url = urls[path]
      if (storageError || !url) {
        setError('That receipt is no longer in storage.')
        return
      }
      setViewer({ url, label: row.payee || 'this transaction' })
    })
  }

  function openFixLater(row: LedgerTxnRow) {
    setError(null)
    start(async () => {
      const original = row.receipt_original
      if (!original) return // belt-and-suspenders: the control itself is gated on this

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
      // Mirror of onAttachPick's guard: if the attach dialog mounted while
      // this fetch/detect ran, this tap loses rather than stacking a second
      // dialog on top of it.
      if (attachRef.current) return
      setFixLater({
        txnId: row.id, file, url: URL.createObjectURL(blob), quad: detected ?? INSET_QUAD, busy: false,
      })
    })
  }

  /**
   * The adjuster's confirm for fix-later: re-flatten the untouched original
   * with the (possibly hand-adjusted) quad, upload it under a NEW stamped
   * path in the same 'ledger' subfolder — never upsert in place, so a
   * half-failed swap can never leave the row pointing at a half-written
   * object — then swap it onto the row via `replaceLedgerReceipt`. `busy` is
   * local state, not `pending`/`start`: the dialog must stay open and
   * re-enable on a failure, which a shared transition flag can't express
   * per-dialog.
   */
  async function confirmFixLater(quad: Quad | null) {
    if (!fixLater) return
    const { txnId, file, url } = fixLater
    setError(null)
    setFixLater((prev) => (prev ? { ...prev, busy: true } : prev))

    const supabase = createClient()
    let newPath: string
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not signed in.')
      const enhanced = await enhance(file, quad)
      newPath = `${user.id}/ledger/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-adjusted-enhanced.jpg`
      const { error: uploadError } = await supabase.storage.from('receipts')
        .upload(newPath, enhanced, { contentType: 'image/jpeg' })
      if (uploadError) throw new Error(uploadError.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not process that photo.')
      setFixLater((prev) => (prev ? { ...prev, busy: false } : prev))
      return
    }

    const result = await replaceLedgerReceipt(txnId, newPath)
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
    // The receipt is swapped either way -- a storage warning here is not a
    // rollback, same as removeRow's own handling of deleteLedgerTransaction's
    // warning.
    if (result.warning) setError(result.warning)
  }

  /** The quiet "Remove receipt" link inside edit mode — strips a wrong photo
   *  off the row entirely, including on a reconciled row (removeLedgerReceipt
   *  touches nothing reconcileAccount's math depends on). A storage warning
   *  surfaces the same way every other action's does here. */
  function removeReceipt(row: LedgerTxnRow) {
    setError(null)
    start(async () => {
      const result = await removeLedgerReceipt(row.id)
      if ('error' in result) { setError(result.error); return }
      if (result.warning) setError(result.warning)
      router.refresh()
    })
  }

  /**
   * The edit-mode grid — identical markup for both layouts (it already
   * stacks 2-col under sm, same as the add row above it), so this is the
   * ONE place either layout's row switches to when `editingId` matches. The
   * per-row × that used to sit on the display row lives here now as a plain
   * "Delete" link, alongside the receipt links that only make sense once a
   * row is already open for editing.
   */
  function renderEditRow(t: LedgerTxnRow) {
    // categoryOptions is filtered to unhidden categories (app/money/page.tsx's
    // query), so a row whose category was hidden after the fact isn't in it —
    // the Select would show "—" for editCategoryId, which reads as "no
    // category" and invites overwriting a real, still-assigned one by
    // accident. editCategoryId can only hold an out-of-list id in that exact
    // case (startEdit seeds it from row.category_id and the Select below
    // only ever hands back one of its own option values), so when that
    // happens, append one extra option for it — labeled from t.categoryName,
    // the denormalized join already carried on the row for exactly this
    // "since-hidden or since-deleted" case (see RawTxnRow's own comment in
    // app/money/page.tsx) — rather than leave the picker lying about there
    // being nothing there.
    const editCategoryOptions = editCategoryId && !categoryOptions.some((o) => o.value === editCategoryId)
      ? [...categoryOptions, { value: editCategoryId, label: `${t.categoryName ?? 'Unknown'} (hidden)` }]
      : categoryOptions
    const canAdjust = t.receipt_original !== null && t.receipt_path !== null && !t.receipt_original.endsWith('.pdf')
    const hasReceipt = t.receipt_path !== null || t.receipt_original !== null

    return (
      <>
        {/* Mirrors the add row's own grid exactly (same columns, same phone
            pairing) so editing feels like the same form, just pre-filled —
            the only addition is the Save/Cancel pair filling the trailing
            "auto" column instead of one "+ Add". */}
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

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {/* PDFs skip detection entirely (see detectCorners), so this only
              ever shows for a photo receipt still attached. */}
          {canAdjust && (
            <button
              type="button"
              disabled={pending}
              onClick={() => openFixLater(t)}
              className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
            >
              Adjust corners
            </button>
          )}
          {hasReceipt && (
            <button
              type="button"
              disabled={pending}
              onClick={() => removeReceipt(t)}
              className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
            >
              Remove receipt
            </button>
          )}
          {/* Deletion of bank data is recoverable by re-import, and this row
              was explicitly opened for editing — a single danger link, not a
              two-step arm/confirm, matching the plan's "keep it simple". */}
          <button
            type="button"
            disabled={pending}
            onClick={() => removeRow(t)}
            className="text-xs text-danger hover:opacity-80 underline disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </>
    )
  }

  /** The sm+ table row — a plain object, not a component, so it can close
   *  over every handler above without threading a dozen props through. Row
   *  background click opens edit mode (guarded to non-reconciled,
   *  non-transfer rows, same gate the old per-row Edit button used); every
   *  interactive cell stops that click from bubbling first. */
  function renderDesktopRow(t: LedgerTxnRow) {
    if (editingId === t.id) {
      return (
        <div key={t.id} className="border-b border-line py-4 pl-3 -ml-3 pr-3">
          {renderEditRow(t)}
        </div>
      )
    }

    const editable = t.cleared !== 'reconciled' && t.kind !== 'transfer'
    const inlineCategory = t.category_id === null && (t.kind === 'income' || t.kind === 'expense')
    const outflowCents = t.amount_cents < 0 ? -t.amount_cents : 0
    const inflowCents = t.amount_cents > 0 ? t.amount_cents : 0

    return (
      <div
        key={t.id}
        onClick={() => { if (editable) startEdit(t) }}
        className={
          `grid ${REGISTER_GRID} items-center gap-x-2 pl-3 -ml-3 pr-3 py-2 border-b border-line ${
            editable ? 'cursor-pointer hover:bg-surface' : ''
          }`
        }
      >
        <ReceiptControl row={t} pending={pending} onView={openReceipt} onAttach={openAttach} />
        <span className="tabular text-xs text-muted">{formatDateShort(t.date)}</span>
        <span className="min-w-0 flex items-center gap-2">
          <span className="truncate font-medium">{t.payee || '—'}</span>
          {t.showName && (
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted
                             bg-surface-2 rounded-field px-1.5 py-0.5 shrink-0">
              {t.showName}
            </span>
          )}
        </span>
        <div className="min-w-0" onClick={stopPropagation}>
          {inlineCategory ? (
            <Select
              size="sm"
              ariaLabel={`Category for ${t.payee || 'this transaction'}`}
              value=""
              disabled={pending}
              onChange={(v) => setRowCategory(t, v)}
              options={categoryOptions}
            />
          ) : (
            <CategoryText row={t} categories={categories} />
          )}
        </div>
        <span className="min-w-0 truncate text-xs text-muted">{t.memo}</span>
        <span className="tabular text-right">{outflowCents > 0 ? formatUSD(outflowCents) : ''}</span>
        <span className="tabular text-right">{inflowCents > 0 ? formatUSD(inflowCents) : ''}</span>
        <span className="tabular text-right font-semibold">{formatUSD(t.balanceCents)}</span>
        <ClearedControl row={t} pending={pending} onToggle={() => toggleCleared(t)} />
      </div>
    )
  }

  /** The phone row — YNAB-mobile shape: payee + amount + state glyph on
   *  line1, chips on line2, memo on line3. No Balance column (the
   *  screenshots agree it doesn't belong here). Same row-click-to-edit and
   *  stopPropagation discipline as the desktop row above. */
  function renderPhoneRow(t: LedgerTxnRow) {
    if (editingId === t.id) {
      return (
        <li key={t.id} className="border-b border-line py-4">
          {renderEditRow(t)}
        </li>
      )
    }

    const editable = t.cleared !== 'reconciled' && t.kind !== 'transfer'
    const inlineCategory = t.category_id === null && (t.kind === 'income' || t.kind === 'expense')
    const outflowCents = t.amount_cents < 0 ? -t.amount_cents : 0
    const inflowCents = t.amount_cents > 0 ? t.amount_cents : 0

    return (
      <li
        key={t.id}
        onClick={() => { if (editable) startEdit(t) }}
        className={`border-b border-line py-3 ${editable ? 'cursor-pointer' : ''}`}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-semibold flex-1 min-w-0 truncate">{t.payee || '—'}</span>
          <span className="tabular font-semibold shrink-0">
            {outflowCents > 0 ? `−${formatUSD(outflowCents)}` : formatUSD(inflowCents)}
          </span>
          <ClearedControl row={t} pending={pending} onToggle={() => toggleCleared(t)} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <div onClick={stopPropagation}>
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
              <span className="inline-block text-[11px] text-muted bg-surface-2 rounded-field
                               px-1.5 py-0.5 truncate max-w-[11rem]">
                <CategoryText row={t} categories={categories} />
              </span>
            )}
          </div>
          {t.showName && (
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted
                             bg-surface-2 rounded-field px-1.5 py-0.5 shrink-0">
              {t.showName}
            </span>
          )}
          <ReceiptControl row={t} pending={pending} onView={openReceipt} onAttach={openAttach} />
        </div>
        {t.memo && <p className="mt-1 text-xs text-muted truncate">{t.memo}</p>}
      </li>
    )
  }

  // Phone grouping, over the same (newest-first, already-capped) list the
  // desktop table renders: every uncleared row first, under one "Pending"
  // header, in whatever order they already carry; then the rest bucketed by
  // date. Bucketing by "does this row's date match the open bucket" rather
  // than a Map works because `transactions` is already sorted (newest ledger
  // order first) — same-date rows are always contiguous once the interleaved
  // uncleared ones are pulled out, so this never needs to re-sort.
  const pendingRows = transactions.filter((t) => t.cleared === 'uncleared')
  const clearedRows = transactions.filter((t) => t.cleared !== 'uncleared')
  const dateGroups: { date: string; rows: LedgerTxnRow[] }[] = []
  for (const t of clearedRows) {
    const open = dateGroups[dateGroups.length - 1]
    if (open && open.date === t.date) open.rows.push(t)
    else dateGroups.push({ date: t.date, rows: [t] })
  }

  return (
    <section>
      {/* Fix-later: re-adjusting a saved transaction's corners. Cancel is
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

      {/* The one hidden picker every row's receipt-attach control shares —
          which row is attaching lives in attachTargetRef. */}
      <input
        ref={attachInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => onAttachPick(e.target.files)}
      />

      {attach && (
        <CornerAdjuster
          src={attach.url}
          initialQuad={attach.quad}
          confirmLabel="Save"
          busy={attach.busy}
          onConfirm={(quad) => void confirmAttach(quad)}
          onCancel={() => {
            URL.revokeObjectURL(attach.url)
            setAttach(null)
          }}
        />
      )}

      {viewer && <ReceiptLightbox url={viewer.url} label={viewer.label} onClose={() => setViewer(null)} />}

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
          {/* Cleared + Uncleared = Working — the register's own equation,
              replacing a lone total: cleared and working are what's actually
              confirmed vs. believed, so those two are bold and uncleared
              sits between them as the plain difference. */}
          <p className="tabular text-sm sm:text-base">
            <span className="text-muted">Cleared </span>
            <span className="font-bold">{formatUSD(clearedBalanceCents)}</span>
            <span className="text-muted"> + Uncleared </span>
            <span>{formatUSD(unclearedCents)}</span>
            <span className="text-muted"> = Working </span>
            <span className="font-bold">{formatUSD(workingBalanceCents)}</span>
          </p>
          {account.lastReconciledAt && (
            <p className="text-xs text-muted mt-1">
              Reconciled {formatChicagoTimestamp(account.lastReconciledAt)}
            </p>
          )}
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
          state rather than on the categorized row's own row — on
          ?filter=uncategorized, router.refresh() after a successful
          categorization removes that very row from `transactions` (it's no
          longer uncategorized), which used to take the "apply to all" offer
          down with it since it lived inside that row's own markup. Living
          here instead, it survives the row's disappearance; the payee name
          in the copy is enough to identify what it's offering without the
          row still being visible. Same dismiss (cleared at the top of
          setRowCategory) and Apply-to-all (applyToAll) behavior as before. */}
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
        <>
          {/* Desktop/tablet: a YNAB-style spreadsheet — one CSS grid per row,
              a fixed column template (REGISTER_GRID), sharing the exact
              edit-mode grid the phone list below also drops into. */}
          <div className="hidden sm:block">
            <div className={`grid ${REGISTER_GRID} gap-x-2 pl-3 -ml-3 pr-3 pb-2 mb-1 border-b border-line`}>
              <span aria-hidden />
              <span className="eyebrow">Date</span>
              <span className="eyebrow">Payee</span>
              <span className="eyebrow">Category</span>
              <span className="eyebrow">Memo</span>
              <span className="eyebrow text-right">Outflow</span>
              <span className="eyebrow text-right">Inflow</span>
              <span className="eyebrow text-right">Balance</span>
              <span aria-hidden />
            </div>
            {transactions.map(renderDesktopRow)}
          </div>

          {/* Phone: YNAB-mobile's date-grouped list — a "Pending" section for
              every uncleared row, then one section per date. */}
          <div className="sm:hidden">
            {pendingRows.length > 0 && (
              <div className="mb-2">
                <p className="eyebrow mb-2">Pending</p>
                <ul className="border-t border-line">
                  {pendingRows.map(renderPhoneRow)}
                </ul>
              </div>
            )}
            {dateGroups.map((group) => (
              <div key={group.date} className="mb-2">
                <p className="eyebrow mb-2 mt-2">{formatDateLong(group.date)}</p>
                <ul className="border-t border-line">
                  {group.rows.map(renderPhoneRow)}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}

      {error && <p role="alert" className="text-xs text-danger mt-3">{error}</p>}
    </section>
  )
}
