'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatAmount, formatUSD, parseUSD } from '@/lib/money'
import { parseUSDMath } from '@/lib/moneyMath'
import { formatDateLong, formatDateShort, todayInChicago } from '@/lib/dates'
import { normalizePayee } from '@/lib/payeeMemory'
import { deriveKind, type CategoryForKind, type LedgerDirection, type LedgerKind } from '@/lib/ledgerRules'
import { type SplitLegInput } from '@/lib/ledgerSplits'
import { type Quad } from '@/lib/receiptQuad'
import { FIELD_FULL } from '@/components/ui/field'
import Select from '@/components/ui/Select'
import CategoryPicker, { type CategoryPickerOption } from '@/components/CategoryPicker'
import SplitEditor, { freshSplitSeed, type SplitEditorSeedLeg } from '@/components/SplitEditor'
import CornerAdjuster from '@/components/CornerAdjuster'
import ReceiptLightbox from '@/components/ReceiptLightbox'
import {
  isPdf, detectCorners, INSET_QUAD, enhance, uploadReceiptPair, removeSuperseded,
} from '@/components/receiptCapture'
import { signedReceiptUrls } from '@/app/expenses/actions'
import {
  createLedgerAccount, addLedgerTransaction, updateLedgerTransaction,
  deleteLedgerTransaction, setTransactionCleared, setTransactionCategory,
  attachLedgerReceipt, replaceLedgerReceipt, removeLedgerReceipt, unlinkTransaction,
  replaceSplits, unsplitTransaction, enterTransactions, rejectTransaction,
} from '@/app/money/actions'

export type CategoryOption = { id: string; name: string; grp: string; budgetRole: 'spending' | 'income' }
export type ShowOption = { id: string; label: string }

/** One split leg as the register displays and re-seeds it (Wave C Task 4) —
 *  categoryName/categoryBudgetRole ride along for the exact same
 *  since-hidden-category fallback reason LedgerTxnRow's own pair does (see
 *  its comment below): a leg can point at a category that's since been
 *  hidden, and categoryPickerOptions (built from the not-hidden list) would
 *  otherwise have nothing to seed that leg's picker with. */
export type SplitLegRow = {
  categoryId: string | null
  categoryName: string | null
  categoryBudgetRole: 'spending' | 'income' | null
  amountCents: number
  note: string | null
}

export type LedgerTxnRow = {
  id: string
  date: string
  amount_cents: number
  kind: 'income' | 'expense' | 'owner_pay' | 'transfer'
  category_id: string | null
  categoryName: string | null
  // The row's own category's budget_role, denormalized the same way
  // categoryName already is (see its own comment) — deriveKind's fallback
  // (Wave B Task 5, name-keyed since H1) for a row whose category has since
  // been hidden: hidden categories drop out of the `categories` list a
  // lookup-by-id would otherwise use, but the row itself must still
  // re-derive the SAME kind on an edit that never touches the category.
  // categoryName above already carries the name half of that fallback pair
  // (H1 dropped this field's own now-unused categoryGrp twin — deriveKind
  // keys owner_pay on name, not group, since H1). null exactly when
  // category_id is null.
  categoryBudgetRole: 'spending' | 'income' | null
  show_id: string | null
  showName: string | null
  payee: string
  memo: string | null
  cleared: 'uncleared' | 'cleared' | 'reconciled'
  /** null = pending (migration 0042) — the Pending section's own axis.
   *  Never read directly for anything category-shaped (that's
   *  explodeForCategories' job, Task 5) — the register only ever asks
   *  "is this row pending," never "what month did it enter." */
  entered_at: string | null
  /** Split legs (Wave C Task 4) — [] means unsplit, the ordinary row. A
   *  split parent's own category_id is forced null by replace_transaction_
   *  splits the instant legs exist (migration 0042), so `legs.length > 0`
   *  is this component's one, single "is this row split" test — never
   *  re-derived from category_id being null, which owner_pay/income/expense
   *  rows can also be for the ordinary "uncategorized" reason. */
  legs: SplitLegRow[]
  balanceCents: number
  receipt_path: string | null
  receipt_original: string | null
  invoiceNumbers: number[]          // linked invoices ([] = none)
  expenseLinked: boolean            // has expense-link rows
  linkedReceiptPath: string | null  // a linked expense's receipt, display-time join
}

export type LedgerAccountSummary = {
  id: string
  name: string
  lastReconciledAt: string | null
}

// Transfer never carries a category (the DB agrees — lt_nocat_for_transfer,
// migration 0038), so a transfer row shows its kind here instead of a
// category name (see CategoryText below). Owner pay DOES carry a category
// now (0038 relaxed that; 0040 backfilled it) — its entry here is unused by
// CategoryText (an owner_pay row always renders its category like any other)
// but kept so this map still covers every kind, the same reason
// validateTxnShape's VALID_KINDS does.
const KIND_LABEL: Record<string, string> = {
  income: 'Income', expense: 'Expense', owner_pay: 'Owner pay', transfer: 'Transfer',
}

// Payment/Transfer's own id in CategoryPicker's pinnedOptions (Wave B Task 5,
// Dan's YNAB screenshot) — never a real category id (those come from the
// database), so it can't collide with one. Same pattern CategoryPicker's own
// NEW_CATEGORY_ID uses for its "+ New Category" row. Picking this row means
// category null + kind 'transfer' (categoryForKind/deriveKind, below) —
// the register's first form path that can create (or edit into) a transfer.
const TRANSFER_SENTINEL = '__transfer__'

/** "Split…"'s own sentinel in the EDIT row's CategoryPicker only (Wave C
 *  Task 4, Dan's YNAB screenshot) — same never-a-real-category-id pattern
 *  as TRANSFER_SENTINEL above. Picking it never calls onChange's real
 *  setter (see renderEditRow's own categorySelect below): it opens
 *  SplitEditor instead, seeded from whichever category was selected the
 *  instant before. The add row's and the inline (uncategorized-row)
 *  picker's own pinnedOptions deliberately omit this id — splitting a row
 *  that doesn't exist yet, or from the quick-pick cell, isn't offered (the
 *  design doc's own "splitting hand-entered rows at CREATE time" carve-out
 *  — create then edit-split is one step removed, rarely needed). */
const SPLIT_SENTINEL = '__split__'

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
// The desktop register's nine columns, resizable spreadsheet-style: a
// visible grip sits at every internal boundary, and dragging one moves ONLY
// that boundary — the column on its left and the column on its right trade
// the pixels; nothing else shifts (Dan's first cut re-balanced both sides
// of a column at once, which felt wrong immediately). Payee and memo are
// elastic between drags — during a drag they're pinned to measured pixels,
// and on release their final sizes become fr WEIGHTS again so the table
// still stretches with the window. Widths persist per device like the
// theme. Double-click a grip to reset the two columns it separates.
const COLUMN_DEFAULTS = {
  date: 88, category: 240, outflow: 96, inflow: 96, balance: 112,
} as const
type ResizableColumn = keyof typeof COLUMN_DEFAULTS
type FlexColumn = 'payee' | 'memo'
type RegisterColumn = ResizableColumn | FlexColumn
const COLUMN_MIN = 56
const COLUMN_MAX = 480
const FLEX_MIN = 80
const COLUMNS_STORAGE_KEY = 'registerCols'

/** Each grip's boundary: the column to its left, the column to its right. */
const BOUNDARIES = {
  b1: ['date', 'payee'], b2: ['payee', 'category'], b3: ['category', 'memo'],
  b4: ['memo', 'outflow'], b5: ['outflow', 'inflow'], b6: ['inflow', 'balance'],
} as const
type BoundaryId = keyof typeof BOUNDARIES

