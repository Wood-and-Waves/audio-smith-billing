'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isPlainDate, todayInChicago } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import { DEFAULT_CATEGORIES, seedCategoryRows } from '@/lib/ledgerCategories'
import { clearedBalance, type BalanceLike } from '@/lib/ledgerBalance'
import { parseOfx, type ParsedOfx } from '@/lib/ofx'
import { planImport, type ExistingTxn } from '@/lib/ledgerImport'
import { normalizePayee, rememberedCategories, memoryKey } from '@/lib/payeeMemory'
import {
  validateTxnShape, isSaneLedgerDate, deriveKind, type LedgerKind, type CategoryForKind, type LedgerDirection,
} from '@/lib/ledgerRules'
import { decideIncomeRoleChange } from '@/lib/incomeRoleGuard'
import { amountLinkRefusal } from '@/lib/invoicePayment'
import { validateLegs, type SplitLegInput, type SplitParentPatch } from '@/lib/ledgerSplits'

type Fail = { error: string }

const SANE_DATE_ERROR = "That date is outside the ledger's range (1990–2100)."

// Same idiom as app/cal/[token]/route.ts and app/i/[token]/page.tsx: a
// malformed id is a driver error from Postgres, not a normal "not found" —
// guarded here because incomeRoleChangeAllowed below interpolates a
// caller-supplied category id straight into a PostgREST `.or(...)` filter
// string, which a shape check upstream of the query is cheaper (and safer)
// than trusting to fail correctly downstream.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Creates the one checking account a ledger starts from. */
export async function createLedgerAccount(input: {
  name: string
  openingBalanceCents: number
  openingDate: string
}): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const name = input.name.trim()
  if (!name) return { error: 'Give the account a name.' }
  if (!Number.isInteger(input.openingBalanceCents)) {
    return { error: 'Opening balance must be a whole number of cents.' }
  }
  if (!isPlainDate(input.openingDate)) return { error: 'Pick an opening date.' }
  if (!isSaneLedgerDate(input.openingDate)) return { error: SANE_DATE_ERROR }

  const { data, error } = await supabase
    .from('ledger_accounts')
    .insert({
      owner_id: user.id,
      name,
      opening_balance_cents: input.openingBalanceCents,
      opening_date: input.openingDate,
    })
    .select('id')
    .single()
  if (error) return { error: error.message }

  revalidatePath('/money')
  return { ok: true, id: data.id }
}

/**
 * Seeds the S-Corp starter chart of accounts the first time this owner opens
 * the ledger, and never again — a second call finding rows already there is
 * a normal page load, not a reason to double the list. Idempotent by count,
 * not by name-matching, so a category the owner has since renamed is not
 * mistaken for "missing" and reseeded next to itself.
 */
export async function ensureDefaultCategories(): Promise<Fail | { ok: true; seeded: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { count, error: countError } = await supabase
    .from('ledger_categories')
    .select('id', { count: 'exact', head: true })
  if (countError) return { error: countError.message }
  if ((count ?? 0) > 0) return { ok: true, seeded: 0 }

  // seedCategoryRows (lib/ledgerCategories) is the one place that builds this
  // shape — including budget_role, which a hand-written insert here dropped
  // before (I2): every seeded category landed on the DB's 'spending' default,
  // silently, with no visible symptom until Ready to Assign stopped matching
  // YNAB.
  const { error } = await supabase.from('ledger_categories').insert(seedCategoryRows(user.id))
  if (error) {
    // Migration 0028's unique index (owner_id, name) is the backstop for the
    // race this function's count-then-insert can't close on its own: two
    // first loads (a Next prefetch racing the real navigation is enough) can
    // both read zero categories and both attempt to seed. The second
    // writer's bulk insert now fails on that index instead of doubling every
    // category — that's this call losing the race, not a real failure, so it
    // reports the same "already seeded" outcome as the count check above.
    if (error.code === '23505') return { ok: true, seeded: 0 }
    return { error: error.message }
  }

  // No revalidatePath('/money') here — this runs during app/money/page.tsx's
  // own render (Next 16 throws if a revalidation runs mid-render, since it's
  // meant for the aftermath of a user-triggered Server Action, not a page's
  // own data loading), and that same render is about to read the categories
  // it just seeded fresh anyway, so there's nothing stale left to fix.
  return { ok: true, seeded: DEFAULT_CATEGORIES.length }
}

/**
 * Guards saveCategory's write against exactly the hazard
 * lib/incomeRoleGuard.ts's own comment describes: flipping an existing
 * category to budget_role 'income' silently drops it out of buildBudget's
 * spendingIds for every month, past included. Only called from the update
 * branch, and only when the caller asked for 'income' — a brand-new
 * category (id === null) can't have prior moves, a target, or transactions
 * yet, so it never needs this.
 *
 * The id is shape-checked against UUID before it touches any query: it's
 * caller-supplied and lands unescaped in the `.or(...)` filter string below,
 * so a malformed id is refused here rather than trusted to fail safely once
 * it reaches Postgres.
 *
 * All five reads (current role, moves, targets, transactions, splits) run
 * even when the category turns out to already be 'income' —
 * decideIncomeRoleChange short-circuits on that case, but fetching
 * unconditionally keeps this function simple and the query cost is one row
 * each, nowhere near hot. `error` on the current-role read is checked and
 * returned on before touching `current` at all, same fail-closed rule
 * decideIncomeRoleChange itself applies to the other four reads.
 *
 * `splits` (I3, Wave C final review) is the same `.limit(1)` EXISTS-shaped
 * read isSplitParent uses elsewhere in this file, scoped to category_id
 * instead of transaction_id: a category named only by a split leg — never
 * by a plain transaction's own category_id, which a split parent has
 * forced to null (migration 0042) — is invisible to the `transactions` read
 * above, so without this the guard would wave through a category whose leg
 * activity would silently start counting as Ready to Assign the instant the
 * role flips.
 */
async function incomeRoleChangeAllowed(
  supabase: Awaited<ReturnType<typeof createClient>>,
  categoryId: string,
): Promise<Fail | null> {
  if (!UUID.test(categoryId)) return { error: 'That category does not belong to you.' }

  const [
    { data: current, error: currentError },
    moves,
    targets,
    transactions,
    splits,
  ] = await Promise.all([
    supabase.from('ledger_categories').select('budget_role').eq('id', categoryId).maybeSingle(),
    supabase
      .from('ledger_budget_moves')
      .select('id')
      .or(`from_category_id.eq.${categoryId},to_category_id.eq.${categoryId}`)
      .is('undone_at', null)
      .limit(1),
    supabase.from('ledger_category_targets').select('id').eq('category_id', categoryId).limit(1),
    supabase.from('ledger_transactions').select('id').eq('category_id', categoryId).limit(1),
    supabase.from('ledger_transaction_splits').select('id').eq('category_id', categoryId).limit(1),
  ])
  if (currentError) return { error: currentError.message }
  const currentRole = (current?.budget_role === 'income' ? 'income' : 'spending') as 'spending' | 'income'

  return decideIncomeRoleChange(currentRole, moves, targets, transactions, splits)
}

/**
 * Creates or edits a category. A null id creates one, appended to the end of
 * its group (max sort in that group, plus one) so a new category never
 * jumps ahead of the ones the owner already ordered by hand.
 */
export async function saveCategory(input: {
  id: string | null
  name: string
  grp: string
  hidden: boolean
  isEquipment: boolean
  deductible: boolean
  /** 'income' rows are inflows to Ready to Assign, never budget rows (see
   *  lib/budget.ts's own BudgetCategory.budgetRole comment). Threaded
   *  through explicitly rather than inferred from `grp` — the DB column
   *  comment says why: group names are free text the owner can rename at
   *  will (I2). */
  budgetRole: 'spending' | 'income'
}): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const name = input.name.trim()
  const grp = input.grp.trim()
  if (!name) return { error: 'Give the category a name.' }
  if (!grp) return { error: 'Choose a group for this category.' }

  if (input.id === null) {
    // RLS already scopes this to the caller's own rows, same as every other
    // owner-scoped select in this file — no explicit owner_id filter needed.
    const { data: top, error: sortError } = await supabase
      .from('ledger_categories')
      .select('sort')
      .eq('grp', grp)
      .order('sort', { ascending: false })
      .limit(1)
    if (sortError) return { error: sortError.message }
    const nextSort = (top?.[0]?.sort ?? -1) + 1

    const { error } = await supabase.from('ledger_categories').insert({
      owner_id: user.id,
      name,
      grp,
      sort: nextSort,
      hidden: input.hidden,
      is_equipment: input.isEquipment,
      deductible: input.deductible,
      budget_role: input.budgetRole,
    })
    if (error) {
      // Migration 0028's unique index (owner_id, name) — same race
      // ensureDefaultCategories already guards against, but here it's a
      // genuine duplicate name Dan typed by hand, not a seeding race, so it
      // gets a message he can read instead of Postgres's raw constraint text.
      if (error.code === '23505') return { error: `You already have a category named "${name}".` }
      return { error: error.message }
    }
  } else {
    // Flipping to 'income' can silently rewrite every month buildBudget's
    // spendingIds covers — lib/incomeRoleGuard.ts carries the full hazard.
    // Checked before the write, not instead of it: a client-side
    // confirmation is a hint, this is the invariant.
    if (input.budgetRole === 'income') {
      const guardError = await incomeRoleChangeAllowed(supabase, input.id)
      if (guardError) return guardError
    }

    const { error } = await supabase
      .from('ledger_categories')
      .update({
        name, grp, hidden: input.hidden, is_equipment: input.isEquipment, deductible: input.deductible,
        budget_role: input.budgetRole,
      })
      .eq('id', input.id)
    if (error) {
      if (error.code === '23505') return { error: `You already have a category named "${name}".` }
      return { error: error.message }
    }
  }

  revalidatePath('/money')
  return { ok: true }
}

/**
 * Verifies a caller-supplied id actually belongs to this owner, the same way
 * createShow scopes a rate_card_id to its client and addExpense scopes a
 * receipt path to its show — a foreign key check inside Postgres runs with
 * elevated privilege and bypasses RLS, so an unscoped select is the only
 * thing standing between "my own category/show" and "any category/show that
 * exists at all".
 */
async function belongsToCaller(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: 'ledger_categories' | 'shows' | 'ledger_accounts',
  id: string,
): Promise<boolean> {
  const { data } = await supabase.from(table).select('id').eq('id', id).maybeSingle()
  return data !== null
}

/**
 * Does this transaction currently have any split legs? A single EXISTS-
 * shaped read (limit 1), fail-closed the same direction every other guard
 * read in this file fails: an ERROR must not be read as "no legs" — that
 * would let setTransactionCategory, its same-payee sweep, or
 * updateLedgerTransaction's amount edit silently treat a genuine split
 * parent as an ordinary row and write straight over what its legs already
 * say, rather than surfacing the refusal Task 3 asks for at the point of
 * the mistake (migration 0042's own deferred trigger would eventually catch
 * a bad amount edit at commit, but the friendly message here is meant to
 * beat that — see lib/ledgerSplits.ts's validateLegs doc comment for the
 * same "the app's own voice, before a doomed write" reasoning).
 */
async function isSplitParent(
  supabase: Awaited<ReturnType<typeof createClient>>,
  transactionId: string,
): Promise<Fail | { isSplit: boolean }> {
  const { data, error } = await supabase
    .from('ledger_transaction_splits').select('id').eq('transaction_id', transactionId).limit(1)
  if (error) return { error: error.message }
  return { isSplit: !!data && data.length > 0 }
}

const SPLIT_PARENT_ERROR = 'This is a split — edit its legs.'

type LedgerTxnRow = {
  id: string
  date: string
  amount_cents: number
  cleared: 'uncleared' | 'cleared' | 'reconciled'
  import_id: string | null
  source: 'manual' | 'import'
  // payee/category_id/kind ride along on every caller of this loader (not
  // just importOfx, which is the one that actually needs them to build
  // rememberedCategories) because they're cheap columns on an already-open
  // row and the alternative — parameterizing the select per caller — would
  // mean two near-identical paging loops to keep in sync instead of one.
  // reconcileAccount's cast to BalanceLike[] and importOfx's cast to
  // ExistingTxn[] both just ignore the extra fields; TS allows narrowing a
  // wider row to either the way it already narrowed to the plain ones.
  payee: string
  category_id: string | null
  kind: LedgerKind
  // Migration 0042: null = UNREVIEWED, meaning only "Dan hasn't looked at
  // this imported row yet." It is never an accounting gate — an unreviewed
  // row counts in the budget, the reports and the reconcile math exactly
  // like any other. So no caller of this loader branches on it today (the
  // pending-block refusal reconcileAccount used to run was removed on
  // 2026-08-25); it rides along for the same "cheap column on an already-
  // open row" reason as payee/category_id/kind above, and every caller's
  // cast simply ignores it.
  entered_at: string | null
}

const LEDGER_TXN_PAGE_SIZE = 1000

/**
 * Every ledger_transactions row for one account, paged past Supabase's
 * default 1000-row select cap (PostgREST's max_rows) — a plain, unranged
 * .select() silently truncates at row 1000 with no error, which would let
 * reconcileAccount lock in a cleared balance computed from an incomplete
 * row set, and let importOfx re-insert bank rows it can no longer see as
 * already-imported once an account passes 1000 transactions. Ordered by
 * (created_at, id) — a tiebreaker on id — so a page boundary can't skip or
 * duplicate a row even when two transactions share a created_at timestamp,
 * and paging stops as soon as a page comes back shorter than the page size.
 */
async function fetchAllLedgerTransactions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
): Promise<{ rows: LedgerTxnRow[]; error: string | null }> {
  const rows: LedgerTxnRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transactions')
      .select('id, date, amount_cents, cleared, import_id, source, payee, category_id, kind, entered_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as LedgerTxnRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

/** Records a hand-entered transaction. */
export async function addLedgerTransaction(input: {
  accountId: string
  date: string
  amountCents: number
  kind: LedgerKind
  categoryId: string | null
  showId: string | null
  payee: string
  memo: string
}): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!isPlainDate(input.date)) return { error: 'Pick a date.' }
  if (!isSaneLedgerDate(input.date)) return { error: SANE_DATE_ERROR }
  const shapeError = validateTxnShape(input)
  if (shapeError) return shapeError

  if (!(await belongsToCaller(supabase, 'ledger_accounts', input.accountId))) {
    return { error: 'That account does not belong to you.' }
  }
  if (input.categoryId !== null && !(await belongsToCaller(supabase, 'ledger_categories', input.categoryId))) {
    return { error: 'That category does not belong to you.' }
  }
  if (input.showId !== null && !(await belongsToCaller(supabase, 'shows', input.showId))) {
    return { error: 'That show does not belong to you.' }
  }

  const { data, error } = await supabase
    .from('ledger_transactions')
    .insert({
      owner_id: user.id,
      account_id: input.accountId,
      date: input.date,
      amount_cents: input.amountCents,
      kind: input.kind,
      category_id: input.categoryId,
      show_id: input.showId,
      payee: input.payee.trim(),
      memo: input.memo.trim() || null,
      // Wave C (migration 0042): entered_at null means UNREVIEWED, and the ONE
      // path allowed to insert null is the OFX importer (importOfx below).
      // A hand-entered row is entered by definition — the design doc's own
      // out-of-scope list — so this is set explicitly here, not left to the
      // column's default, the same discipline importOfx's own null is
      // explicit rather than an omission.
      entered_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) return { error: error.message }

  revalidatePath('/money')
  return { ok: true, id: data.id }
}

/**
 * Edits a transaction. Reads the row first, the same read-before-write shape
 * as setExpenseBillable's billed-show lock: a reconciled row has already
 * been matched against a bank statement, and rewriting its amount or kind
 * out from under that would leave the last reconciliation's own math
 * pointing at a transaction that no longer says what it said when it was
 * checked off.
 */
export async function updateLedgerTransaction(input: {
  id: string
  date: string
  amountCents: number
  kind: LedgerKind
  categoryId: string | null
  showId: string | null
  payee: string
  memo: string
}): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: existing } = await supabase
    .from('ledger_transactions').select('cleared, amount_cents, category_id').eq('id', input.id).maybeSingle()
  if (!existing) return { error: 'That transaction no longer exists.' }
  if (existing.cleared === 'reconciled') return { error: 'Reconciled transactions are locked.' }

  // Split-parent refusal (Task 3, Global Constraints): mirrors migration
  // 0042's own `ledger_transactions_refuse_amount_edit_with_legs` trigger —
  // same WHEN condition (only an actual amount change pays for the legs
  // lookup), same refusal, but caught here in the app's own friendly voice
  // ahead of the DB trigger's raw exception text. Payee/memo/date edits on
  // a split parent stay allowed; amount AND category changes are refused.
  // …and the same gate for a CATEGORY change (review catch): a stale edit
  // row opened before the row was split still holds its old category — a
  // save from that tab would silently un-null a split parent's category_id,
  // contradicting its legs AND letting payeeMemory (which skips splits only
  // via `category_id === null`) learn a category the row doesn't hold.
  // Payee/memo/date-only edits stay allowed either way.
  if (input.amountCents !== existing.amount_cents || input.categoryId !== existing.category_id) {
    const splitCheck = await isSplitParent(supabase, input.id)
    if ('error' in splitCheck) return splitCheck
    if (splitCheck.isSplit) return { error: SPLIT_PARENT_ERROR }
  }

  if (!isPlainDate(input.date)) return { error: 'Pick a date.' }
  if (!isSaneLedgerDate(input.date)) return { error: SANE_DATE_ERROR }
  const shapeError = validateTxnShape(input)
  if (shapeError) return shapeError

  if (input.categoryId !== null && !(await belongsToCaller(supabase, 'ledger_categories', input.categoryId))) {
    return { error: 'That category does not belong to you.' }
  }
  if (input.showId !== null && !(await belongsToCaller(supabase, 'shows', input.showId))) {
    return { error: 'That show does not belong to you.' }
  }

  const { error } = await supabase
    .from('ledger_transactions')
    .update({
      date: input.date,
      amount_cents: input.amountCents,
      kind: input.kind,
      category_id: input.categoryId,
      show_id: input.showId,
      payee: input.payee.trim(),
      memo: input.memo.trim() || null,
    })
    .eq('id', input.id)
  if (error) return { error: error.message }

  revalidatePath('/money')
  return { ok: true }
}

/**
 * Removes a transaction and any receipt files it carried. Same reconciled-
 * lock as updateLedgerTransaction; the receipt columns ride along on the
 * same select purely so the row is read once, not because they affect the
 * lock decision. A linked row is refused outright — see the link guard
 * below — the same unlink-first rule setInvoiceStatus enforces on its own
 * leaving-paid path.
 */
export async function deleteLedgerTransaction(
  id: string,
): Promise<Fail | { ok: true; warning?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: existing } = await supabase
    .from('ledger_transactions')
    .select('cleared, receipt_path, receipt_original')
    .eq('id', id).maybeSingle()
  if (!existing) return { error: 'That transaction no longer exists.' }
  if (existing.cleared === 'reconciled') return { error: 'Reconciled transactions are locked.' }

  // A linked row must be unlinked first — deleting a linked deposit would
  // strand a paid invoice whose deposit no longer exists (same for a linked
  // expense payment). Fail closed on either check: an ERROR must not read
  // as "nothing links it," the same rule unlinkTransaction's own comment
  // gives.
  const { data: invoiceLinks, error: invoiceLinksErr } = await supabase
    .from('ledger_transaction_invoices').select('id').eq('transaction_id', id).limit(1)
  if (invoiceLinksErr) return { error: invoiceLinksErr.message }
  const { data: expenseLinks, error: expenseLinksErr } = await supabase
    .from('ledger_transaction_expenses').select('id').eq('transaction_id', id).limit(1)
  if (expenseLinksErr) return { error: expenseLinksErr.message }
  if ((invoiceLinks && invoiceLinks.length > 0) || (expenseLinks && expenseLinks.length > 0)) {
    return { error: 'This row is linked. Unlink it first.' }
  }

  const { error } = await supabase.from('ledger_transactions').delete().eq('id', id)
  if (error) return { error: error.message }

  // Files after the row: an orphaned file costs storage, an orphaned row
  // costs a receipt that cannot be opened — same policy as expenses'
  // deleteExpense.
  const paths = [existing.receipt_path, existing.receipt_original].filter(Boolean) as string[]
  let warning: string | undefined
  if (paths.length) {
    const { error: storageError } = await supabase.storage.from('receipts').remove(paths)
    // The row is already gone by this point — there is nothing to roll back,
    // so a storage failure here is a warning about a leftover file, not a
    // reason to report the delete itself as failed.
    if (storageError) {
      warning = `The transaction was deleted, but its receipt file${paths.length === 1 ? '' : 's'} ` +
        `could not be removed from storage: ${storageError.message}`
    }
  }

  revalidatePath('/money')
  return warning ? { ok: true, warning } : { ok: true }
}

/**
 * Storage-path convention for every ledger receipt action below (migration
 * 0031's own comment): `{owner_id}/ledger/{stamp}-...`. Storage RLS
 * constrains writes to the caller's own folder[1] but says nothing about
 * which subfolder a path names — same reasoning as addExpense's show-prefix
 * check in app/expenses/actions.ts, narrowed to the fixed 'ledger' segment
 * instead of a per-show id.
 */
function ledgerReceiptPrefix(userId: string): string {
  return `${userId}/ledger/`
}

/**
 * Attaches a FIRST receipt to a transaction that was entered without one —
 * mirrors attachExpenseReceipt in app/expenses/actions.ts, minus that
 * action's billed-show freeze (the ledger has no equivalent frozen
 * artifact). Deliberately NOT gated on `cleared === 'reconciled'` the way
 * updateLedgerTransaction/deleteLedgerTransaction are: a receipt is audit
 * metadata, not a fact reconcileAccount's cleared-balance math reads, the
 * same reasoning setTransactionCategory's doc comment gives for leaving
 * categorization open on locked rows. Receipts also routinely arrive AFTER
 * the statement closes — Dan photographs a paper receipt whenever he gets to
 * it, which is often well after the bank line cleared — so gating this on
 * `cleared` would make attaching one impossible for exactly the rows most
 * likely to need it.
 */
export async function attachLedgerReceipt(
  txnId: string,
  enhancedPath: string,
  originalPath: string,
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: existing } = await supabase
    .from('ledger_transactions')
    .select('receipt_path, receipt_original')
    .eq('id', txnId).maybeSingle()
  if (!existing) return { error: 'That transaction no longer exists.' }

  if (existing.receipt_path || existing.receipt_original) {
    return { error: 'This transaction already has a receipt.' }
  }

  const prefix = ledgerReceiptPrefix(user.id)
  if (!enhancedPath.startsWith(prefix) || !originalPath.startsWith(prefix)) {
    return { error: 'That receipt was not uploaded to this ledger.' }
  }

  const { error } = await supabase
    .from('ledger_transactions')
    .update({ receipt_path: enhancedPath, receipt_original: originalPath })
    .eq('id', txnId)
  if (error) return { error: error.message }

  revalidatePath('/money')
  return { ok: true }
}

/**
 * Swaps a transaction's enhanced receipt for a freshly re-cropped one — the
 * fix-later flow, mirrors replaceExpenseReceipt. Same reconciled-exempt
 * reasoning as attachLedgerReceipt above: re-cropping changes only the
 * displayed image, never the amount/date/kind a reconciliation locked in.
 */