function registerTemplate(
  w: Record<ResizableColumn, number>,
  flex: Record<FlexColumn, number>,
  dragPx: Record<FlexColumn, number> | null,
): string {
  const payee = dragPx ? `${dragPx.payee}px` : `minmax(0,${flex.payee}fr)`
  const memo = dragPx ? `${dragPx.memo}px` : `minmax(0,${flex.memo}fr)`
  return `2.25rem ${w.date}px ${payee} ${w.category}px ${memo} ` +
    `${w.outflow}px ${w.inflow}px ${w.balance}px 2.25rem`
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
  // A row with no receipt of its own still shows the filled glyph when a
  // linked expense carries one — the display-time join built in
  // app/money/page.tsx (first linked expense with a receipt_path wins). Own
  // receipt still takes priority; openReceipt below signs whichever this
  // branch used.
  if (row.receipt_path || row.linkedReceiptPath) {
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
  // A grid child must exist even when empty, or every later cell in
  // the register's fixed 9-column template shifts a column.
  if (row.receipt_original) return <span />
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
 * "Group: Name" — a categorized row's category, muted-group. Only transfer
 * rows show their kind instead (see KIND_LABEL's own comment) — a transfer
 * never carries a category, so there is nothing else to show. Owner pay
 * carries a real category since 0038/0040 (C1: the app used to null it on
 * every write, which silently undid that migration and threw the row's whole
 * assignment into Ready to Assign) and renders exactly like an income/expense
 * row below, "Uncategorized" fallback included for the rare row that
 * genuinely has none. An uncategorized income/expense row is never passed
 * here at all (its cell renders the inline Select instead — see
 * inlineCategory in both row renderers below); owner_pay has no such inline
 * picker, so an uncategorized one DOES reach here. The group comes from
 * `categories` (the page's own not-hidden list, which already carries grp
 * for the Select) matched by category_id — a row whose category has since
 * been hidden or deleted still has its plain categoryName (denormalized on
 * the row itself) to fall back to, just without the group prefix.
 */
function CategoryText({ row, categories }: { row: LedgerTxnRow; categories: CategoryOption[] }) {
  if (row.kind === 'transfer') {
    return <span className="text-muted">{KIND_LABEL[row.kind]}</span>
  }
  if (!row.categoryName) return <span className="text-muted">Uncategorized</span>
  const grp = categories.find((c) => c.id === row.category_id)?.grp
  return (
    // block, not inline: overflow/text-overflow do nothing on an inline box,
    // so an inline "truncate" let long names paint straight over the memo
    // column (Dan caught "Misc Business Shoespenses" on day one).
    <span className="block truncate">
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
  account: accountProp, categories, categoryBalanceCents, shows, transactions, workingBalanceCents,
  clearedBalanceCents, uncategorizedCount, totalCount, uncategorizedOnly, headerActions,
}: {
  /** Null in first-run mode — every other prop is meaningless then. */
  account: LedgerAccountSummary | null
  categories: CategoryOption[]
  /**
   * This month's budget Available, in cents, per category id — CategoryPicker's
   * own balances (Wave B Task 3), computed once by app/money/page.tsx via
   * lib/budget.ts's buildBudget (the same validated arithmetic app/money/budget/page.tsx
   * runs, not a second implementation) and handed down as a plain map so this
   * component does no budget arithmetic of its own. A category buildBudget never
   * scores a row for (an income-role category) is simply absent from this map,
   * which CategoryPicker reads as "no balance to show," never a fabricated $0.00.
   */
  categoryBalanceCents: Record<string, number>
  shows: ShowOption[]
  /**
   * Newest first, optionally filtered by uncategorized status — see app/money/page.tsx.
   * Each row carries the true ledger balance after it posted (balanceCents),
   * computed there over the full account before any filtering, so it's correct
   * regardless of what subset is being rendered.
   */
  transactions: LedgerTxnRow[]
  workingBalanceCents: number
  clearedBalanceCents: number
  uncategorizedCount: number
  /**
   * Always exactly `transactions.length` today — app/money/page.tsx used to
   * cap `transactions` at the newest 200 rows (RENDER_CAP), which is what
   * `totalCount` and the `truncated` flag derived from it below existed to
   * cover; that cap is gone (see git history's "the register renders every
   * transaction, not the newest 200"), so `transactions` now IS the full
   * account (or, when `uncategorizedOnly` is on, its full uncategorized
   * income/expense subset) and `truncated` can no longer be true. Kept as a
   * separate prop rather than deleted because a paged register was the
   * other option on the table when the cap came out (docs/BACKLOG.md) and
   * was passed over for now, not ruled out — if paging returns, this is
   * already the plumbing it needs.
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
  // Outflow/Inflow: the register's own two boxes, not one field plus an
  // implied sign — YNAB's own idiom (Dan's top edit-row complaint: "Everything
  // is out of order from the headers"). Exactly one holds a value at a time;
  // onOutflowChange/onInflowChange below enforce that. Kind is no longer
  // state at all (Wave B Task 5, Dan's approved call): the dropdown that used
  // to own it is gone, and add()/saveEdit() call lib/ledgerRules.ts's
  // deriveKind at submit time instead, from whichever box holds the amount
  // and the selected category — see categoryForKind/add() below.
  const [outflowAmount, setOutflowAmount] = useState('')
  const [inflowAmount, setInflowAmount] = useState('')
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
  // Same Outflow/Inflow pair as the add row's own state above, seeded by
  // startEdit from the row's sign (see its own comment). Same "no editKind
  // state" change as the add row's kind, above.
  const [editOutflowAmount, setEditOutflowAmount] = useState('')
  const [editInflowAmount, setEditInflowAmount] = useState('')
  const [editCategoryId, setEditCategoryId] = useState('')
  const [editShowId, setEditShowId] = useState('')
  const [editMemo, setEditMemo] = useState('')

  // SplitEditor's own open/closed flag (Wave C Task 4) — one at a time,
  // same "single set of state, not a per-row map" rule as editingId itself:
  // startEdit below seeds it from the row's own `legs.length > 0` (an
  // already-split row opens straight into the editor), the "Split…" pinned
  // row (categorySelect's own onChange) and the display row's "Edit split"
  // affordance both set it true directly, and cancelEdit/saveEdit/saveSplit
  // all reset it false on their way out. `pendingSplitSeed` is the ONE piece
  // of state that outlives a single render for the "Split…" pinned pick: a
  // never-yet-split row has no `legs` of its own to seed from (that's
  // freshSplitSeed's whole job), so the seed computed the instant Split… is
  // chosen has to be remembered somewhere between that click and the
  // SplitEditor's own mount — null whenever the editor is seeding from a
  // real `t.legs` instead.
  const [splitEditorOpen, setSplitEditorOpen] = useState(false)
  const [pendingSplitSeed, setPendingSplitSeed] = useState<SplitEditorSeedLeg[] | null>(null)

  // Reject's own inline arm/confirm (Wave C Task 4) — same two-step idiom as
  // DeleteDraftInvoiceButton (arm -> named confirm, auto-disarm on silence),
  // folded in here rather than a standalone component because it needs the
  // same shared `pending`/`start`/`router.refresh()` every other row action
  // in this file already uses. One row armed at a time, like editingId.
  const [rejectConfirmId, setRejectConfirmId] = useState<string | null>(null)
  const rejectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (rejectTimeoutRef.current) clearTimeout(rejectTimeoutRef.current) }, [])

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
  // this is false. Provably always false today: `totalCount`'s own doc
  // comment above explains why — the render cap that could make
  // `transactions.length` fall short of it is gone. Left wired rather than
  // deleted so both callers below (the apply-to-more count, and the
  // "showing N of totalCount" messages) keep working unchanged if a paged
  // register ever brings the gap back.
  const truncated = transactions.length < totalCount

  // Per-device column widths. Server renders the defaults; stored widths
  // apply in an effect (same SSR-safe shape as the theme setting). Weights
  // are the elastic pair's fr ratio, committed from real pixels on release.
  const [colWidths, setColWidths] = useState<Record<ResizableColumn, number>>({ ...COLUMN_DEFAULTS })
  const [flexWeights, setFlexWeights] = useState<Record<FlexColumn, number>>({ payee: 1, memo: 1 })
  const [dragPx, setDragPx] = useState<Record<FlexColumn, number> | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLUMNS_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, unknown>
      setColWidths((prev) => {
        const next = { ...prev }
        for (const k of Object.keys(COLUMN_DEFAULTS) as ResizableColumn[]) {
          const v = parsed?.[k]
          if (typeof v === 'number' && v >= COLUMN_MIN && v <= COLUMN_MAX) next[k] = v
        }
        return next
      })
      const pw = parsed?.payeeW, mw = parsed?.memoW
      if (typeof pw === 'number' && typeof mw === 'number' && pw > 0 && mw > 0 && pw < 1e4 && mw < 1e4) {
        setFlexWeights({ payee: pw, memo: mw })
      }
    } catch { /* storage disabled: defaults stand */ }
  }, [])
  const gridTemplate = registerTemplate(colWidths, flexWeights, dragPx)

  const payeeHeadRef = useRef<HTMLSpanElement>(null)
  const memoHeadRef = useRef<HTMLSpanElement>(null)
  const colDragRef = useRef<{
    boundary: BoundaryId; startX: number
    startLeft: number; startRight: number
    startFlex: Record<FlexColumn, number>
  } | null>(null)

  function persistColumns(w: Record<ResizableColumn, number>, flex: Record<FlexColumn, number>) {
    try {
      localStorage.setItem(COLUMNS_STORAGE_KEY,
        JSON.stringify({ ...w, payeeW: Math.round(flex.payee), memoW: Math.round(flex.memo) }))
    } catch { /* device state only */ }
  }

  const isFlex = (c: RegisterColumn): c is FlexColumn => c === 'payee' || c === 'memo'
  const floorOf = (c: RegisterColumn) => (isFlex(c) ? FLEX_MIN : COLUMN_MIN)
  const ceilOf = (c: RegisterColumn) => (isFlex(c) ? 10000 : COLUMN_MAX)

  function applyBoundary(boundary: BoundaryId, rawDx: number) {
    const d = colDragRef.current
    if (!d || d.boundary !== boundary) return
    const [left, right] = BOUNDARIES[boundary]
    // The grabbed boundary is the ONLY thing that moves: left gains what
    // right loses (or vice versa), clamped so neither passes its floor/cap.
    const dx = Math.round(Math.min(
      Math.min(ceilOf(left) - d.startLeft, d.startRight - floorOf(right)),
      Math.max(rawDx, Math.max(floorOf(left) - d.startLeft, d.startRight - ceilOf(right))),
    ))
    const leftW = d.startLeft + dx
    const rightW = d.startRight - dx
    const nextFlex = { ...d.startFlex }
    const nextFixed: Partial<Record<ResizableColumn, number>> = {}
    if (isFlex(left)) nextFlex[left] = leftW; else nextFixed[left] = leftW
    if (isFlex(right)) nextFlex[right] = rightW; else nextFixed[right] = rightW
    setDragPx(nextFlex)
    if (Object.keys(nextFixed).length) setColWidths((prev) => ({ ...prev, ...nextFixed }))
  }

  function endColumnDrag() {
    colDragRef.current = null
    document.body.style.cursor = ''
    // Closure state is current here: every drag move re-rendered, so this
    // handler was recreated with the latest dragPx/colWidths. The elastic
    // pair's final pixels become their fr weights — the layout is identical
    // the instant elasticity returns, and window resizes keep sharing space
    // at the new ratio.
    if (dragPx) {
      setFlexWeights(dragPx)
      persistColumns(colWidths, dragPx)
    }
    setDragPx(null)
  }

  /** A visible divider at one column boundary; drag it, and only it moves. */
  function columnGrip(boundary: BoundaryId, side: 'left' | 'right') {
    return (
      <span
        aria-hidden
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const [left, right] = BOUNDARIES[boundary]
          const payeeW = payeeHeadRef.current?.getBoundingClientRect().width ?? 200
          const memoW = memoHeadRef.current?.getBoundingClientRect().width ?? 200
          const flexNow = { payee: payeeW, memo: memoW }
          const widthOf = (c: RegisterColumn) => (isFlex(c) ? flexNow[c] : colWidths[c])
          colDragRef.current = {
            boundary, startX: e.clientX,
            startLeft: widthOf(left), startRight: widthOf(right),
            startFlex: flexNow,
          }
          setDragPx(flexNow)
          document.body.style.cursor = 'col-resize'
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
          const d = colDragRef.current
          if (d) applyBoundary(boundary, e.clientX - d.startX)
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
          endColumnDrag()
        }}
        onPointerCancel={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
          endColumnDrag()
        }}
        onDoubleClick={() => {
          const [left, right] = BOUNDARIES[boundary]
          const w = { ...colWidths }
          const flex = { ...flexWeights }
          for (const c of [left, right]) {
            if (isFlex(c)) flex[c] = 1
            else w[c] = COLUMN_DEFAULTS[c]
          }
          setColWidths(w)
          setFlexWeights(flex)
          persistColumns(w, flex)
        }}
        // -top-0.5/-bottom-2 stretch the divider from just above the label
        // down through the header's padding to its underline, so it reads as
        // a real column boundary level with the text — not a floating tick.
        // Centered in the 12px gutter (offset = half gutter + half own width),
        // so the bar floats midway between the two labels instead of hugging
        // the word to its right.
        className={`group absolute ${side === 'right' ? '-right-3' : '-left-3'} -top-0.5 -bottom-2 w-3
                   cursor-col-resize touch-none flex justify-center`}
      >
        <span className="h-full w-[2px] rounded-pill bg-line group-hover:w-[3px] group-hover:bg-accent" />
      </span>
    )
  }

  // Cleared + Uncleared = Working, the header equation — uncleared is never
  // stored, only derived: every row not yet cleared or reconciled still
  // counts toward workingBalanceCents but not clearedBalanceCents.
  const unclearedCents = workingBalanceCents - clearedBalanceCents

  // CategoryPicker's own option shape (Wave B Task 3) — id/name/grp plus this
  // month's Available, looked up from the map app/money/page.tsx built via
  // buildBudget. Undefined (not 0) for a category the map never scored (an
  // income-role category — see categoryBalanceCents' own doc comment above);
  // CategoryPicker reads that as "no figure," never a fabricated "$0.00".
  const categoryPickerOptions: CategoryPickerOption[] = categories.map((c) => ({
    id: c.id, name: c.name, grp: c.grp, availableCents: categoryBalanceCents[c.id],
  }))
  const showOptions = [
    { value: '', label: '—' },
    ...shows.map((s) => ({ value: s.id, label: s.label })),
  ]

  /** Resolves a CategoryPicker value into what lib/ledgerRules.ts's
   *  deriveKind reasons about (Wave B Task 5) — never a raw id.
   *  `hiddenFallback` covers the one case a live lookup by id can miss: the
   *  edit row seeded from a row whose category has since been hidden (see
   *  LedgerTxnRow's own categoryName/categoryBudgetRole comment) — the add
   *  row never has one, since every id it can hold came from the live
   *  picker list below. */
  function categoryForKind(
    id: string,
    hiddenFallback?: { name: string; budgetRole: 'spending' | 'income' } | null,
  ): CategoryForKind {
    if (id === '') return null
    if (id === TRANSFER_SENTINEL) return 'payment-transfer'
    const cat = categories.find((c) => c.id === id)
    return cat ? { budgetRole: cat.budgetRole, name: cat.name } : (hiddenFallback ?? null)
  }

  /** Typing into Outflow always wins that box and always clears Inflow — YNAB's
   *  own exclusivity rule, so "exactly one non-empty at save" holds by
   *  construction rather than being re-checked field by field. Kind is no
   *  longer tracked reactively while typing (Wave B Task 5): add()/saveEdit()
   *  derive it from category + whichever box is non-empty at SUBMIT time
   *  (deriveKind, above), so there is nothing left for this handler to flip. */
  function onOutflowChange(v: string) {
    setOutflowAmount(v)
    setInflowAmount('')
  }

  /** Mirror of onOutflowChange. */
  function onInflowChange(v: string) {
    setInflowAmount(v)
    setOutflowAmount('')
  }

  function add() {
    setError(null)
    if (!payee.trim()) { setError('Say who this was to or from.'); return }
    const outflowTyped = outflowAmount.trim() !== ''
    const inflowTyped = inflowAmount.trim() !== ''
    if (outflowTyped === inflowTyped) { setError('Enter an amount in Outflow or Inflow.'); return }
    const typed = parseUSDMath(outflowTyped ? outflowAmount : inflowAmount)
    if (typed === null || typed <= 0) { setError('Enter an amount.'); return }
    if (!date) { setError('Pick a date.'); return }

    // Kind is no longer picked — it's derived from the category and which
    // box the amount landed in (Wave B Task 5). A refusal (an income
    // category on an outflow — the one shape that cannot be booked)
    // surfaces here, inline, before addLedgerTransaction is ever called.
    const direction: LedgerDirection = outflowTyped ? 'outflow' : 'inflow'
    const derived = deriveKind(categoryForKind(categoryId), direction)
    if ('error' in derived) { setError(derived.error); return }
    const kind: LedgerKind = derived.kind

    // The user always types a positive number, in whichever box; the sign it
    // posts to the ledger comes from which box, not from kind — Payment/
    // Transfer (Wave B Task 5) can land in EITHER box, so kind alone can no
    // longer decide this the way it could when income only ever came from
    // Inflow and expense/owner_pay only ever came from Outflow. Mirrors the
    // same signed-cents rule addLedgerTransaction itself enforces
    // (lt_income_positive / lt_outflow_negative, migration 0027) rather than
    // trusting a minus sign Dan might or might not have typed.
    const amountCents = direction === 'inflow' ? typed : -typed

    start(async () => {
      const result = await addLedgerTransaction({
        accountId: account.id,
        date,
        amountCents,
        kind,
        // Payment/Transfer's sentinel is never a real category id — null it
        // explicitly rather than relying on `kind === 'transfer'` to imply
        // it, so this stays correct even if deriveKind's own rules change.
        categoryId: categoryId === TRANSFER_SENTINEL ? null : (categoryId || null),
        showId: showId || null,
        payee,
        memo,
      })
      if ('error' in result) { setError(result.error); return }
      // Date and category carry over — a batch of entries is usually the
      // same day and often the same category (kind isn't state to carry
      // over anymore; it falls out of category + box every time). Payee,
      // amount and memo are specific to the one just added.
      setPayee('')
      setOutflowAmount('')
      setInflowAmount('')
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
   *  the sweep unasked. The count is exact: `transactions` now spans the
   *  entire filtered set, so the offer counts every matching uncategorized
   *  row on screen. A blank payee is skipped entirely, mirroring the
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
        // legs.length === 0: a split parent's category_id is null too (the
        // ordinary "uncategorized" reason isn't why), and the server's own
        // sweep already excludes split parents outright (setTransactionCategory's
        // own doc comment, app/money/actions.ts) — this mirrors that so the
        // count shown here is never an overcount the sweep then quietly
        // shorts.
        const count = transactions.filter((other) => (
          other.id !== row.id &&
          other.category_id === null &&
          other.legs.length === 0 &&
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
    // Seed the box matching the row's own sign (income positive, expense/
    // owner_pay negative — 0027's own constraint), never both — mirrors
    // add()'s exclusivity rather than leaving the other box's stale value
    // from a previous edit sitting there.
    if (row.amount_cents > 0) {
      setEditInflowAmount(formatAmount(row.amount_cents))
      setEditOutflowAmount('')
    } else {
      setEditOutflowAmount(formatAmount(Math.abs(row.amount_cents)))
      setEditInflowAmount('')
    }
    // Payment/Transfer (Wave B Task 5) is CategoryPicker's own pinned
    // sentinel, never a real category id — a transfer row's own category_id
    // is always null (lt_nocat_for_transfer), so seeding editCategoryId from
    // it directly would show the picker blank/Uncategorized instead of
    // checked on Payment/Transfer. Every other kind seeds from the row's
    // real category_id exactly as before.
    setEditCategoryId(row.kind === 'transfer' ? TRANSFER_SENTINEL : (row.category_id ?? ''))
    setEditShowId(row.show_id ?? '')
    setEditMemo(row.memo ?? '')
    // A split parent (legs.length > 0) opens straight into the editor —
    // the display row's own "Edit split" affordance and a plain click on
    // the row body both land here, and either way there is no reason to
    // show the row's category cell collapsed first. A never-split row
    // opens collapsed, same as before Wave C.
    setSplitEditorOpen(row.legs.length > 0)
    setPendingSplitSeed(null)
  }

  /** Cancel restores the row — nothing was ever sent to the server. */
  function cancelEdit() {
    setError(null)
    setEditingId(null)
    setSplitEditorOpen(false)
    setPendingSplitSeed(null)
  }

  // Same pair as onOutflowChange/onInflowChange above, for the edit form's
  // own state — kept as separate functions (not parameterized over which
  // form) so each stays a plain closure over its own setters, matching every
  // other add/edit pair in this file (startEdit vs add, cancelEdit vs the add
  // row's own reset). Same "nothing left to flip" simplification as
  // onOutflowChange/onInflowChange above.
  function onEditOutflowChange(v: string) {
    setEditOutflowAmount(v)
    setEditInflowAmount('')
  }

  function onEditInflowChange(v: string) {
    setEditInflowAmount(v)
    setEditOutflowAmount('')
  }

  function saveEdit(row: LedgerTxnRow) {
    setError(null)
    if (!editPayee.trim()) { setError('Say who this was to or from.'); return }
    const outflowTyped = editOutflowAmount.trim() !== ''
    const inflowTyped = editInflowAmount.trim() !== ''
    if (outflowTyped === inflowTyped) { setError('Enter an amount in Outflow or Inflow.'); return }
    const typed = parseUSDMath(outflowTyped ? editOutflowAmount : editInflowAmount)
    if (typed === null || typed <= 0) { setError('Enter an amount.'); return }
    if (!editDate) { setError('Pick a date.'); return }

    // Same re-derivation as add(), above — with the row's own denormalized
    // categoryName/categoryBudgetRole as categoryForKind's hidden-category
    // fallback: editCategoryId can only hold an off-list id when it's
    // exactly row.category_id (see editExtraOption's own comment,
    // renderEditRow), so this is the one case that needs it.
    const direction: LedgerDirection = outflowTyped ? 'outflow' : 'inflow'
    const hiddenFallback = row.categoryName !== null && row.categoryBudgetRole !== null
      ? { name: row.categoryName, budgetRole: row.categoryBudgetRole }
      : null
    const derived = deriveKind(categoryForKind(editCategoryId, hiddenFallback), direction)
    if ('error' in derived) { setError(derived.error); return }
    const kind: LedgerKind = derived.kind

    // Same box-decides-the-sign rule as add(), above.
    const amountCents = direction === 'inflow' ? typed : -typed

    start(async () => {
      const result = await updateLedgerTransaction({
        id: row.id,
        date: editDate,
        amountCents,
        kind,
        // C1: this used to force categoryId: null whenever editKind was
        // owner_pay, which nulled out a REAL, already-assigned category on
        // every single edit of an owner_pay row — quietly undoing 0038/0040
        // one save at a time. Owner pay carries a category like any other
        // kind now; only the picker's own value goes here (nulled instead
        // when it's the Payment/Transfer sentinel — same reasoning as
        // add()'s own categoryId line, above).
        categoryId: editCategoryId === TRANSFER_SENTINEL ? null : (editCategoryId || null),
        showId: editShowId || null,
        payee: editPayee,
        memo: editMemo,
      })
      if ('error' in result) { setError(result.error); return }
      setEditingId(null)
      router.refresh()
    })
  }

  /**
   * SplitEditor's own onSave (Wave C Task 4) — a zero-leg save routes to
   * unsplitTransaction, otherwise replaceSplits; either way, when the row
   * is PENDING the Save button already read "Approve" (SplitEditor's own
   * approveOnSave prop), and a successful split write is followed by the
   * same enterTransactions call Enter Now uses — Dan's screenshot's own
   * "one tap does both" behavior. The enter call only fires after the split
   * write succeeds, and only actually changes anything if the row is still
   * pending (enterTransactions' own `is('entered_at', null)` no-ops
   * otherwise) — never a second, redundant enter on an already-entered row.
   */
  function saveSplit(row: LedgerTxnRow, legs: SplitLegInput[]) {
    setError(null)
    start(async () => {
      const result = legs.length === 0 ? await unsplitTransaction(row.id) : await replaceSplits(row.id, legs)
      if ('error' in result) { setError(result.error); return }
      if (row.entered_at === null) {
        const entered = await enterTransactions([row.id])
        if ('error' in entered) { setError(entered.error); return }
      }
      setSplitEditorOpen(false)
      setPendingSplitSeed(null)
      setEditingId(null)
      router.refresh()
    })
  }

  /** Enter Now (one id) and Enter All (the whole pending queue) share the
   *  one enterTransactions action, same as the server side does — see its
   *  own doc comment for why there is no separate code path per Dan's
   *  naming. */
  function enterNow(row: LedgerTxnRow) {
    setError(null)
    start(async () => {
      const result = await enterTransactions([row.id])
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  function enterAll() {
    setError(null)
    const ids = transactions.filter((t) => t.entered_at === null).map((t) => t.id)
    if (ids.length === 0) return
    start(async () => {
      const result = await enterTransactions(ids)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  const REJECT_CONFIRM_TIMEOUT_MS = 4000

  /** Reject's own two-step arm — see rejectConfirmId's own doc comment
   *  above for why this lives here rather than as a standalone component. */
  function armReject(id: string) {
    setError(null)
    setRejectConfirmId(id)
    if (rejectTimeoutRef.current) clearTimeout(rejectTimeoutRef.current)
    rejectTimeoutRef.current = setTimeout(() => setRejectConfirmId(null), REJECT_CONFIRM_TIMEOUT_MS)
  }

  function disarmReject() {
    if (rejectTimeoutRef.current) clearTimeout(rejectTimeoutRef.current)
    setRejectConfirmId(null)
  }

  /** The confirmed tap — rejectTransaction tombstones then deletes (its own
   *  doc comment); the row is gone either way a warning surfaces, same
   *  "not a rollback" policy removeRow's own storage warning already
   *  follows. */
  function confirmReject(row: LedgerTxnRow) {
    if (rejectTimeoutRef.current) clearTimeout(rejectTimeoutRef.current)
    setRejectConfirmId(null)
    setError(null)
    start(async () => {
      const result = await rejectTransaction(row.id)
      if ('error' in result) { setError(result.error); return }
      if (result.warning) setError(result.warning)
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
    // Own receipt wins over a linked expense's — mirrors ReceiptControl's own
    // precedence above, so this always signs whichever path made the glyph
    // show up in the first place.
    const path = row.receipt_path || row.linkedReceiptPath
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

  /** Undoes an invoice or expense link — unlinkTransaction dissolves BOTH
   *  link tables for this row (an expense link's whole split group, not just
   *  this row) and restores any invoice it un-links to 'sent'. Link metadata
   *  is deliberately outside what reconciliation locks (same carve-out
   *  setTransactionCategory and the receipt actions get above), so this is
   *  offered on a reconciled row too — see the display rows' own showUnlink
   *  below for that inline placement. */
  function unlinkRow(row: LedgerTxnRow) {
    setError(null)
    start(async () => {
      const result = await unlinkTransaction(row.id)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  /**
   * The edit-mode grid — now the SAME nine-column template the display rows
   * render on (`gridTemplate`, live and resizable), so an editing row's
   * fields land under their own headers instead of a private, differently-
   * ordered template (Dan's top complaint: "Everything is out of order from
   * the headers"). Because that template only makes sense at sm+ (below sm
   * the register drops it entirely for the phone's 2-col stack — see
   * `registerTemplate`'s own callers), and because a `style` attribute always
   * wins over a class regardless of viewport, this can't be one shared block
   * with responsive classes the way the old flat grid was: `desktop` picks
   * between two literal layouts instead, one per call site below
   * (renderDesktopRow's copy lives inside "hidden sm:block" and always passes
   * true; renderPhoneRow's copy lives inside "sm:hidden" and always passes
   * false) — each copy only ever renders while its own breakpoint is the one
   * actually visible, so there is no flash of the wrong template.
   *
   * The second line (Show, Save/Cancel, and the same "Adjust corners"/
   * "Remove receipt"/"Unlink"/"Delete" links the two display rows below also
   * render for a row that HAS a receipt but ISN'T editable) is genuinely
   * shared — nothing in it depends on the resizable template, so one block
   * with a `sm:pl-9` indent (past the 2.25rem receipt rail + its gap) works
   * for both copies: the phone copy's `sm:` never fires because that copy is
   * never visible at sm+ in the first place.
   */
  function renderEditRow(t: LedgerTxnRow, desktop: boolean) {
    // categoryPickerOptions is filtered to unhidden categories (app/money/page.tsx's
    // query), so a row whose category was hidden after the fact isn't in it —
    // the picker would show blank for editCategoryId, which reads as "no
    // category" and invites overwriting a real, still-assigned one by
    // accident. editCategoryId can only hold an out-of-list id in that exact
    // case (startEdit seeds it from row.category_id and the picker below
    // only ever hands back one of its own option ids), so when that happens,
    // pass CategoryPicker its own extraOption — labeled from t.categoryName,
    // the denormalized join already carried on the row for exactly this
    // "since-hidden or since-deleted" case (see RawTxnRow's own comment in
    // app/money/page.tsx) — rather than leave the picker lying about there
    // being nothing there. Unlike the old Select, this isn't spliced into
    // the option list itself (it has no real `grp` to sit under); CategoryPicker
    // renders it as its own checked row under "Selected" instead. Excludes
    // the Payment/Transfer sentinel explicitly (Wave B Task 5) — that id is
    // ALSO never in categoryPickerOptions, by design, so without this check
    // a transfer row would spuriously get an extraOption of its own here too
    // and the picker's closed display would show "Unknown (hidden)" instead
    // of "Payment/Transfer" (CategoryPicker's own `selected` takes the
    // extraOption over a merely-pinned row when both match `value`).
    const editExtraOption = editCategoryId && editCategoryId !== TRANSFER_SENTINEL
      && !categoryPickerOptions.some((o) => o.id === editCategoryId)
      ? { id: editCategoryId, label: `${t.categoryName ?? 'Unknown'} (hidden)` }
      : null
    const canAdjust = t.receipt_original !== null && t.receipt_path !== null && !t.receipt_original.endsWith('.pdf')
    const hasReceipt = t.receipt_path !== null || t.receipt_original !== null

    // A split parent's category IS its legs (migration 0042 forces
    // category_id null the instant legs exist) — never re-derived from
    // category_id being null, which an ordinary uncategorized row is also
    // true for (see LedgerTxnRow's own `legs` doc comment).
    const isSplit = t.legs.length > 0

    // The edit row's own CategoryPicker gains the pinned "Split…" row (Wave
    // C Task 4) — picking it never reaches setEditCategoryId at all: it
    // seeds a fresh 2-leg draft from whatever category was selected the
    // instant before (freshSplitSeed, components/SplitEditor.tsx) and opens
    // SplitEditor instead. This picker is only ever rendered while
    // !isSplit && !splitEditorOpen (see categoryCell below) — an
    // already-split row shows "Split (N)"/"Edit split" in its place, per
    // the design doc's own "the edit row's own CategoryPicker is NOT
    // rendered for a split parent" requirement.
    const categorySelect = (
      <CategoryPicker
        ariaLabel="Category"
        value={editCategoryId}
        disabled={pending}
        onChange={(v) => {
          if (v === SPLIT_SENTINEL) {
            setPendingSplitSeed(freshSplitSeed(
              editCategoryId === TRANSFER_SENTINEL ? null : (editCategoryId || null),
              t.amount_cents,
            ))
            setSplitEditorOpen(true)
            return
          }
          setEditCategoryId(v)
        }}
        options={categoryPickerOptions}
        extraOption={editExtraOption}
        pinnedOptions={[
          { id: '', label: 'Uncategorized' },
          { id: TRANSFER_SENTINEL, label: 'Payment/Transfer' },
          { id: SPLIT_SENTINEL, label: 'Split…' },
        ]}
      />
    )

    // What actually lands in the category grid slot: the SplitEditor's own
    // footer replaces the picker entirely while it's open (nothing left to
    // pick — the legs ARE being edited right below); an already-split row
    // not currently mid-edit shows "Split (N)" plus the "Edit split"
    // affordance that opens it; every other row gets the ordinary picker.
    const categoryCell = splitEditorOpen ? (
      <span className="block truncate text-sm text-muted">Split</span>
    ) : isSplit ? (
      <span className="block truncate text-sm">
        <span className="text-muted">Split ({t.legs.length}) — </span>
        <button
          type="button" disabled={pending} onClick={() => setSplitEditorOpen(true)}
          className="font-semibold text-accent underline hover:opacity-80 disabled:opacity-40"
        >
          Edit split
        </button>
      </span>
    ) : categorySelect

    // The second line, shared verbatim by both copies below — see the
    // function's own doc comment for why this one can be shared while row1
    // can't. Kind used to live here as a Select (retired, Wave B Task 5 —
    // Dan's approved call: kind is derived from categorySelect above and
    // which Outflow/Inflow box carries the amount, not picked).
    //
    // M2 (Wave B final review): `error` used to have exactly one render
    // site, a single node below all 328+ rows (see this component's own
    // bottom `{error &&...}`) — invisible without scrolling past the whole
    // register, which is exactly where deriveKind's own refusals (H1/H2)
    // fire from: a category pick this row's saveEdit rejects. A copy right
    // here, at the point of the save/cancel buttons the error is actually
    // ABOUT, is the fix. role="alert" here is the live one; the bottom node
    // (this same shared `error` state) is aria-hidden now so a screen reader
    // never announces the identical message twice for the same failure —
    // see that node's own comment for why aria-hidden was chosen over
    // gating it out entirely.
    const secondLine = (
      <>
        <div className="mt-2 flex flex-wrap items-center gap-3 sm:pl-9">
        <Select
          ariaLabel="Show"
          className="w-36"
          value={editShowId}
          disabled={pending}
          onChange={setEditShowId}
          options={showOptions}
        />
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
        {(t.invoiceNumbers.length > 0 || t.expenseLinked) && (
          <button
            type="button"
            disabled={pending}
            onClick={() => unlinkRow(t)}
            className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
          >
            Unlink
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
        {error && <p role="alert" className="text-xs text-danger mt-2 sm:pl-9">{error}</p>}
      </>
    )

    // SplitEditor replaces the second line entirely while open — its own
    // Save/Approve and Cancel own that job instead (see its own doc
    // comment for why the two can't coexist: this row's own Save would
    // otherwise silently discard whatever legs are mid-edit, or try to
    // post an amount the DB trigger refuses while legs exist). Cancel here
    // is SplitEditor's own — it collapses the editor only, never the whole
    // edit row (cancelEdit, by contrast, closes both).
    const bottomBlock = splitEditorOpen ? (
      <SplitEditor
        parentAmountCents={t.amount_cents}
        seedLegs={t.legs.length > 0
          ? t.legs.map((l) => ({ categoryId: l.categoryId, amountCents: l.amountCents, note: l.note }))
          : (pendingSplitSeed ?? [])}
        categoryOptions={categoryPickerOptions}
        pending={pending}
        approveOnSave={t.entered_at === null}
        gridTemplate={gridTemplate}
        desktop={desktop}
        onSave={(legs) => saveSplit(t, legs)}
        onCancel={() => { setSplitEditorOpen(false); setPendingSplitSeed(null) }}
      />
    ) : secondLine

    if (desktop) {
      return (
        <>
          <div className="grid items-center gap-x-3" style={{ gridTemplateColumns: gridTemplate }}>
            <span aria-hidden />
            <input aria-label="Date" type="date" className={FIELD_FULL} value={editDate} disabled={pending}
                   onChange={(e) => setEditDate(e.target.value)} />
            <input aria-label="Payee" className={FIELD_FULL} placeholder="Payee" value={editPayee}
                   disabled={pending} onChange={(e) => setEditPayee(e.target.value)} />
            {categoryCell}
            <input aria-label="Memo" className={FIELD_FULL} placeholder="Memo" value={editMemo}
                   disabled={pending} onChange={(e) => setEditMemo(e.target.value)} />
            <input aria-label="Outflow" inputMode="decimal" placeholder="0.00"
                   className={`${FIELD_FULL} tabular text-right`} value={editOutflowAmount} disabled={pending}
                   onChange={(e) => onEditOutflowChange(e.target.value)} />
            <input aria-label="Inflow" inputMode="decimal" placeholder="0.00"
                   className={`${FIELD_FULL} tabular text-right`} value={editInflowAmount} disabled={pending}
                   onChange={(e) => onEditInflowChange(e.target.value)} />
            {/* The row's existing balance — static, muted; nothing about
                editing changes it until the save round-trips. */}
            <span className="tabular text-right text-muted">{formatUSD(t.balanceCents)}</span>
            <span aria-hidden />
          </div>
          {bottomBlock}
        </>
      )
    }

    // Phone: the same 2-col stacked idiom the display row and the add row
    // both use — no rail placeholders (phone has no rail columns) and no
    // Balance cell (phone never shows one — see renderPhoneRow's own doc
    // comment).
    return (
      <>
        <div className="grid gap-2 grid-cols-2 items-center">
          <input aria-label="Date" type="date" className={FIELD_FULL} value={editDate} disabled={pending}
                 onChange={(e) => setEditDate(e.target.value)} />
          <input aria-label="Payee" className={FIELD_FULL} placeholder="Payee" value={editPayee}
                 disabled={pending} onChange={(e) => setEditPayee(e.target.value)} />
          {categoryCell}
          <input aria-label="Memo" className={FIELD_FULL} placeholder="Memo" value={editMemo}
                 disabled={pending} onChange={(e) => setEditMemo(e.target.value)} />
          <input aria-label="Outflow" inputMode="decimal" placeholder="0.00"
                 className={`${FIELD_FULL} tabular text-right`} value={editOutflowAmount} disabled={pending}
                 onChange={(e) => onEditOutflowChange(e.target.value)} />
          <input aria-label="Inflow" inputMode="decimal" placeholder="0.00"
                 className={`${FIELD_FULL} tabular text-right`} value={editInflowAmount} disabled={pending}
                 onChange={(e) => onEditInflowChange(e.target.value)} />
        </div>
        {bottomBlock}
      </>
    )
  }

  /** The sm+ table row — a plain object, not a component, so it can close
   *  over every handler above without threading a dozen props through. Row
   *  background click opens edit mode (guarded to non-reconciled rows, same
   *  gate the old per-row Edit button used — transfer rows became editable
   *  in Wave B Task 5, now that Payment/Transfer can round-trip through the
   *  form; updateLedgerTransaction never had a kind-based restriction, only
   *  this UI's own dropdown could never produce one to edit); every
   *  interactive cell stops that click from bubbling first. */
  function renderDesktopRow(t: LedgerTxnRow) {
    if (editingId === t.id) {
      return (
        <div key={t.id} className="border-b border-line py-4 pl-3 -ml-3 pr-3">
          {renderEditRow(t, true)}
        </div>
      )
    }

    const editable = t.cleared !== 'reconciled'
    // A split parent's category is its legs — never the inline quick-pick
    // (see LedgerTxnRow's own `legs` doc comment for why this is
    // `legs.length > 0`, not a re-derivation from category_id being null).
    const isSplit = t.legs.length > 0
    // owner_pay included: updateLedgerTransaction refuses reconciled rows
    // outright, and setTransactionCategory (the write this picker calls) is
    // the one category write exempt from that lock — so a reconciled,
    // uncategorised owner-pay row would otherwise have no path to a category
    // at all. No such row exists today (owner-pay rows auto-default), but
    // there's no reason to leave the corner unreachable. Transfer excluded
    // here (unlike `editable` above) on purpose: its category is ALWAYS null
    // by the DB's own lt_nocat_for_transfer, so there is never anything for
    // this inline picker to offer it — see CategoryText below for how a
    // transfer row's cell renders instead. Split excluded for the same
    // reason as transfer: category_id is null here too, but the row is
    // never "uncategorized" — see the isSplit branch in the category cell
    // below.
    const inlineCategory = !isSplit && t.category_id === null
      && (t.kind === 'income' || t.kind === 'expense' || t.kind === 'owner_pay')
    const outflowCents = t.amount_cents < 0 ? -t.amount_cents : 0
    const inflowCents = t.amount_cents > 0 ? t.amount_cents : 0
    // A reconciled row can't be opened for edit, so it never reaches
    // renderEditRow's own "Adjust corners"/"Remove receipt" links — but
    // removeLedgerReceipt (see its own doc comment) works on a reconciled
    // row on purpose. Surface the same two links here, quietly, whenever the
    // row still has a receipt to act on.
    const showReceiptLinks = !editable && (t.receipt_path !== null || t.receipt_original !== null)
    const canAdjustReceipt = showReceiptLinks
      && t.receipt_original !== null && t.receipt_path !== null && !t.receipt_original.endsWith('.pdf')
    // Same non-editable carve-out as showReceiptLinks above, but keyed off
    // link state instead of receipt state — a reconciled row must still be
    // able to unlink (renderEditRow's own Unlink covers editable rows via
    // edit mode).
    const showUnlink = !editable && (t.invoiceNumbers.length > 0 || t.expenseLinked)
    // Pending (Wave C Task 4): entered_at null. The chip's TEXT is the
    // signal ("the chip text is the non-color signal", per the plan) — the
    // muted row tone is decoration on top of it, never the only cue.
    const isPending = t.entered_at === null

    return (
      <div
        key={t.id}
        onClick={() => { if (editable) startEdit(t) }}
        style={{ gridTemplateColumns: gridTemplate }}
        className={
          `grid items-center gap-x-3 pl-3 -ml-3 pr-3 py-2 border-b border-line ${
            editable ? 'cursor-pointer hover:bg-surface' : ''
          } ${isPending ? 'opacity-70' : ''}`
        }
      >
        <ReceiptControl row={t} pending={pending} onView={openReceipt} onAttach={openAttach} />
        <span className="tabular text-xs text-muted">{formatDateShort(t.date)}</span>
        <span className="min-w-0 flex items-center gap-2">
          <span className="truncate font-medium">{t.payee || '—'}</span>
          {isPending && (
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted
                             bg-surface-2 rounded-field px-1.5 py-0.5 shrink-0">
              Pending
            </span>
          )}
          {t.invoiceNumbers.length > 0 && (
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted
                             bg-surface-2 rounded-field px-1.5 py-0.5 shrink-0">
              #{t.invoiceNumbers.join(' + #')}
            </span>
          )}
        </span>
        <div className="min-w-0" onClick={stopPropagation}>
          {isSplit ? (
            <span className="block truncate">
              <span className="text-muted">Split ({t.legs.length}) — </span>
              {editable && (
                <button
                  type="button" disabled={pending} onClick={() => startEdit(t)}
                  className="font-semibold text-accent underline hover:opacity-80 disabled:opacity-40"
                >
                  Edit split
                </button>
              )}
            </span>
          ) : inlineCategory ? (
            <CategoryPicker
              size="sm"
              ariaLabel={`Category for ${t.payee || 'this transaction'}`}
              value=""
              disabled={pending}
              onChange={(v) => setRowCategory(t, v)}
              options={categoryPickerOptions}
            />
          ) : (
            <CategoryText row={t} categories={categories} />
          )}
        </div>
        <div className="min-w-0">
          <span className="block truncate text-xs text-muted">{t.memo}</span>
          {(showReceiptLinks || showUnlink || isPending) && (
            <div className="flex items-center gap-x-3">
              {isPending && (
                rejectConfirmId === t.id ? (
                  <>
                    <button
                      type="button" disabled={pending}
                      onClick={(e) => { e.stopPropagation(); confirmReject(t) }}
                      className="text-xs text-danger hover:opacity-80 underline disabled:opacity-40"
                    >
                      {pending ? 'Rejecting…' : 'Confirm reject?'}
                    </button>
                    <button
                      type="button" disabled={pending}
                      onClick={(e) => { e.stopPropagation(); disarmReject() }}
                      className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
                    >
                      Never mind
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button" disabled={pending}
                      onClick={(e) => { e.stopPropagation(); enterNow(t) }}
                      className="text-xs text-accent hover:opacity-80 underline disabled:opacity-40"
                    >
                      Enter Now
                    </button>
                    <button
                      type="button" disabled={pending}
                      onClick={(e) => { e.stopPropagation(); armReject(t.id) }}
                      className="text-xs text-danger hover:opacity-80 underline disabled:opacity-40"
                    >
                      Reject
                    </button>
                  </>
                )
              )}
              {showReceiptLinks && canAdjustReceipt && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={(e) => { e.stopPropagation(); openFixLater(t) }}
                  className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
                >
                  Adjust corners
                </button>
              )}
              {showReceiptLinks && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={(e) => { e.stopPropagation(); removeReceipt(t) }}
                  className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
                >
                  Remove receipt
                </button>
              )}
              {showUnlink && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={(e) => { e.stopPropagation(); unlinkRow(t) }}
                  className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
                >
                  Unlink
                </button>
              )}
            </div>
          )}
        </div>
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
          {renderEditRow(t, false)}
        </li>
      )
    }

    const editable = t.cleared !== 'reconciled'
    // Same reasoning as renderDesktopRow's own isSplit/inlineCategory —
    // see that comment for both the owner_pay-included and
    // transfer/split-excluded halves.
    const isSplit = t.legs.length > 0
    const inlineCategory = !isSplit && t.category_id === null
      && (t.kind === 'income' || t.kind === 'expense' || t.kind === 'owner_pay')
    const outflowCents = t.amount_cents < 0 ? -t.amount_cents : 0
    const inflowCents = t.amount_cents > 0 ? t.amount_cents : 0
    // Same escape hatch as renderDesktopRow's — see its own comment.
    const showReceiptLinks = !editable && (t.receipt_path !== null || t.receipt_original !== null)
    const canAdjustReceipt = showReceiptLinks
      && t.receipt_original !== null && t.receipt_path !== null && !t.receipt_original.endsWith('.pdf')
    const showUnlink = !editable && (t.invoiceNumbers.length > 0 || t.expenseLinked)
    // Same pending flag as renderDesktopRow's own — see its comment.
    const isPending = t.entered_at === null

    return (
      <li
        key={t.id}
        onClick={() => { if (editable) startEdit(t) }}
        className={`border-b border-line py-3 ${editable ? 'cursor-pointer' : ''} ${isPending ? 'opacity-70' : ''}`}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-semibold flex-1 min-w-0 truncate">{t.payee || '—'}</span>
          <span className="tabular font-semibold shrink-0">
            {/* A zero-cent txn (transfer carries no sign constraint) would
                otherwise fall through to inflowCents and print "$0.00" —
                blank instead, matching desktop's blank outflow/inflow cells. */}
            {outflowCents > 0 ? `−${formatUSD(outflowCents)}` : inflowCents > 0 ? formatUSD(inflowCents) : ''}
          </span>
          <ClearedControl row={t} pending={pending} onToggle={() => toggleCleared(t)} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {isPending && (
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted
                             bg-surface-2 rounded-field px-1.5 py-0.5 shrink-0">
              Pending
            </span>
          )}
          <div onClick={stopPropagation}>
            {isSplit ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted
                               bg-surface-2 rounded-field px-1.5 py-0.5 truncate max-w-[11rem]">
                Split ({t.legs.length})
                {editable && (
                  <button
                    type="button" disabled={pending}
                    onClick={(e) => { e.stopPropagation(); startEdit(t) }}
                    className="font-semibold text-accent underline hover:opacity-80 disabled:opacity-40"
                  >
                    Edit
                  </button>
                )}
              </span>
            ) : inlineCategory ? (
              <CategoryPicker
                size="sm"
                className="w-40"
                ariaLabel={`Category for ${t.payee || 'this transaction'}`}
                value=""
                disabled={pending}
                onChange={(v) => setRowCategory(t, v)}
                options={categoryPickerOptions}
              />
            ) : (
              <span className="inline-block text-[11px] text-muted bg-surface-2 rounded-field
                               px-1.5 py-0.5 truncate max-w-[11rem]">
                <CategoryText row={t} categories={categories} />
              </span>
            )}
          </div>
          {t.invoiceNumbers.length > 0 && (
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted
                             bg-surface-2 rounded-field px-1.5 py-0.5 shrink-0">
              #{t.invoiceNumbers.join(' + #')}
            </span>
          )}
          <ReceiptControl row={t} pending={pending} onView={openReceipt} onAttach={openAttach} />
          {isPending && (
            rejectConfirmId === t.id ? (
              <>
                <button
                  type="button" disabled={pending}
                  onClick={(e) => { e.stopPropagation(); confirmReject(t) }}
                  className="text-xs text-danger hover:opacity-80 underline disabled:opacity-40"
                >
                  {pending ? 'Rejecting…' : 'Confirm reject?'}
                </button>
                <button
                  type="button" disabled={pending}
                  onClick={(e) => { e.stopPropagation(); disarmReject() }}
                  className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
                >
                  Never mind
                </button>
              </>
            ) : (
              <>
                <button
                  type="button" disabled={pending}
                  onClick={(e) => { e.stopPropagation(); enterNow(t) }}
                  className="text-xs text-accent hover:opacity-80 underline disabled:opacity-40"
                >
                  Enter Now
                </button>
                <button
                  type="button" disabled={pending}
                  onClick={(e) => { e.stopPropagation(); armReject(t.id) }}
                  className="text-xs text-danger hover:opacity-80 underline disabled:opacity-40"
                >
                  Reject
                </button>
              </>
            )
          )}
          {showReceiptLinks && (
            <>
              {canAdjustReceipt && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={(e) => { e.stopPropagation(); openFixLater(t) }}
                  className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
                >
                  Adjust corners
                </button>
              )}
              <button
                type="button"
                disabled={pending}
                onClick={(e) => { e.stopPropagation(); removeReceipt(t) }}
                className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
              >
                Remove receipt
              </button>
            </>
          )}
          {showUnlink && (
            <button
              type="button"
              disabled={pending}
              onClick={(e) => { e.stopPropagation(); unlinkRow(t) }}
              className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
            >
              Unlink
            </button>
          )}
        </div>
        {t.memo && <p className="mt-1 text-xs text-muted truncate">{t.memo}</p>}
      </li>
    )
  }

  // Pending (Wave C Task 4, entered_at null) — Dan's own reviewable import
  // queue, pinned above EVERYTHING else on both layouts (his YNAB
  // screenshot's own "Pending Transactions" group). Partitioned out of
  // `transactions` entirely rather than duplicated: a pending row renders
  // once, in this section, never again in the dated list/table below —
  // same "pulled out, not duplicated" shape the phone grouping already used
  // for uncleared rows before this wave (see its own comment, now renamed,
  // just below). Balances are untouched by this split: balanceCents is
  // computed per-row in app/money/page.tsx over the FULL account regardless
  // of which section a row ends up rendered in (Dan's option 1 — pending
  // counts in working/cleared balances).
  const pendingQueue = transactions.filter((t) => t.entered_at === null)
  const nonPending = transactions.filter((t) => t.entered_at !== null)

  // Phone grouping, over the same (newest-first) NON-PENDING rows the
  // desktop table renders: every uncleared row first, under an "Uncleared"
  // header (renamed from "Pending" now that Wave C gives that word its own,
  // different meaning above — the section built from pendingQueue owns it
  // instead), then the rest bucketed by date. Bucketing by "does this row's
  // date match the open bucket" rather than a Map works because
  // `nonPending` is still newest-first (a filter over an already-sorted
  // array preserves order) — same-date rows are always contiguous once the
  // interleaved uncleared ones are pulled out, so this never needs to
  // re-sort.
  const unclearedRows = nonPending.filter((t) => t.cleared === 'uncleared')
  const clearedRows = nonPending.filter((t) => t.cleared !== 'uncleared')
  const dateGroups: { date: string; rows: LedgerTxnRow[] }[] = []
  for (const t of clearedRows) {
    const open = dateGroups[dateGroups.length - 1]
    if (open && open.date === t.date) open.rows.push(t)
    else dateGroups.push({ date: t.date, rows: [t] })
  }

  /** A plain, non-sticky, non-resizable copy of the desktop column header —
   *  used above the Pending section's own rows so its grid still reads
   *  under labels, without touching payeeHeadRef/memoHeadRef (which must
   *  stay attached to exactly one DOM node — the real, sticky header below
   *  still owns them and the column-resize math they feed) or duplicating
   *  the drag grips onto a second set of pointer handlers. */
  function pendingColumnHeader() {
    return (
      <div
        style={{ gridTemplateColumns: gridTemplate }}
        className="grid gap-x-3 pl-3 -ml-3 pr-3 pt-1 pb-2 mb-1 border-b border-line"
      >
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
    )
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
            {/* formatUSD already prints its own "-" for a negative amount, so
                a negative uncleared total (which happens — nothing about
                'uncleared' constrains sign) would otherwise read as "+
                Uncleared -$X", two negatives layered on the same number. The
                operator itself flips to a real minus sign instead, and the
                amount goes through as its absolute value. */}
            <span className="text-muted">{unclearedCents < 0 ? ' − Uncleared ' : ' + Uncleared '}</span>
            <span>{formatUSD(Math.abs(unclearedCents))}</span>
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

      {/* The add row now lands on the SAME live gridTemplate the display rows
          and headers use (see renderEditRow's own doc comment for why that
          means two literal copies rather than one shared responsive grid: a
          `style` attribute always wins over a class, at every viewport, so
          the resizable template can't share a block with the phone's 2-col
          stack). Category picker, Show and the state they share (categoryId,
          showId, ...) live above with the rest of the add row's own state —
          kind isn't state at all anymore (Wave B Task 5): add() derives it
          from categoryId and whichever box below carries the amount. */}
      <div className="mb-3">
        {/* Desktop/tablet: fields under their own headers, Outflow/Inflow as
            real boxes instead of one Amount field plus an implied sign. */}
        <div className="hidden sm:block">
          {/* Same pl-3 -ml-3 pr-3 inset as the header/display rows below (they
              carry it directly on the grid itself; the edit row's desktop
              copy gets the same inset for free from renderDesktopRow's own
              wrapper, but nothing wraps the add row that way, so it needs its
              own copy here for the columns to land at the identical x
              positions). */}
          <div className="grid items-center gap-x-3 pl-3 -ml-3 pr-3" style={{ gridTemplateColumns: gridTemplate }}>
            <span aria-hidden />
            <input aria-label="Date" type="date" className={FIELD_FULL} value={date} disabled={pending}
                   onChange={(e) => setDate(e.target.value)} />
            <input aria-label="Payee" className={FIELD_FULL} placeholder="Payee" value={payee} disabled={pending}
                   onChange={(e) => setPayee(e.target.value)} />
            {/* Every kind offered here can carry a category now (C1: owner_pay
                got one back in 0038/0040 — this used to hide/disable the picker
                for that kind, which is exactly the bug that let the app keep
                nulling it out on every write). Transfer still cannot, but that's
                exactly what picking Payment/Transfer here means: category null,
                kind 'transfer' — the register's first form path that creates one
                (Wave B Task 5). */}
            <CategoryPicker
              ariaLabel="Category"
              value={categoryId}
              disabled={pending}
              onChange={setCategoryId}
              options={categoryPickerOptions}
              pinnedOptions={[{ id: '', label: 'Uncategorized' }, { id: TRANSFER_SENTINEL, label: 'Payment/Transfer' }]}
            />
            <input aria-label="Memo" className={FIELD_FULL} placeholder="Memo" value={memo} disabled={pending}
                   onChange={(e) => setMemo(e.target.value)} />
            <input aria-label="Outflow" inputMode="decimal" placeholder="0.00"
                   className={`${FIELD_FULL} tabular text-right`} value={outflowAmount} disabled={pending}
                   onChange={(e) => onOutflowChange(e.target.value)} />
            <input aria-label="Inflow" inputMode="decimal" placeholder="0.00"
                   className={`${FIELD_FULL} tabular text-right`} value={inflowAmount} disabled={pending}
                   onChange={(e) => onInflowChange(e.target.value)} />
            {/* Balance: a not-yet-saved row has none — left empty rather than
                guessing ahead of the server's own running total. */}
            <span aria-hidden />
            <span aria-hidden />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 sm:pl-9">
            <Select
              ariaLabel="Show"
              className="w-36"
              value={showId}
              disabled={pending}
              onChange={setShowId}
              options={showOptions}
            />
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
          {/* M2 (Wave B final review): a second, live copy of the shared
              `error` state, right under the row whose deriveKind refusal
              (H1/H2) most often produced it — the ORIGINAL single copy sits
              below all 328+ rows, effectively invisible. See renderEditRow's
              own doc comment on its matching copy, and the bottom node's own
              comment, for the full aria-hidden-to-avoid-double-announcement
              reasoning shared by all three copies. */}
          {error && editingId === null && <p role="alert" className="text-xs text-danger mt-2 sm:pl-9">{error}</p>}
        </div>

        {/* Phone: the same 2-col stacked idiom as before (Date+Payee,
            Category+Memo, Outflow+Inflow), Show/+Add on their own line
            beneath — same idiom the edit row's phone copy uses. Kept in step
            with the desktop copy above (same CategoryPicker pinnedOptions,
            same removed Kind Select) — see that copy's own comments. */}
        <div className="sm:hidden">
          <div className="grid gap-2 grid-cols-2 items-center">
            <input aria-label="Date" type="date" className={FIELD_FULL} value={date} disabled={pending}
                   onChange={(e) => setDate(e.target.value)} />
            <input aria-label="Payee" className={FIELD_FULL} placeholder="Payee" value={payee} disabled={pending}
                   onChange={(e) => setPayee(e.target.value)} />
            <CategoryPicker
              ariaLabel="Category"
              value={categoryId}
              disabled={pending}
              onChange={setCategoryId}
              options={categoryPickerOptions}
              pinnedOptions={[{ id: '', label: 'Uncategorized' }, { id: TRANSFER_SENTINEL, label: 'Payment/Transfer' }]}
            />
            <input aria-label="Memo" className={FIELD_FULL} placeholder="Memo" value={memo} disabled={pending}
                   onChange={(e) => setMemo(e.target.value)} />
            <input aria-label="Outflow" inputMode="decimal" placeholder="0.00"
                   className={`${FIELD_FULL} tabular text-right`} value={outflowAmount} disabled={pending}
                   onChange={(e) => onOutflowChange(e.target.value)} />
            <input aria-label="Inflow" inputMode="decimal" placeholder="0.00"
                   className={`${FIELD_FULL} tabular text-right`} value={inflowAmount} disabled={pending}
                   onChange={(e) => onInflowChange(e.target.value)} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Select
              ariaLabel="Show"
              className="w-36"
              value={showId}
              disabled={pending}
              onChange={setShowId}
              options={showOptions}
            />
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
          {/* Phone twin of the desktop copy above — same reasoning, same
              shared `error`. Only one of the two is ever in the accessible
              tree at once (Tailwind's hidden/sm:hidden is display:none, same
              guarantee the rest of this add row already relies on), so
              having both never double-announces. */}
          {error && editingId === null && <p role="alert" className="text-xs text-danger mt-2">{error}</p>}
        </div>
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

      {/* Pending (Wave C Task 4) — pinned above EVERYTHING below, both
          layouts, per the design doc's own "pinned above the dated list"
          (Dan's YNAB screenshot's "Pending Transactions" group). Hidden
          entirely at zero, same as the old uncleared-only phone group used
          to be (now "Uncleared", just below) — an empty header with an
          Enter All that would do nothing is worse than no section at all. */}
      {pendingQueue.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <p className="eyebrow">Pending ({pendingQueue.length})</p>
            <button
              type="button"
              onClick={enterAll}
              disabled={pending}
              className="text-xs font-semibold text-accent hover:opacity-80 disabled:opacity-40"
            >
              Enter All
            </button>
          </div>
          <div className="hidden sm:block">
            {pendingColumnHeader()}
            {pendingQueue.map(renderDesktopRow)}
          </div>
          <ul className="sm:hidden border-t border-line">
            {pendingQueue.map(renderPhoneRow)}
          </ul>
        </div>
      )}

      {transactions.length === 0 ? (
        <p className="text-muted border-l-2 border-line pl-4 py-1">
          {uncategorizedOnly ? 'Nothing uncategorized.' : 'No transactions yet.'}
        </p>
      ) : (
        <>
          {/* Desktop/tablet: a YNAB-style spreadsheet — one CSS grid per row,
              a shared column template (resizable via the header grips), matching the
              edit-mode grid the phone list below also drops into. Rows here are
              the NON-pending set (nonPending) — a pending row renders once, in
              the Pending section above, never twice. */}
          <div className="hidden sm:block">
            <div
              style={{ gridTemplateColumns: gridTemplate }}
              className="grid gap-x-3 pl-3 -ml-3 pr-3 pt-3 pb-2 mb-1 border-b border-line select-none
                         sticky top-16 z-10 bg-bg"
            >
              <span aria-hidden />
              <span className="eyebrow relative">Date{columnGrip('b1', 'right')}</span>
              <span ref={payeeHeadRef} className="eyebrow">Payee</span>
              <span className="eyebrow relative">
                Category{columnGrip('b2', 'left')}{columnGrip('b3', 'right')}
              </span>
              <span ref={memoHeadRef} className="eyebrow">Memo</span>
              <span className="eyebrow text-right relative">
                Outflow{columnGrip('b4', 'left')}{columnGrip('b5', 'right')}
              </span>
              <span className="eyebrow text-right relative">Inflow{columnGrip('b6', 'right')}</span>
              <span className="eyebrow text-right">Balance</span>
              <span aria-hidden />
            </div>
            {nonPending.map(renderDesktopRow)}
          </div>

          {/* Phone: YNAB-mobile's date-grouped list — an "Uncleared" section
              (Wave C's rename: the word "Pending" now belongs to the section
              above) for every uncleared, non-pending row, then one section
              per date. */}
          <div className="sm:hidden">
            {unclearedRows.length > 0 && (
              <div className="mb-2">
                <p className="eyebrow mb-2">Uncleared</p>
                <ul className="border-t border-line">
                  {unclearedRows.map(renderPhoneRow)}
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

      {/* M2 (Wave B final review): this was the ONLY render site for
          `error` — below all 328+ rows, effectively off-screen, which is
          exactly why deriveKind's refusals (H1/H2) were invisible when they
          fired. Two live copies now sit where the error actually happens
          (the add row's own second line, and the edit row's), both
          role="alert" — see their own comments. This one stays for the
          error sources that aren't add/edit at all (receipt upload,
          delete, the payee-memory sweep, ...), so those still have SOME
          on-screen surface even for a row scrolled far down. But it fires
          on the exact same `error` state as the two copies above, so
          whenever THEY fire, this one would too — aria-hidden here (rather
          than gating it off entirely, which would silence it for every
          error source that has no other copy at all) keeps it visually
          present without a screen reader announcing the same message a
          second or third time. */}
      {error && <p aria-hidden className="text-xs text-danger mt-3">{error}</p>}
    </section>
  )
}