export async function replaceLedgerReceipt(
  txnId: string,
  newEnhancedPath: string,
): Promise<Fail | { ok: true; warning?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: existing } = await supabase
    .from('ledger_transactions')
    .select('receipt_path, receipt_original')
    .eq('id', txnId).maybeSingle()
  if (!existing) return { error: 'That transaction no longer exists.' }

  // This re-flattens an EXISTING original — never a back door for attaching
  // a first receipt to a row that never had one (that's attachLedgerReceipt).
  if (!existing.receipt_original) {
    return { error: 'This transaction has no original photo to re-crop.' }
  }

  const prefix = ledgerReceiptPrefix(user.id)
  if (!newEnhancedPath.startsWith(prefix)) {
    return { error: 'That receipt was not uploaded to this ledger.' }
  }

  const { error } = await supabase
    .from('ledger_transactions').update({ receipt_path: newEnhancedPath }).eq('id', txnId)
  if (error) return { error: error.message }

  // The row already points at the new file, so a failure to remove the old
  // one is only a leftover object in storage, not a broken transaction —
  // same warning-not-failure policy as deleteLedgerTransaction above.
  let warning: string | undefined
  if (existing.receipt_path && existing.receipt_path !== newEnhancedPath) {
    const { error: storageError } = await supabase.storage.from('receipts').remove([existing.receipt_path])
    if (storageError) {
      warning = `The receipt was swapped, but the old file could not be removed from storage: ${storageError.message}`
    }
  }

  revalidatePath('/money')
  return warning ? { ok: true, warning } : { ok: true }
}

/**
 * Strips a receipt off a transaction entirely — no expense equivalent exists
 * because an expense row can just be deleted and retyped; a ledger row often
 * can't be (reconciled rows are locked, and even an unreconciled row may
 * carry OFX import state Dan doesn't want to lose). Shipped in the SAME pass
 * as attach/replace rather than deferred: a wrong photo attached to a
 * reconciled row would otherwise be permanent, since neither
 * updateLedgerTransaction nor deleteLedgerTransaction can touch that row at
 * all, and there would be no other way off. Nulls both columns FIRST — the
 * row is the source of truth for what has a receipt, so a crash between the
 * write and the storage cleanup below leaves an orphaned file (a storage-cost
 * problem) rather than a row that still claims a receipt it can no longer
 * serve (a broken-link problem).
 */
export async function removeLedgerReceipt(
  txnId: string,
): Promise<Fail | { ok: true; warning?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: existing } = await supabase
    .from('ledger_transactions')
    .select('receipt_path, receipt_original')
    .eq('id', txnId).maybeSingle()
  if (!existing) return { error: 'That transaction no longer exists.' }

  const { error } = await supabase
    .from('ledger_transactions')
    .update({ receipt_path: null, receipt_original: null })
    .eq('id', txnId)
  if (error) return { error: error.message }

  const paths = [existing.receipt_path, existing.receipt_original].filter(Boolean) as string[]
  let warning: string | undefined
  if (paths.length) {
    const { error: storageError } = await supabase.storage.from('receipts').remove(paths)
    if (storageError) {
      warning = `The receipt was removed, but its file${paths.length === 1 ? '' : 's'} ` +
        `could not be removed from storage: ${storageError.message}`
    }
  }

  revalidatePath('/money')
  return warning ? { ok: true, warning } : { ok: true }
}

// The invoice/expense bridge (migration 0032): lib/ledgerMatch.ts proposes
// candidate links between bank rows and invoices/expenses, purely and
// statelessly — it holds no memory of what Dan already decided, so the four
// actions below are what turn a proposal into a fact (a link row, an
// invoice's paid_at, a txn's show_id) or suppress/undo one. Same shape as
// attachLedgerReceipt above: createClient -> auth guard -> RLS-scoped reads
// -> explicit guards -> writes with owner_id on inserts -> one revalidate
// block. Every guard re-verifies something the matcher already believed,
// because a server action is a public POST endpoint — the matcher's own
// read of the data is not binding here, only a fresh read is.

type BridgeInvoiceRow = {
  id: string
  number: number
  status: string
  total_cents: number
  client_id: string
  // A many-to-one FK (invoices.client_id -> clients.id) embeds as a single
  // object at runtime — same shape app/api/cron/reminders/route.ts casts to
  // for the same embed — never an array, whatever the generated types might
  // claim elsewhere.
  clients: { name: string } | null
}

/**
 * Links one deposit to the 1–3 invoices it paid — Streamline's habit of
 * paying two invoices with a single check is the reason the cap is 3, not 1.
 * Every check here re-verifies something lib/ledgerMatch.ts's proposal
 * already believed: the transaction is still an unlinked deposit, the
 * invoices still exist, are still billable, still belong to one client, and
 * still sum to the deposit. None of that is guaranteed to still be true by
 * the time the accept button is clicked — another tab, another import, or a
 * hand edit could have moved any of it in between.
 *
 * `settleMismatch` is the ONE relaxation, and only ever for a single
 * invoice: the caller is saying Dan looked at the gap and chose to settle
 * anyway (LinkPaymentPanel states the gap and asks). The Matches queue
 * never passes it, so an auto-proposed match still has to tie out exactly.
 */
export async function acceptIncomeMatch(input: {
  transactionId: string
  invoiceIds: string[]
  settleMismatch?: boolean
}): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const invoiceIds = input.invoiceIds
  if (invoiceIds.length < 1 || invoiceIds.length > 3) {
    return { error: 'Pick between 1 and 3 invoices.' }
  }
  if (new Set(invoiceIds).size !== invoiceIds.length) {
    return { error: 'The same invoice was picked twice.' }
  }

  const { data: txn } = await supabase
    .from('ledger_transactions')
    .select('id, date, amount_cents, kind, payee, show_id')
    .eq('id', input.transactionId)
    .maybeSingle()
  if (!txn) return { error: 'That transaction no longer exists.' }
  // Mirrors lib/ledgerMatch.ts's own candidate filter (kind === 'income' &&
  // amount_cents > 0) — a deposit is the only shape of row an invoice can
  // ever pay off.
  if (txn.kind !== 'income' || txn.amount_cents <= 0) {
    return { error: 'Only a deposit can be matched to an invoice.' }
  }
  // No review check here, deliberately. An UNREVIEWED row (entered_at null,
  // migration 0042) is an imported bank line Dan has not looked at yet, and
  // nothing more: it counts in every category, report, budget and forecast
  // the moment it lands. So it is ordinary money, and it can legitimately be
  // the deposit that paid an invoice — often it is the very row that tells
  // him the invoice got paid. entered_at is a review marker, never an
  // accounting gate.

  // Neither link table may already name this transaction — a bank row is
  // either an income link, an expense link, or unlinked, never two of those
  // at once. Fail-direction rule (see unlinkTransaction's own comment): an
  // ERROR here must not read as "no links of that kind" — that would let an
  // already-linked row link a second time.
  const { data: existingInvoiceLink, error: existingInvoiceLinkErr } = await supabase
    .from('ledger_transaction_invoices').select('id').eq('transaction_id', txn.id).limit(1)
  if (existingInvoiceLinkErr) return { error: existingInvoiceLinkErr.message }
  if (existingInvoiceLink && existingInvoiceLink.length > 0) {
    return { error: 'This transaction is already linked.' }
  }
  const { data: existingExpenseLink, error: existingExpenseLinkErr } = await supabase
    .from('ledger_transaction_expenses').select('id').eq('transaction_id', txn.id).limit(1)
  if (existingExpenseLinkErr) return { error: existingExpenseLinkErr.message }
  if (existingExpenseLink && existingExpenseLink.length > 0) {
    return { error: 'This transaction is already linked.' }
  }

  const { data: invoicesRaw, error: invoicesError } = await supabase
    .from('invoices')
    .select('id, number, status, total_cents, client_id, clients(name)')
    .in('id', invoiceIds)
  if (invoicesError) return { error: invoicesError.message }
  const invoices = (invoicesRaw ?? []) as unknown as BridgeInvoiceRow[]
  if (invoices.length !== invoiceIds.length) return { error: 'That invoice no longer exists.' }
  if (invoices.some((inv) => inv.status !== 'sent' && inv.status !== 'paid')) {
    return { error: 'Only a sent or paid invoice can be linked.' }
  }

  // Scoped to invoice_id alone, not (transaction_id, invoice_id) — an
  // invoice already linked to a DIFFERENT transaction is exactly as invalid
  // a target as one linked to this one; a link means paid in full, and an
  // invoice cannot be paid in full twice. Fail-direction rule applies here
  // too: an ERROR must not read as "none of these are linked."
  const { data: alreadyLinked, error: alreadyLinkedErr } = await supabase
    .from('ledger_transaction_invoices').select('invoice_id').in('invoice_id', invoiceIds)
  if (alreadyLinkedErr) return { error: alreadyLinkedErr.message }
  if (alreadyLinked && alreadyLinked.length > 0) {
    return { error: 'One of those invoices is already linked to a transaction.' }
  }

  if (new Set(invoices.map((inv) => inv.client_id)).size > 1) {
    return { error: 'Those invoices belong to different clients.' }
  }

  // The rule itself lives in lib/invoicePayment.ts so it can be tested. It
  // lets a SINGLE invoice be settled across a gap when the caller asked for
  // that deliberately, and never a combo: a mismatch spread over 2 or 3
  // invoices cannot be attributed to any one of them honestly, so no flag
  // relaxes it.
  const sumCents = invoices.reduce((t, inv) => t + inv.total_cents, 0)
  const refusal = amountLinkRefusal({
    sumCents,
    txnAmountCents: txn.amount_cents,
    invoiceCount: invoiceIds.length,
    settleMismatch: input.settleMismatch === true,
  })
  if (refusal) return { error: refusal }

  const { error: insertError } = await supabase.from('ledger_transaction_invoices').insert(
    invoiceIds.map((invoice_id) => ({ owner_id: user.id, transaction_id: txn.id, invoice_id })),
  )
  if (insertError) return { error: insertError.message }

  // .select('id') so an id RLS quietly filtered to nothing — not actually
  // possible here since the fetch above already proved ownership, but the
  // same defensive shape every other bulk update in this file uses — is
  // caught as a failure instead of a silent partial update.
  const { data: paidInvoices, error: paidError } = await supabase
    .from('invoices')
    .update({ status: 'paid', paid_at: txn.date })
    .in('id', invoiceIds)
    .select('id')
  if (paidError) return { error: paidError.message }
  if (!paidInvoices || paidInvoices.length !== invoiceIds.length) {
    return { error: 'Could not mark all invoices paid.' }
  }

  // Patched together as one update so a single-invoice accept on a showless,
  // payee-less row costs one extra write instead of two.
  const txnPatch: Record<string, unknown> = {}

  // Show tag: only for a single-invoice accept on a txn with no show yet —
  // a multi-invoice deposit spans more than one show by construction, so it
  // has no single show to tag. The fail-safe app/shows/[id]/page.tsx:152-168
  // already established for invoice coverage applies here too: an unknown
  // or ambiguous show count (0 or >1 rows) must never resolve to "the sole
  // show", so this only fires on an EXACT single row.
  if (invoiceIds.length === 1 && txn.show_id === null) {
    const { data: showRows } = await supabase
      .from('shows').select('id').eq('invoice_id', invoiceIds[0])
    if (showRows && showRows.length === 1) txnPatch.show_id = showRows[0].id
  }

  // Payee: only when the row still has none — never overwrite text Dan
  // typed by hand, even if it disagrees with the client name on the invoice.
  if (txn.payee.trim() === '') {
    const clientName = invoices[0].clients?.name
    if (clientName) txnPatch.payee = clientName
  }

  if (Object.keys(txnPatch).length > 0) {
    const { error: patchError } = await supabase
      .from('ledger_transactions').update(txnPatch).eq('id', txn.id)
    if (patchError) return { error: patchError.message }
  }

  // NO cleared-state check anywhere above: linking is audit metadata, the
  // third carve-out beside categorization (setTransactionCategory) and
  // receipts (attachLedgerReceipt) — see unlinkTransaction's own comment
  // below for the fuller reasoning, which applies symmetrically here.
  revalidatePath('/money')
  revalidatePath('/invoices')
  for (const id of invoiceIds) revalidatePath(`/invoices/${id}`)
  return { ok: true }
}

/**
 * Links the 1–3 bank rows that together paid one expense — Chase splitting a
 * single $40.25 Uber Eats charge into $33.25 + $7.00 across two statement
 * lines is the reason the cap is 3, not 1, mirroring acceptIncomeMatch's own
 * cap and re-verification reasoning above.
 */
export async function acceptExpenseMatch(input: {
  expenseId: string
  transactionIds: string[]
}): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const transactionIds = input.transactionIds
  if (transactionIds.length < 1 || transactionIds.length > 3) {
    return { error: 'Pick between 1 and 3 transactions.' }
  }
  if (new Set(transactionIds).size !== transactionIds.length) {
    return { error: 'The same transaction was picked twice.' }
  }

  const { data: expense } = await supabase
    .from('expenses').select('id, show_id, amount_cents').eq('id', input.expenseId).maybeSingle()
  if (!expense) return { error: 'That expense no longer exists.' }

  // Fail-direction rule (see unlinkTransaction's own comment): an ERROR here
  // must not read as "not yet linked" — that would let an already-linked
  // expense link a second time.
  const { data: existingExpenseLink, error: existingExpenseLinkErr } = await supabase
    .from('ledger_transaction_expenses').select('id').eq('expense_id', expense.id).limit(1)
  if (existingExpenseLinkErr) return { error: existingExpenseLinkErr.message }
  if (existingExpenseLink && existingExpenseLink.length > 0) {
    return { error: 'This expense is already linked.' }
  }

  const { data: txnsRaw, error: txnsError } = await supabase
    .from('ledger_transactions')
    .select('id, kind, amount_cents')
    .in('id', transactionIds)
  if (txnsError) return { error: txnsError.message }
  const txns = (txnsRaw ?? []) as { id: string; kind: string; amount_cents: number }[]
  if (txns.length !== transactionIds.length) return { error: 'That transaction no longer exists.' }
  // Mirrors lib/ledgerMatch.ts's own candidate filter (kind === 'expense' &&
  // amount_cents < 0) — a charge is the only shape of row an expense can
  // ever be reimbursed by.
  if (txns.some((t) => t.kind !== 'expense' || t.amount_cents >= 0)) {
    return { error: 'Only a payment can be matched to an expense.' }
  }

  // Neither link table may already name any of these transactions — same
  // either-table exclusivity acceptIncomeMatch checks on the txn side. Same
  // fail-direction rule as acceptIncomeMatch: an ERROR must not read as
  // "none of these are linked."
  const { data: linkedAsInvoice, error: linkedAsInvoiceErr } = await supabase
    .from('ledger_transaction_invoices').select('transaction_id').in('transaction_id', transactionIds)
  if (linkedAsInvoiceErr) return { error: linkedAsInvoiceErr.message }
  if (linkedAsInvoice && linkedAsInvoice.length > 0) {
    return { error: 'One of those transactions is already linked.' }
  }
  const { data: linkedAsExpense, error: linkedAsExpenseErr } = await supabase
    .from('ledger_transaction_expenses').select('transaction_id').in('transaction_id', transactionIds)
  if (linkedAsExpenseErr) return { error: linkedAsExpenseErr.message }
  if (linkedAsExpense && linkedAsExpense.length > 0) {
    return { error: 'One of those transactions is already linked.' }
  }

  // The over-sum refusal IS this equality: amount_cents is negative on every
  // txn (checked above) and positive on the expense (the DB's own
  // amount_cents > 0 check), so -sum must land exactly on the expense's
  // total, not merely cover it — a bank split that overshoots the expense by
  // even a cent is refused the same as one that falls short.
  const sumCents = txns.reduce((t, row) => t + row.amount_cents, 0)
  if (-sumCents !== expense.amount_cents) return { error: 'Those amounts do not add up.' }

  const { error: insertError } = await supabase.from('ledger_transaction_expenses').insert(
    transactionIds.map((transaction_id) => (
      { owner_id: user.id, transaction_id, expense_id: expense.id }
    )),
  )
  if (insertError) return { error: insertError.message }

  // The expense's own show is authoritative (expenses.show_id is not
  // null — every expense belongs to exactly one show), so every txn in the
  // group inherits it. Receipt columns are deliberately untouched: the
  // expense's photo surfaces via a display-time join (a later task), and
  // copying its path onto the txn would let removeLedgerReceipt delete the
  // expense's own file out from under it.
  const { data: taggedTxns, error: tagError } = await supabase
    .from('ledger_transactions')
    .update({ show_id: expense.show_id })
    .in('id', transactionIds)
    .select('id')
  if (tagError) return { error: tagError.message }
  if (!taggedTxns || taggedTxns.length !== transactionIds.length) {
    return { error: 'Could not tag all transactions with the show.' }
  }

  revalidatePath('/money')
  return { ok: true }
}

/**
 * Suppresses one or more proposed matches so lib/ledgerMatch.ts — pure and
 * stateless, recomputed fresh on every visit — stops re-offering them.
 * Existence of every named transaction/invoice/expense is checked with its
 * own RLS-scoped select BEFORE any insert, rather than trusting Postgres's
 * own foreign-key constraint to catch a bad id: an FK check runs with
 * elevated privilege and bypasses RLS, so an id belonging to another owner
 * would otherwise insert cleanly and poison this owner's dismissal list with
 * a foreign row's id.
 */
export async function dismissMatch(
  pairs: { transactionId: string; invoiceId?: string; expenseId?: string }[],
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (pairs.length < 1 || pairs.length > 3) {
    return { error: 'Pick between 1 and 3 matches to dismiss.' }
  }
  // Discriminated by migration 0032's own check (num_nonnulls(invoice_id,
  // expense_id) = 1) — a dismissal names one target, never both and never
  // neither.
  for (const pair of pairs) {
    const named = [pair.invoiceId, pair.expenseId].filter((v) => v !== undefined && v !== null)
    if (named.length !== 1) {
      return { error: 'Each dismissal names exactly one invoice or expense.' }
    }
  }

  const transactionIds = [...new Set(pairs.map((p) => p.transactionId))]
  const invoiceIds = [...new Set(pairs.map((p) => p.invoiceId).filter((v): v is string => v != null))]
  const expenseIds = [...new Set(pairs.map((p) => p.expenseId).filter((v): v is string => v != null))]

  const { data: txnRows } = await supabase.from('ledger_transactions').select('id').in('id', transactionIds)
  if (!txnRows || txnRows.length !== transactionIds.length) {
    return { error: 'That transaction no longer exists.' }
  }
  if (invoiceIds.length > 0) {
    const { data: invoiceRows } = await supabase.from('invoices').select('id').in('id', invoiceIds)
    if (!invoiceRows || invoiceRows.length !== invoiceIds.length) {
      return { error: 'That invoice no longer exists.' }
    }
  }
  if (expenseIds.length > 0) {
    const { data: expenseRows } = await supabase.from('expenses').select('id').in('id', expenseIds)
    if (!expenseRows || expenseRows.length !== expenseIds.length) {
      return { error: 'That expense no longer exists.' }
    }
  }

  // Two upsert calls, not one: migration 0032 gives ledger_match_dismissals
  // two separate UNIQUE constraints relying on NULLS DISTINCT — (transaction_id,
  // invoice_id) and (transaction_id, expense_id) — one per discriminant, so
  // onConflict has to name whichever one this batch of rows actually populates.
  const invoicePairs = pairs.filter((p) => p.invoiceId !== undefined && p.invoiceId !== null)
  const expensePairs = pairs.filter((p) => p.expenseId !== undefined && p.expenseId !== null)

  if (invoicePairs.length > 0) {
    const { error } = await supabase.from('ledger_match_dismissals').upsert(
      invoicePairs.map((p) => ({ owner_id: user.id, transaction_id: p.transactionId, invoice_id: p.invoiceId })),
      { onConflict: 'transaction_id,invoice_id', ignoreDuplicates: true },
    )
    if (error) return { error: error.message }
  }
  if (expensePairs.length > 0) {
    const { error } = await supabase.from('ledger_match_dismissals').upsert(
      expensePairs.map((p) => ({ owner_id: user.id, transaction_id: p.transactionId, expense_id: p.expenseId })),
      { onConflict: 'transaction_id,expense_id', ignoreDuplicates: true },
    )
    if (error) return { error: error.message }
  }

  revalidatePath('/money')
  return { ok: true }
}

/**
 * Undoes a dismissal — dismissMatch above is a one-way door on its own
 * (nothing else in this file ever deletes a ledger_match_dismissals row), so
 * this is the way back. lib/ledgerMatch.ts's proposeMatches is pure and
 * stateless, recomputed fresh on every visit, so deleting the suppression
 * row is the whole fix: the matcher re-proposes the pair on Dan's next visit
 * to /money/matches, if the transaction/invoice/expense involved are still
 * there and still eligible. Nothing here re-checks that eligibility — a
 * restored dismissal for a target that's since been linked or deleted just
 * won't resurface a proposal, which is fine.
 */
export async function restoreDismissal(id: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Fail-direction rule (see unlinkTransaction's own comment below): an
  // ERROR here must not read as "no such dismissal" — that would silently
  // no-op a restore instead of surfacing the real problem.
  const { data: existing, error: existingError } = await supabase
    .from('ledger_match_dismissals')
    .select('id')
    .eq('id', id)
    .eq('owner_id', user.id)
    .maybeSingle()
  if (existingError) return { error: existingError.message }
  if (!existing) return { error: 'That dismissal no longer exists.' }

  const { error } = await supabase
    .from('ledger_match_dismissals')
    .delete()
    .eq('id', id)
    .eq('owner_id', user.id)
  if (error) return { error: error.message }

  revalidatePath('/money')
  return { ok: true }
}

/**
 * Undoes a match — the only way to un-pay an invoice a deposit match paid,
 * since setInvoiceStatus refuses to move a linked invoice off 'paid' for
 * exactly this reason (see its own comment in app/invoices/actions.ts).
 *
 * NO cleared-state check: linking a bank row to an invoice or expense is
 * audit metadata, not a fact reconcileAccount's cleared-balance math reads —
 * the third carve-out beside categorization (setTransactionCategory's own
 * doc comment above) and receipts (attachLedgerReceipt's), so a reconciled
 * row links and unlinks exactly as freely as an uncleared one. Nothing here
 * touches amount_cents, date, or kind — the fields reconciliation actually
 * locks — or show_id/payee, which stay put on every affected row: once
 * written by an accept, they're Dan's data now, and clearing them is edit
 * mode's job, not unlink's.
 */
export async function unlinkTransaction(txnId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Fail-direction rule (named and explained further down, where the same
  // rule gates the invoice-restore loop): an ERROR on either fetch must not
  // read as "no links of that kind" — that would let the code below treat a
  // linked row as unlinked and skip deleting/restoring it.
  const { data: invoiceLinks, error: invoiceLinksErr } = await supabase
    .from('ledger_transaction_invoices').select('id, invoice_id').eq('transaction_id', txnId)
  if (invoiceLinksErr) return { error: invoiceLinksErr.message }
  const { data: expenseLinks, error: expenseLinksErr } = await supabase
    .from('ledger_transaction_expenses').select('id, expense_id').eq('transaction_id', txnId)
  if (expenseLinksErr) return { error: expenseLinksErr.message }

  const hasInvoiceLinks = !!invoiceLinks && invoiceLinks.length > 0
  const hasExpenseLinks = !!expenseLinks && expenseLinks.length > 0
  if (!hasInvoiceLinks && !hasExpenseLinks) {
    return { error: 'Nothing is linked to this transaction.' }
  }

  if (hasInvoiceLinks) {
    const { error } = await supabase.from('ledger_transaction_invoices').delete().eq('transaction_id', txnId)
    if (error) return { error: error.message }
  }

  // Expense groups dissolve whole: an expense split across N bank rows
  // (Chase's $33.25 + $7.00 for one $40.25 Uber Eats charge) is either fully
  // covered or not linked at all. Unlinking just THIS txn's own row and
  // leaving the expense's other link rows in place would strand it "linked"
  // to a lone $7.00 tip, breaking that invariant — so every link row for
  // each expense this txn named is deleted, not just this txn's.
  if (hasExpenseLinks) {
    const expenseIds = [...new Set(expenseLinks!.map((l) => l.expense_id))]
    const { error } = await supabase.from('ledger_transaction_expenses').delete().in('expense_id', expenseIds)
    if (error) return { error: error.message }
  }

  // Restore each formerly-linked invoice to 'sent' — but only the ones no
  // OTHER transaction still links (a second deposit's own, separate link on
  // an invoice must not get silently undone by unlinking the first).
  // Queried AFTER the delete above, so this row's own now-gone link never
  // counts as "still linked" against itself.
  if (hasInvoiceLinks) {
    for (const link of invoiceLinks!) {
      // Fail-direction rule: an ERROR here must not read as "nothing links it"
      // — that would revert a still-linked invoice to unpaid. Unknown blocks
      // the write, the same way an unknown show count never resolves to sole
      // coverage.
      const { data: stillLinked, error: stillErr } = await supabase
        .from('ledger_transaction_invoices').select('id').eq('invoice_id', link.invoice_id).limit(1)
      if (stillErr) return { error: stillErr.message }
      if (!stillLinked || stillLinked.length === 0) {
        const { error } = await supabase
          .from('invoices').update({ status: 'sent', paid_at: null }).eq('id', link.invoice_id)
        if (error) return { error: error.message }
      }
    }
  }

  revalidatePath('/money')
  revalidatePath('/invoices')
  if (hasInvoiceLinks) {
    for (const link of invoiceLinks!) revalidatePath(`/invoices/${link.invoice_id}`)
  }
  return { ok: true }
}

/**
 * Toggles the register checkmark. Never writes 'reconciled' — that state is
 * only ever reached through reconcileAccount below, which pairs it with a
 * statement and a ledger_reconciliations row; a bare checkbox click must not
 * be able to produce the same locked state on its own.
 */
export async function setTransactionCleared(
  id: string,
  cleared: 'uncleared' | 'cleared',
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: existing } = await supabase
    .from('ledger_transactions').select('cleared').eq('id', id).maybeSingle()
  if (!existing) return { error: 'That transaction no longer exists.' }
  if (existing.cleared === 'reconciled') return { error: 'Reconciled transactions are locked.' }

  const { error } = await supabase.from('ledger_transactions').update({ cleared }).eq('id', id)
  if (error) return { error: error.message }

  revalidatePath('/money')
  return { ok: true }
}

/**
 * Every OTHER row on `accountId` of the SAME kind as the source row, still
 * uncategorized, id and payee only — the paged fetchAllLedgerTransactions
 * pattern narrowed to what applyToSamePayee actually needs. category_id IS
 * NULL and kind = the source row's own kind run as real SQL filters (cheap,
 * exact) — narrowed to one kind, not `IN (income, expense)`, so a sweep from
 * an expense row can never reach into that payee's income rows (or the
 * reverse), matching payeeMemory's own kind-aware keying (lib/payeeMemory.ts,
 * memoryKey). Cleared state is deliberately NOT filtered — categorizing a
 * reconciled row changes no money and is allowed by design, same as the
 * un-gated update below. The payee match itself can't be a SQL filter:
 * normalizePayee's case-folding and whitespace-collapsing has no equivalent
 * here, so every candidate has to come back and get compared in JS.
 */
async function fetchUncategorizedSamePayeeCandidates(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
  excludeId: string,
  kind: 'income' | 'expense',
): Promise<{ rows: { id: string; payee: string }[]; error: string | null }> {
  const rows: { id: string; payee: string }[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transactions')
      .select('id, payee')
      .eq('account_id', accountId)
      .neq('id', excludeId)
      .is('category_id', null)
      .eq('kind', kind)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as { id: string; payee: string }[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

/**
 * Sets (or clears) one transaction's category. Deliberately NOT gated on
 * `cleared === 'reconciled'` the way updateLedgerTransaction is — a category
 * assignment moves no money and touches nothing reconcileAccount's cleared-
 * balance math depends on, so there is no reason to make an uncategorized
 * import sit locked forever just because it was swept into a reconciliation
 * before anyone got to it. Amount, date, and deletion stay locked through
 * updateLedgerTransaction/deleteLedgerTransaction; only category (and, since
 * H2, the kind it implies) is exempt.
 *
 * H2 (Wave B final review): this used to write category_id alone, leaving
 * kind whatever it already was. The register's edit form derives kind from
 * category + sign through lib/ledgerRules.ts's deriveKind (Wave B Task 5);
 * this inline picker didn't, so it could leave an expense sitting
 * uncategorized-in-spirit on the owner-pay category, or hand a row an
 * income-role category on an outflow — a shape deriveKind itself refuses,
 * permanently unsaveable through the edit form afterward, and payee memory
 * would then learn and reproduce it on every future import of that payee.
 * The fix is the same derivation, server-side: re-derive kind from the row's
 * OWN sign (never trust the client) and the category actually being
 * assigned, through the exact same deriveKind the add/edit forms call, and
 * write category_id and kind together so the two can never drift apart
 * again. A refusal here (only possible now: an income-role category on an
 * outflow row) returns the same structured `{ error }` shape every other
 * failure in this function already does — the inline picker's existing
 * error path (setRowCategory, MoneyRegister) surfaces it unchanged.
 *
 * `applyToSamePayee` is the sweep half of payee memory: rememberedCategories
 * (lib/payeeMemory) only pre-fills NEW imports, so the first time a payee is
 * categorized by hand there can already be a pile of older uncategorized
 * rows for it sitting in the register. Turning this on backfills exactly
 * those — fetchUncategorizedSamePayeeCandidates above already limits the
 * pool to uncategorized income/expense rows (a real owner_pay CANDIDATE row
 * is never touched by the sweep — it isn't in that pool), and the sweep
 * below reuses that same limit for the query. Off, or `categoryId` null
 * (clearing a category isn't something to fan out), it's a no-op and
 * `applied` reports 0. The sweep goes through the SAME re-derivation, but
 * without a second deriveKind call per candidate: every candidate shares
 * `sourceKind` (below, direction-derived — NOT `existing.kind`, see that
 * variable's own comment for why), and for an income/expense row kind and
 * amount sign always agree (validateTxnShape enforces income>0/expense<0 on
 * every write path that can produce one), so every candidate has the SAME
 * direction as the source row — deriveKind being a pure function of
 * (category, direction) alone means it would yield the exact same
 * `derived.kind` for each of them, including `owner_pay` when the category
 * being applied is the owner-pay one. Reusing `derived.kind` for every
 * candidate is correct, not a shortcut — MoneyRegister's own "Apply to all"
 * offers this sweep for an owner-pay pick same as any other; nothing about
 * this action refuses it.
 */
export async function setTransactionCategory(
  id: string,
  categoryId: string | null,
  applyToSamePayee = false,
): Promise<Fail | { ok: true; applied: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: existing } = await supabase
    .from('ledger_transactions').select('kind, account_id, payee, amount_cents').eq('id', id).maybeSingle()
  if (!existing) return { error: 'That transaction no longer exists.' }
  // A transfer moves money between your own accounts and never carries a
  // category (the DB still enforces this: lt_nocat_for_transfer, migration
  // 0038). Owner pay USED to be refused here too, but 0038 made it a real
  // budget category — this guard is deliberately narrower than
  // updateLedgerTransaction's validateTxnShape used to require.
  if (existing.kind === 'transfer') {
    return { error: 'Transfers do not use a category.' }
  }

  // Split-parent refusal (Task 3, Global Constraints): a split parent's
  // category is its legs, not this column (the RPC forces category_id to
  // null while legs exist) — picking a category here would write a value
  // the row's own legs immediately contradict. Checked before the category
  // walk below so a bad pick on a split parent never even gets that far.
  const splitCheck = await isSplitParent(supabase, id)
  if ('error' in splitCheck) return splitCheck
  if (splitCheck.isSplit) return { error: SPLIT_PARENT_ERROR }

  // Replaces the old bare belongsToCaller ownership check: name and
  // budget_role are exactly what deriveKind needs, and RLS still refuses a
  // category id that isn't the caller's own the same way belongsToCaller's
  // narrower `select('id')` did — a miss here (wrong owner or a stale id)
  // reads as "not found", same error text as before.
  let category: CategoryForKind = null
  if (categoryId !== null) {
    const { data: cat } = await supabase
      .from('ledger_categories').select('name, budget_role').eq('id', categoryId).maybeSingle()
    if (!cat) return { error: 'That category does not belong to you.' }
    category = { name: cat.name, budgetRole: cat.budget_role === 'income' ? 'income' : 'spending' }
  }
  const direction: LedgerDirection = existing.amount_cents > 0 ? 'inflow' : 'outflow'
  const derived = deriveKind(category, direction)
  if ('error' in derived) return { error: derived.error }

  const { error } = await supabase
    .from('ledger_transactions')
    .update({ category_id: categoryId, kind: derived.kind })
    .eq('id', id)
  if (error) return { error: error.message }

  let applied = 0
  // A blank payee matches nothing, deliberately: normalizePayee('') === '',
  // and sweeping every other payee-less row would categorize rows that share
  // no payee at all — the same rule rememberedCategories applies when it
  // refuses to learn from a blank payee.
  //
  // Browser verification (Wave B final review, post-H2): gated on
  // `sourceKind` (direction-derived, below) rather than `existing.kind` —
  // H2 itself made kind mutable on THIS row two statements up, and
  // MoneyRegister's own applyToAll ("Apply to all" under the prompt)
  // re-invokes this exact action a SECOND time on the SAME source row id,
  // now with `applyToSamePayee` true, after the FIRST call (the plain pick,
  // `setRowCategory`) already committed `kind: derived.kind` to it.
  // `existing.kind` used to mean "this row's kind before this pick"; on
  // that second call it instead reads back THIS ACTION'S OWN prior write.
  // For an ordinary category that's harmless (derived.kind already equalled
  // the row's kind), but for the owner-pay category specifically — the one
  // pick that actually changes kind, expense -> owner_pay — the second call
  // would see `existing.kind === 'owner_pay'`, fail the old gate, skip
  // fetchUncategorizedSamePayeeCandidates entirely, and return `applied: 0`:
  // "Apply to all" silently doing nothing on exactly the category this
  // feature exists to sweep (caught live in the browser: two same-payee
  // uncategorized rows, pick owner-pay on one, "Apply to all" on the
  // other — "Applied to 0 more rows" with a real candidate still sitting
  // uncategorized on screen). `direction` is the one fact about this row
  // this action can never have just changed (amount_cents is immutable
  // here), so `sourceKind` — what kind this row would carry with NO
  // category, the same fallback deriveKind itself applies to an
  // uncategorized row — is the stable value both the gate and the candidate
  // query actually want.
  const sourceKind: 'income' | 'expense' = direction === 'inflow' ? 'income' : 'expense'
  if (applyToSamePayee && categoryId !== null && normalizePayee(existing.payee) !== '') {
    // fetchUncategorizedSamePayeeCandidates below is typed to exactly
    // 'income' | 'expense' — sourceKind (LedgerDirection has only two
    // values) is always one of those, so no further narrowing is needed.
    // Passed through so the sweep can never cross from an expense row into
    // that payee's income rows (or the reverse) — the same kind-aware rule
    // payeeMemory's memoryKey enforces on the import side.
    const { rows: candidates, error: candidatesError } =
      await fetchUncategorizedSamePayeeCandidates(supabase, existing.account_id, id, sourceKind)
    if (candidatesError) return { error: candidatesError }

    const targetKey = normalizePayee(existing.payee)
    let ids = candidates
      .filter((c) => normalizePayee(c.payee) === targetKey)
      .map((c) => c.id)

    // Split parents are excluded from the sweep (Task 3, Global
    // Constraints — payee memory, and this sweep is its "applying" half,
    // skips split parents entirely). fetchUncategorizedSamePayeeCandidates'
    // own `category_id IS NULL` filter can't tell a real uncategorized row
    // from a split parent — the RPC forces a split parent's category_id to
    // null too — so a split parent sharing this payee would otherwise slip
    // through and have its (nonexistent) category silently overwritten out
    // from under its legs. Fail-closed: an ERROR here refuses the whole
    // sweep rather than risk applying over an unchecked split parent.
    if (ids.length > 0) {
      const { data: splitRows, error: splitRowsError } = await supabase
        .from('ledger_transaction_splits').select('transaction_id').in('transaction_id', ids)
      if (splitRowsError) return { error: splitRowsError.message }
      const splitIds = new Set((splitRows ?? []).map((r) => r.transaction_id as string))
      ids = ids.filter((candidateId) => !splitIds.has(candidateId))
    }

    if (ids.length > 0) {
      // derived.kind, not existing.kind — see this function's own doc
      // comment for why every candidate re-derives to the same kind as the
      // source row without a second deriveKind call.
      const { error: applyError } = await supabase
        .from('ledger_transactions')
        .update({ category_id: categoryId, kind: derived.kind })
        .in('id', ids)
      if (applyError) return { error: applyError.message }
      applied = ids.length
    }
  }

  revalidatePath('/money')
  return { ok: true, applied }
}

// ---------------------------------------------------------------------------
// Splits (Wave C Task 3) — replace_transaction_splits (migration 0042) is
// the ONE place legs are ever written; this pair of actions is a thin
// wrapper: ownership walks, validateLegs (lib/ledgerSplits.ts, Task 2) for
// the friendly refusal ahead of the DB trigger's, deriveKind
// (lib/ledgerRules.ts) per leg, then the RPC. The RPC itself re-checks
// ownership and does the balance/sign/count validation again at commit
// (the deferred trigger) — this action's own checks exist so a bad request
// refuses in the app's voice, not Postgres's raw exception text, same
// reasoning as every other guard read in this file.
// ---------------------------------------------------------------------------

/**
 * Replaces a transaction's split legs wholesale (delete-then-insert, inside
 * replace_transaction_splits). An empty `legs` array unsplits — the RPC's
 * own contract, see its doc comment in scripts/sql/migrations/
 * 0042_splits_and_pending.sql — so `unsplitTransaction` below is a one-line
 * wrapper around this same function rather than a second write path.
 *
 * Ownership is the transaction ROW's own owner_id (walked via a fail-closed
 * read of the row itself, not the account's — RLS already scopes the read
 * to the caller's own rows, so a miss here means "not found or not yours",
 * same as every other guard read in this file). A transfer is refused
 * outright: it moves money between Dan's own accounts and carries no
 * category to split across, the same rule setTransactionCategory already
 * enforces on the very same kind.
 *
 * Each leg's category is walked back to its own owner in ONE batched
 * `.in()` read (RLS-scoped, same "fewer round trips than legs" shape
 * acceptIncomeMatch's own invoice walk uses) — a leg naming a category id
 * that isn't the caller's own, or doesn't exist, refuses the whole replace
 * before any leg's kind is even derived, let alone the RPC called.
 *
 * Kind is derived per leg through deriveKind(category, direction) — the
 * SAME rule the register's edit row and setTransactionCategory both use,
 * no second derivation path — with `direction` read from the parent's
 * EFFECTIVE amount sign (the patch's when one rides along, the row's own
 * otherwise), not the leg's. validateLegs above already requires every
 * leg's sign to match the parent's, so this is not a second, independent
 * fact; it is the one fact every leg already agrees to, applied once
 * rather than re-derived per leg. An income-role category on a leg is
 * refused by deriveKind itself the same way the register refuses one on an
 * outflow row — there is no separate "assignable" check here: deriveKind's
 * own refusal IS the leg's refusal, so a leg is never held to a stricter or
 * looser rule than the row it would have been if it were never split.
 *
 * `parent` (migration 0045, Dan's "edit all figures at one time — that is
 * how YNAB works") carries the register edit row's own fields so the whole
 * save — total, date, payee, memo, show, AND legs — lands as ONE atomic
 * RPC call. It cannot be two writes from here: 0042's immediate trigger
 * refuses an amount change while legs exist, and its deferred trigger
 * refuses legs that don't sum to the parent at commit, so either ordering
 * of separate writes loses. Field validation mirrors
 * updateLedgerTransaction's own checks in the same voice. The PARENT's
 * kind is re-derived as deriveKind(null, direction) — a split parent's
 * category is null by construction (the RPC clears it), its true kinds
 * live on the legs (explodeForReports), and deriving from the null
 * category keeps 0027's kind/sign constraint satisfied even when the edit
 * flips the row's direction. A patch with zero legs is refused: removing
 * every leg is an unsplit, and MoneyRegister routes that through
 * unsplitTransaction + updateLedgerTransaction so the ordinary edit path's
 * own category/kind derivation applies (see saveSplit's comment there).
 */
export async function replaceSplits(
  transactionId: string,
  legs: SplitLegInput[],
  parent?: SplitParentPatch,
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (parent && legs.length === 0) {
    return { error: 'Removing every leg is an unsplit — save the row itself instead.' }
  }
  if (parent) {
    if (!isPlainDate(parent.date)) return { error: 'Pick a date.' }
    if (!isSaneLedgerDate(parent.date)) return { error: SANE_DATE_ERROR }
    if (!parent.payee.trim()) return { error: 'Say who this was to or from.' }
    if (!Number.isInteger(parent.amountCents) || parent.amountCents === 0) {
      return { error: 'Enter an amount.' }
    }
    if (parent.showId !== null && !(await belongsToCaller(supabase, 'shows', parent.showId))) {
      return { error: 'That show does not belong to you.' }
    }
  }

  const { data: existing, error: existingError } = await supabase
    .from('ledger_transactions')
    .select('amount_cents, kind, cleared')
    .eq('id', transactionId)
    .maybeSingle()
  if (existingError) return { error: existingError.message }
  if (!existing) return { error: 'That transaction no longer exists.' }
  // Same reconciled lock as updateLedgerTransaction/deleteLedgerTransaction
  // above (Wave C final review, S2): this action had NO server-side refusal
  // at all before this — SplitEditor simply never offered the "Split…" pin
  // on a reconciled row's edit form, which is a client habit, not a
  // boundary; a direct call (or a stale tab) reached the RPC unguarded. A
  // reconciled row has already been matched against a bank statement, so
  // rewriting its legs out from under that reconciliation is the same
  // hazard updateLedgerTransaction's own comment names for an amount edit —
  // refused here, before the RPC, in the app's own voice.
  //
  // NOT extended into a reconciled-splits carve-out even though "splitting
  // moves no money" is true (the parent's own amount_cents never changes
  // by this action): that's a deliberate future decision the controller is
  // backlogging, not something this fix also resolves. Refuse first;
  // loosen later only on purpose.
  if (existing.cleared === 'reconciled') return { error: 'Reconciled transactions are locked.' }
  // A transfer moves money between Dan's own accounts and never carries a
  // category (lt_nocat_for_transfer, migration 0038) — the same rule
  // setTransactionCategory enforces on this exact kind, applied here before
  // a transfer is ever handed a leg to disagree with.
  if (existing.kind === 'transfer') {
    return { error: 'Transfers do not use a category.' }
  }

  // The effective amount is what the row will hold AFTER this save — the
  // patch's when one rides along, the row's own otherwise. Legs balance
  // against it (Dan's rule: save refuses only when the splits don't
  // reconcile to $0 of THIS total), and direction below derives from it.
  const effectiveAmountCents = parent ? parent.amountCents : existing.amount_cents
  const shapeError = validateLegs(effectiveAmountCents, legs)
  if (shapeError) return { error: shapeError }

  const categoryIds = [...new Set(
    legs.map((leg) => leg.categoryId).filter((id): id is string => id !== null),
  )]
  const categoriesById = new Map<string, { name: string; budgetRole: 'spending' | 'income' }>()
  if (categoryIds.length > 0) {
    const { data: cats, error: catsError } = await supabase
      .from('ledger_categories')
      .select('id, name, budget_role')
      .in('id', categoryIds)
    if (catsError) return { error: catsError.message }
    // RLS already scopes this select to the caller's own categories, same
    // as acceptIncomeMatch's own invoice-count check — a length mismatch
    // means at least one leg named a category that isn't the caller's own
    // (or no longer exists), and the fail-closed rule this file applies
    // everywhere else means that refuses the WHOLE replace, not just that
    // one leg.
    if (!cats || cats.length !== categoryIds.length) {
      return { error: 'One of those categories does not belong to you.' }
    }
    for (const cat of cats) {
      categoriesById.set(cat.id, { name: cat.name, budgetRole: cat.budget_role === 'income' ? 'income' : 'spending' })
    }
  }

  const direction: LedgerDirection = effectiveAmountCents > 0 ? 'inflow' : 'outflow'
  const preparedLegs: { category_id: string | null; amount_cents: number; kind: LedgerKind; note: string | null }[] = []
  for (const leg of legs) {
    const category: CategoryForKind = leg.categoryId === null ? null : categoriesById.get(leg.categoryId) ?? null
    const derived = deriveKind(category, direction)
    if ('error' in derived) return { error: derived.error }
    preparedLegs.push({
      category_id: leg.categoryId,
      amount_cents: leg.amountCents,
      kind: derived.kind,
      note: leg.note?.trim() || null,
    })
  }

  // The parent's kind re-derives from the null category it will hold (the
  // RPC clears it whenever legs exist) — 'expense'/'income' by direction.
  // deriveKind(null, …) never refuses, so no error branch here; a split
  // parent's own kind is vestigial (every category- and report-shaped
  // consumer explodes to the legs' kinds instead), but 0027's kind/sign
  // constraint still reads it, and this keeps it true through a direction
  // flip.
  // deriveKind(null, …) is the table's own fall-through case and never
  // refuses today; the error branch below fails safe if that ever changes
  // rather than casting the union away.
  const parentKindResult = deriveKind(null, direction)
  if ('error' in parentKindResult) return parentKindResult
  const parentPatch = parent
    ? {
        date: parent.date,
        payee: parent.payee.trim(),
        memo: parent.memo?.trim() || null,
        show_id: parent.showId,
        amount_cents: parent.amountCents,
        kind: parentKindResult.kind,
      }
    : null

  const { error: rpcError } = await supabase.rpc('replace_transaction_splits', {
    p_transaction_id: transactionId,
    p_legs: preparedLegs,
    p_parent_patch: parentPatch,
  })
  if (rpcError) return { error: rpcError.message }

  revalidatePath('/money')
  return { ok: true }
}

/** Un-splits a transaction — a thin call to replaceSplits with zero legs,
 *  the RPC's own "empty array means unsplit" contract (see its doc comment,
 *  scripts/sql/migrations/0042_splits_and_pending.sql). Not a second write
 *  path: the ownership walk, transfer refusal, and revalidate all come from
 *  replaceSplits itself. */
export async function unsplitTransaction(transactionId: string): Promise<Fail | { ok: true }> {
  return replaceSplits(transactionId, [])
}

// ---------------------------------------------------------------------------
// Review markers (Wave C Task 3) — entered_at null means UNREVIEWED
// (migration 0042). NOT "pending": that word names the BANK's axis in this
// codebase (`cleared`, and the register's own "Pending" group), which is why
// the flag the register passes around is `isUnreviewed` and deliberately not
// `isPending`. Enter Now/Enter All share one action below; Reject is its own,
// since a reject both tombstones and deletes rather than merely flipping a
// column.
// ---------------------------------------------------------------------------

/**
 * Enters one or more UNREVIEWED transactions — Enter Now passes a single id,
 * Enter All passes the whole unreviewed queue; both are this same action, no
 * separate code path per the design doc's own naming. Ownership-scoped on
 * the update itself (`owner_id` in the WHERE, not just RLS) since this
 * writes straight from a caller-supplied id array with no prior per-row
 * read to walk ownership through first, unlike most other actions in this
 * file. `entered_at is null` in the same WHERE means an id that was already
 * entered (a race with another tab, or a stale queue on screen) is silently
 * skipped rather than refusing the whole batch or overwriting a real
 * entered_at with a later one.
 *
 * `wrote` reports how many rows actually changed — the same honesty
 * app/money/budget/actions.ts's WriteResult idiom uses ("a move actually
 * landed" vs. "correctly did nothing") — rather than collapsing "entered 3
 * of 5" and "entered 0 of 5, all already entered" into the same bare
 * `{ ok: true }`. An empty `ids` array is a no-op success, not a validation
 * error: Enter All on an empty unreviewed queue is a normal state, not a
 * mistake.
 */
export async function enterTransactions(ids: string[]): Promise<Fail | { ok: true; wrote: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return { ok: true, wrote: 0 }

  const { data, error } = await supabase
    .from('ledger_transactions')
    .update({ entered_at: new Date().toISOString() })
    .in('id', uniqueIds)
    .eq('owner_id', user.id)
    .is('entered_at', null)
    .select('id')
  if (error) return { error: error.message }

  revalidatePath('/money')
  return { ok: true, wrote: data?.length ?? 0 }
}

/**
 * Rejects a pending imported row — permanently: the transaction is deleted
 * and a tombstone is written to ledger_import_rejections so the same bank
 * row does not resurrect the next time this statement, or an overlapping
 * later one, is re-imported (importOfx below feeds every tombstoned
 * import_id into planImport's existing set for exactly this reason). Only a
 * PENDING, IMPORT-sourced row carrying an import_id can be rejected — a
 * hand-entered row has no import_id to tombstone against (and is entered by
 * definition, the design doc's own out-of-scope line), and an already-
 * entered row has already been approved: Enter Now is the way past pending,
 * not this.
 *
 * The tombstone INSERT happens BEFORE the transaction DELETE, not after —
 * deliberately the opposite order of "delete, then log it". A crash between
 * the two writes must leave the ledger_import_rejections row standing with
 * the transaction still present: the next import then treats that id as
 * already-existing and skips it (a stale pending row sitting in the
 * register a little too long — annoying, and correctable by hand), rather
 * than the transaction gone with no tombstone (the far worse failure: the
 * next import silently resurrects the very row Dan just rejected, with no
 * sign anything went wrong). A duplicate tombstone (Postgres 23505) means
 * this import_id was already rejected once before — not a failure, so the
 * delete below still proceeds, making a repeated reject call idempotent.
 *
 * Same link-guard and receipt cleanup as deleteLedgerTransaction above — a
 * reject IS a delete, and a rejected-but-linked row would strand a paid
 * invoice or a matched expense exactly the way an ordinary delete would;
 * see that function's own comments for the full reasoning, unchanged here.
 */
export async function rejectTransaction(
  id: string,
): Promise<Fail | { ok: true; warning?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: existing, error: existingError } = await supabase
    .from('ledger_transactions')
    .select('account_id, entered_at, cleared, source, import_id, receipt_path, receipt_original')
    .eq('id', id)
    .maybeSingle()
  if (existingError) return { error: existingError.message }
  if (!existing) return { error: 'That transaction no longer exists.' }
  // Reconcile locks a row on `cleared` alone (0029's RPC never reads
  // entered_at), so since the pending-block refusal was removed a row can be
  // BOTH reconciled and unreviewed. Every mutator that touches the money —
  // amount, date, kind, or the row's existence — honours that lock; the
  // carve-outs (categorization, linking, and setPayeeAlias's bulk rename)
  // only ever write display or audit text. Without this one, rejecting such a
  // row would delete it out of a closed reconciliation, leaving the cleared
  // balance short with no adjustment.
  if (existing.cleared === 'reconciled') return { error: 'Reconciled transactions are locked.' }
  if (existing.entered_at !== null) return { error: 'Only an unreviewed transaction can be rejected.' }
  if (existing.source !== 'import' || !existing.import_id) {
    return { error: 'Only an imported transaction can be rejected.' }
  }

  const { data: invoiceLinks, error: invoiceLinksErr } = await supabase
    .from('ledger_transaction_invoices').select('id').eq('transaction_id', id).limit(1)
  if (invoiceLinksErr) return { error: invoiceLinksErr.message }
  const { data: expenseLinks, error: expenseLinksErr } = await supabase
    .from('ledger_transaction_expenses').select('id').eq('transaction_id', id).limit(1)
  if (expenseLinksErr) return { error: expenseLinksErr.message }
  if ((invoiceLinks && invoiceLinks.length > 0) || (expenseLinks && expenseLinks.length > 0)) {
    return { error: 'This row is linked. Unlink it first.' }
  }

  const { error: tombstoneError } = await supabase.from('ledger_import_rejections').insert({
    owner_id: user.id,
    account_id: existing.account_id,
    import_id: existing.import_id,
  })
  if (tombstoneError && tombstoneError.code !== '23505') {
    return { error: tombstoneError.message }
  }

  const { error: deleteError } = await supabase
    .from('ledger_transactions').delete().eq('id', id).eq('owner_id', user.id)
  if (deleteError) return { error: deleteError.message }

  const paths = [existing.receipt_path, existing.receipt_original].filter(Boolean) as string[]
  let warning: string | undefined
  if (paths.length) {
    const { error: storageError } = await supabase.storage.from('receipts').remove(paths)
    if (storageError) {
      warning = `The transaction was rejected, but its receipt file${paths.length === 1 ? '' : 's'} ` +
        `could not be removed from storage: ${storageError.message}`
    }
  }

  revalidatePath('/money')
  return warning ? { ok: true, warning } : { ok: true }
}

// A real statement is a few hundred KB at most; this is a fat-finger/DoS
// guard on the string a browser hands the server action body, not a limit
// anyone should ever brush up against.
const MAX_OFX_TEXT_LENGTH = 2 * 1024 * 1024

const REJECTIONS_PAGE_SIZE = 1000

/**
 * Every tombstoned import_id for this account (ledger_import_rejections,
 * written by rejectTransaction above) — paged the same way
 * fetchAllLedgerTransactions pages ledger_transactions itself, for the same
 * reason: a plain unranged select silently truncates at PostgREST's 1000-row
 * cap, which here would mean a heavy rejecter's OLDEST rejections quietly
 * stop being consulted and start resurrecting. Fail-closed: an error aborts
 * the whole import rather than proceeding without consulting the tombstones,
 * the same rule fetchAllLedgerTransactions's own error already applies to
 * importOfx below.
 */
async function fetchTombstonedImportIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
): Promise<{ ids: string[]; error: string | null }> {
  const ids: string[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_import_rejections')
      .select('import_id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .range(from, from + REJECTIONS_PAGE_SIZE - 1)
    if (error) return { ids: [], error: error.message }
    ids.push(...((data ?? []).map((r) => r.import_id as string)))
    if (!data || data.length < REJECTIONS_PAGE_SIZE) break
    from += REJECTIONS_PAGE_SIZE
  }
  return { ids, error: null }
}

/**
 * Imports a downloaded bank statement into one account, via the pure
 * plan built by lib/ledgerImport.planImport. Three outcomes per bank row:
 * it already landed here before (duplicate), it adopts a manual row typed
 * in ahead of the statement (match), or it's genuinely new (insert). A
 * unique-violation on insert means a concurrent import already claimed that
 * import_id between planImport's read and this write — the same statement
 * uploaded twice at once is exactly the case the (owner_id, account_id,
 * import_id) index exists to make harmless, so that race counts as a
 * duplicate rather than failing the whole batch.
 */
export async function importOfx(
  accountId: string,
  fileText: string,
): Promise<Fail | {
  imported: number
  matched: number
  duplicates: number
  skipped: number
  statementBalanceCents: number | null
  autoCategorized: number
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (fileText.length > MAX_OFX_TEXT_LENGTH) {
    return { error: 'That file is too large to import.' }
  }

  // Ownership is a cheap indexed lookup; parsing is real work over text an
  // attacker fully controls. Check the account belongs to this caller before
  // spending any effort parsing what they uploaded.
  if (!(await belongsToCaller(supabase, 'ledger_accounts', accountId))) {
    return { error: 'That account does not belong to you.' }
  }

  let parsed: ParsedOfx
  try {
    parsed = parseOfx(fileText)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'That file could not be read.' }
  }

  // Same clean-abort shape as the parse failure above: a statement with even
  // one date outside the sane range refuses the WHOLE batch before any row is
  // written, rather than importing the good rows and silently skipping the
  // bad one — a partial import from a file that's actually corrupt (a
  // misread DTPOSTED, most likely) would be harder to notice and harder to
  // undo than just refusing the file.
  const badRow = parsed.transactions.find((t) => !isSaneLedgerDate(t.date))
  if (badRow) {
    return { error: `That statement has a transaction dated ${badRow.date}, outside the ledger's range (1990–2100).` }
  }

  const { rows: existingRows, error: existingError } = await fetchAllLedgerTransactions(supabase, accountId)
  if (existingError) return { error: existingError }

  const { ids: tombstonedIds, error: tombstonedError } = await fetchTombstonedImportIds(supabase, accountId)
  if (tombstonedError) return { error: tombstonedError }

  // Tombstoned ids (Wave C, rejectTransaction above) feed planImport's own
  // dedupe as synthetic already-imported stubs — only import_id matters:
  // planImport's existingImportIds set and its GEN occurrence counter both
  // read import_id alone, and findMatch can never treat a stub as a match
  // candidate (it requires source === 'manual' with import_id === null, and
  // a stub has neither). This array is passed to planImport ONLY — it's a
  // parallel, wider list, not a replacement for existingRows below, which
  // still drives match-application, payee memory, and everything else that
  // needs a REAL row's real columns.
  const existingForPlan: ExistingTxn[] = [
    ...(existingRows as ExistingTxn[]),
    ...tombstonedIds.map((import_id) => ({
      id: `tombstone:${import_id}`,
      date: '1970-01-01',
      amount_cents: 0,
      import_id,
      source: 'import' as const,
      cleared: 'cleared' as const,
    })),
  ]

  const plan = planImport(parsed.transactions, existingForPlan)

  // Payee memory (lib/payeeMemory): the existing rows this same fetch just
  // loaded already carry payee/category_id/kind, so the newest categorized
  // row per (kind, payee) teaches the category a brand-new insert of that
  // payee arrives with — no separate query, just a second read of the page
  // fetchAllLedgerTransactions already brought back.
  const remembered = rememberedCategories(existingRows)

  // Looked up (rather than threaded through plan.matches, which is pure and
  // doesn't carry it) so the match-application loop below can decide, per
  // row, whether adopting a bank line is allowed to write 'cleared' or must
  // preserve 'reconciled' — see the comment on that write.
  const existingClearedById = new Map(existingRows.map((r) => [r.id, r.cleared]))

  let matched = 0
  let duplicates = plan.duplicates.length

  for (const m of plan.matches) {
    // I2: adopting a match must never DOWNGRADE a row a prior reconciliation
    // already locked. planImport is free to match a reconciled manual row
    // (correct — it prevents the bank's later-arriving line from double-
    // booking it, see lib/ledgerImport.ts's own "still matchable" test); the
    // decision of what to WRITE afterward belongs here, not in that pure
    // planner. A row that was merely 'uncleared' still becomes 'cleared', as
    // before.
    const nextCleared = existingClearedById.get(m.existingId) === 'reconciled' ? 'reconciled' : 'cleared'
    // Guarded on import_id still being null: if a concurrent import already
    // claimed this manual row (see the doc comment above), this update
    // touches zero rows instead of overwriting a match someone else made.
    const { data: updated, error } = await supabase
      .from('ledger_transactions')
      .update({ import_id: m.importId, cleared: nextCleared })
      .eq('id', m.existingId)
      .is('import_id', null)
      .select('id')
    if (error) {
      // Same race as the insert loop below: a concurrent writer claimed this
      // import_id on the (owner_id, account_id, import_id) index between
      // planImport's read and this write. Count it as a duplicate instead of
      // failing the whole batch.
      if (error.code === '23505') { duplicates += 1; continue }
      return { error: error.message }
    }
    if (updated && updated.length > 0) matched += 1
    else duplicates += 1
  }

  // Aliases first, memory second — the ORDER is the point. Renaming
  // `STARBUCKS 8007827282 800-782-728` to `Starbucks` before the memory
  // lookup is what lets his 18 existing categorized Starbucks rows teach
  // this row its category. The other order would rename a row that had
  // already failed to match.
  const { data: aliasRows, error: aliasError } = await supabase
    .from('ledger_payee_aliases').select('raw_payee, display_name').eq('owner_id', user.id)
  if (aliasError) return { error: aliasError.message }
  const aliases = new Map<string, string>(
    (aliasRows ?? []).map((a) => [a.raw_payee as string, a.display_name as string]),
  )

  let imported = 0
  let autoCategorized = 0
  for (const ins of plan.inserts) {
    // The alias resolves FIRST, and both the memory lookup and the stored
    // payee use its result: the raw descriptor becomes the name he uses,
    // and only then is the memory asked what that name is categorized as.
    const payee = aliases.get(normalizePayee(ins.row.name)) ?? ins.row.name
    // Remembered category or null — keyed on (kind, payee) so an expense
    // teaching (e.g. "SQUARE INC" -> Bank Fees) can never pre-fill an
    // income row of the same payee, or the reverse (I1). Every plan.inserts
    // row is already income/expense (planImport's only two insert kinds),
    // so ins.kind is exactly what memoryKey wants; a payee with no memory
    // yet for that kind just gets null, same as before this feature existed.
    const categoryId = remembered.get(memoryKey(ins.kind, payee)) ?? null
    const { error } = await supabase.from('ledger_transactions').insert({
      owner_id: user.id,
      account_id: accountId,
      date: ins.row.date,
      amount_cents: ins.row.amountCents,
      kind: ins.kind,
      category_id: categoryId,
      payee,
      memo: ins.row.memo,
      cleared: 'cleared',
      import_id: ins.importId,
      source: 'import',
      // Wave C (migration 0042): the OFX importer is still the ONE path
      // allowed to insert entered_at null. What that null MEANS was
      // reversed on 2026-08-25 (Dan's call), and this is the line a reader
      // comes to when asking what it means at insert time: an inserted row
      // counts in the budget IMMEDIATELY, the moment it lands, exactly like
      // a hand-entered one. entered_at null marks it "not yet reviewed" and
      // nothing more — a to-do list, never an accounting gate, and never
      // the bank's axis (`cleared` above is that, and it lands 'cleared'
      // because the bank already settled it). Explicit null, not an
      // omission, the same discipline addLedgerTransaction's own explicit
      // timestamp uses on the opposite side of this one rule.
      entered_at: null,
    })
    if (error) {
      if (error.code === '23505') { duplicates += 1; continue }
      return { error: error.message }
    }
    imported += 1
    if (categoryId !== null) autoCategorized += 1
  }

  revalidatePath('/money')
  return {
    imported,
    matched,
    duplicates,
    skipped: plan.skipped.length,
    // parseOfx's own doc comment: null when the statement's BALAMT/LEDGERBAL
    // was absent or unparsable, which the caller treats as "no statement
    // balance to reconcile against yet," not an error.
    statementBalanceCents: parsed.ledgerBalanceCents,
    autoCategorized,
  }
}

/**
 * Remember that a bank descriptor means this name, and apply it backwards.
 *
 * Dan confirms a suggestion once per merchant (his decision, 2026-08-25 — no
 * silent auto-merging). Writing the alias also renames every existing row
 * carrying that exact raw payee, so one confirmation cleans up the rows
 * already imported as well as every future one. `raw` is normalized on the
 * way in so a lookup can never miss on case or spacing.
 *
 * Upsert, not insert: confirming a different name for the same descriptor
 * later must correct the alias rather than fail on the unique constraint.
 *
 * The correction trap, and why there are two branches below. After the first
 * confirmation the rows on screen no longer carry the bank descriptor — they
 * carry the NAME. So the SECOND time he renames that payee, what arrives here
 * as `rawPayee` is `Starbucks`, not `STARBUCKS 8007827282 800-782-728`.
 * Upserting THAT would key a brand-new alias on `starbucks` and leave the
 * first one — the only alias an import's descriptor can ever match — still
 * saying `Starbucks`. Aliases are applied once and never chained
 * (lib/payeeName), so the new one would never fire: next month's row would
 * import as `Starbucks` while every row in the register reads `Starbucks
 * Coffee`, payee memory would look up a name no row carries any more, miss,
 * and the row would land UNCATEGORIZED — the exact state this feature exists
 * to prevent — with no rename chip offered to fix it, because that descriptor
 * already counts as aliased. So a `rawPayee` that is itself the display_name
 * of an alias he has already confirmed is a CORRECTION, not a new alias:
 * rewrite that alias's display_name in place and KEEP its raw_payee, which is
 * the real descriptor imports actually match on. Only a `rawPayee` that is
 * NOT an existing display name is a first confirmation, and only that one
 * upserts on the normalized descriptor. Both branches then run the same row
 * rename below, which matches on `rawPayee` — the un-normalized string the
 * rows themselves actually carry — so the books get cleaned up either way.
 */
export async function setPayeeAlias(
  rawPayee: string,
  displayName: string,
): Promise<Fail | { ok: true; renamed: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const raw = normalizePayee(rawPayee)
  const name = displayName.trim()
  if (raw === '') return { error: 'That payee is empty.' }
  if (name === '') return { error: 'Give the payee a name.' }

  // Correction branch first (see the doc comment's "correction trap"): if
  // `rawPayee` is the display_name of an alias he already confirmed, this
  // edit is fixing THAT alias, so its own raw_payee — the descriptor — has to
  // survive. Written as an update-and-count rather than a read-then-branch so
  // one statement both decides the branch and covers the case where several
  // descriptors were all confirmed to the same name (two Starbucks
  // descriptors, both named `Starbucks`): every row on screen reading that
  // name came from one of them, so every one of them gets corrected. An error
  // here returns instead of falling through, the fail-closed direction every
  // guard read in this file takes: reading a failure as "no such display
  // name" would drop us into the upsert and write the very orphan alias this
  // branch exists to prevent.
  const { data: correctedAliases, error: correctionError } = await supabase
    .from('ledger_payee_aliases')
    .update({ display_name: name })
    .eq('owner_id', user.id)
    .eq('display_name', rawPayee.trim())
    .select('id')
  if (correctionError) return { error: correctionError.message }

  if ((correctedAliases ?? []).length === 0) {
    // Not a correction, so this is the first confirmation for a real bank
    // descriptor: key the alias on the NORMALIZED descriptor, which is what
    // an import's lookup will hand it.
    const { error: upsertError } = await supabase
      .from('ledger_payee_aliases')
      .upsert(
        { owner_id: user.id, raw_payee: raw, display_name: name },
        { onConflict: 'owner_id,raw_payee' },
      )
    if (upsertError) return { error: upsertError.message }
  }

  // Rename what is already in the books. Owner-scoped explicitly, not just
  // by RLS, because this is a bulk write keyed on a caller-supplied string.
  //
  // NO `cleared` filter, deliberately — a documented carve-out from the
  // reconciled lock, the same kind categorization (setTransactionCategory)
  // and linking (unlinkTransaction) already are. A payee rename moves no
  // money: it touches neither amount_cents nor date nor kind, the fields
  // reconcileAccount's cleared-balance math actually reads, so a reconciled
  // row renamed here still reconciles to the same statement it always did.
  // It is display text. And skipping reconciled rows would defeat the whole
  // point of renaming backwards: the OLDEST rows are exactly the ones already
  // reconciled, so the ugly descriptor would survive on the bulk of his
  // history — the mess this feature exists to clear.
  const { data: renamedRows, error: renameError } = await supabase
    .from('ledger_transactions')
    .update({ payee: name })
    .eq('owner_id', user.id)
    .eq('payee', rawPayee)
    .select('id')
  if (renameError) return { error: renameError.message }

  revalidatePath('/money')
  return { ok: true, renamed: (renamedRows ?? []).length }
}

/**
 * Closes out an account against a bank statement. Cleared balance (lib/
 * ledgerBalance) is what the register believes the bank has confirmed so
 * far; the gap between that and what the bank actually says is either fixed
 * by editing the mismatched transactions, or booked as a single adjustment
 * row (the YNAB move) so reconciling isn't blocked on hunting down a
 * stray penny. Either way, every 'cleared' row — including the adjustment,
 * once it exists — is then locked to 'reconciled' together, because they
 * were all just confirmed against the same statement.
 *
 * Three-way return, not just Fail | ok: a no-adjustment mismatch is a normal,
 * expected outcome (the caller is meant to offer booking an adjustment), not
 * an error — so it gets its own `{ mismatch: true, ... }` variant instead of
 * being squeezed into `Fail` and told apart from a real failure by pattern-
 * matching the message text. LedgerReconcile narrows on `'mismatch' in
 * result`; a genuine `Fail` never carries that key.
 */
export async function reconcileAccount(input: {
  accountId: string
  statementBalanceCents: number
  reconciledOn: string
  createAdjustment: boolean
}): Promise<Fail | { ok: true; adjustedCents: number } | { mismatch: true; diffCents: number; message: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!isPlainDate(input.reconciledOn)) return { error: 'Pick a reconciliation date.' }
  if (!Number.isInteger(input.statementBalanceCents)) {
    return { error: 'Enter the statement balance.' }
  }

  const { data: account } = await supabase
    .from('ledger_accounts')
    .select('opening_balance_cents')
    .eq('id', input.accountId)
    .maybeSingle()
  if (!account) return { error: 'That account does not belong to you.' }

  const { rows: allRows, error: rowsError } = await fetchAllLedgerTransactions(supabase, input.accountId)
  if (rowsError) return { error: rowsError }

  // I5: both the cleared-balance math AND the lock pass below are scoped to
  // rows dated on or before the statement date. A row Dan hand-cleared for a
  // date AFTER `reconciledOn` (a scheduled payment ticked off early, say)
  // hasn't been confirmed by THIS statement — the bank hasn't reported it
  // yet. Counting it toward `cleared` would skew the diff against a balance
  // the bank never actually stated, and locking it now would freeze it
  // before its own statement even arrives. Filtered here in JS rather than a
  // query-level range because fetchAllLedgerTransactions is the one already-
  // paged loader every account-wide read in this file shares; a plain string
  // compare is safe since `date` is always YYYY-MM-DD (isPlainDate, checked
  // above), which sorts identically to a real date compare.
  const rows = allRows.filter((r) => r.date <= input.reconciledOn)

  // No unreviewed-row refusal here any more (removed 2026-08-25): Wave C
  // had reconcile stop while any row with entered_at null sat at or before
  // the statement date. Dan reversed that — entered_at is a review marker,
  // not an accounting gate, and an imported row is as real to the statement
  // as any other. Those rows already counted toward `cleared` below (his
  // own balance semantics), so nothing about the statement math changes;
  // only the refusal is gone.
  const cleared = clearedBalance(account.opening_balance_cents, rows as BalanceLike[])
  const diff = input.statementBalanceCents - cleared

  if (diff !== 0 && !input.createAdjustment) {
    // A distinct `mismatch` variant, not a Fail: the caller (LedgerReconcile)
    // needs to tell "the numbers don't match yet" apart from every other way
    // this action can fail, so it can offer the adjustment button only for
    // this one case. Encoding that in the return type means a reworded
    // message can never silently break that branch the way string-matching
    // on `error` did before.
    return {
      mismatch: true,
      diffCents: diff,
      message: `The register is off from the statement by ${formatUSD(diff)}. Fix the mismatched ` +
        'transactions, or turn on "create adjustment" to book the difference and close out.',
    }
  }

  // From here down, this action only DECIDES — the diff above, and whether
  // it should be booked as an adjustment. Migration 0029's
  // reconcile_ledger_account APPLIES that decision: lock the cleared rows,
  // book the adjustment (if any) as merely 'cleared' — never straight to
  // 'reconciled', so a mis-keyed statement balance is still correctable up
  // until the NEXT reconcile locks it in — write the reconciliation record,
  // and stamp last_reconciled_at, all as one transaction. The four separate
  // writes this action used to make by hand (adjustment insert, lock update,
  // reconciliation insert, account update) are gone; a failure partway
  // through used to leave rows locked with no reconciliation record and no
  // way back, which a single atomic function can't do. p_adjustment_cents is
  // 0 unless this is the createAdjustment path — a plain reconcile that
  // already matches the statement books nothing. The function's own CASE
  // (p_adjustment_cents > 0 -> income, else expense) is exactly the sign
  // validateTxnShape/the DB's check constraints would require of a manual
  // row with this amount, so nothing bypasses lt_income_positive /
  // lt_outflow_negative by going through the RPC instead of a normal insert.
  const { error: rpcError } = await supabase.rpc('reconcile_ledger_account', {
    p_account: input.accountId,
    p_statement_cents: input.statementBalanceCents,
    p_reconciled_on: input.reconciledOn,
    p_adjustment_cents: diff !== 0 && input.createAdjustment ? diff : 0,
  })
  if (rpcError) return { error: rpcError.message }

  revalidatePath('/money')
  return { ok: true, adjustedCents: diff }
}
