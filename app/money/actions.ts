'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isPlainDate } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import { DEFAULT_CATEGORIES } from '@/lib/ledgerCategories'
import { clearedBalance, type BalanceLike } from '@/lib/ledgerBalance'
import { parseOfx, type ParsedOfx } from '@/lib/ofx'
import { planImport, type ExistingTxn } from '@/lib/ledgerImport'

type Fail = { error: string }

type LedgerKind = 'income' | 'expense' | 'owner_pay' | 'transfer'
const VALID_KINDS: readonly LedgerKind[] = ['income', 'expense', 'owner_pay', 'transfer']

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

/** Renames an account or opens/closes it. Opening balance and date are frozen at creation. */
export async function updateLedgerAccount(input: {
  id: string
  name: string
  closed: boolean
}): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const name = input.name.trim()
  if (!name) return { error: 'Give the account a name.' }

  const { error } = await supabase
    .from('ledger_accounts')
    .update({ name, closed: input.closed })
    .eq('id', input.id)
  if (error) return { error: error.message }

  revalidatePath('/money')
  return { ok: true }
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

  const { error } = await supabase.from('ledger_categories').insert(
    DEFAULT_CATEGORIES.map((c) => ({
      owner_id: user.id,
      name: c.name,
      grp: c.grp,
      sort: c.sort,
      deductible: c.deductible,
      is_equipment: c.is_equipment,
    })),
  )
  if (error) return { error: error.message }

  revalidatePath('/money')
  return { ok: true, seeded: DEFAULT_CATEGORIES.length }
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
    })
    if (error) return { error: error.message }
  } else {
    const { error } = await supabase
      .from('ledger_categories')
      .update({ name, grp, hidden: input.hidden, is_equipment: input.isEquipment })
      .eq('id', input.id)
    if (error) return { error: error.message }
  }

  revalidatePath('/money')
  return { ok: true }
}

/**
 * Mirrors the DB's own check constraints (lt_income_positive,
 * lt_outflow_negative, lt_nocat_for_owner_or_transfer — migration 0027) so a
 * bad row is refused with a message a human can read, before it ever reaches
 * Postgres's raw constraint-violation text.
 */
function validateTxnShape(input: {
  amountCents: number
  kind: string
  categoryId: string | null
}): Fail | null {
  if (!VALID_KINDS.includes(input.kind as LedgerKind)) {
    return { error: `"${input.kind}" is not a transaction kind.` }
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) {
    return { error: 'Enter a nonzero amount.' }
  }
  if (input.kind === 'income' && input.amountCents <= 0) {
    return { error: 'Income must be a positive amount.' }
  }
  if (input.kind === 'expense' && input.amountCents >= 0) {
    return { error: 'Expenses must be a negative amount.' }
  }
  if (input.kind === 'owner_pay' && input.amountCents >= 0) {
    return { error: 'Owner pay must be a negative amount.' }
  }
  // Paying yourself is not a deduction, and a transfer moves money between
  // your own accounts — neither ever carries a category (the DB agrees: see
  // lt_nocat_for_owner_or_transfer).
  if ((input.kind === 'owner_pay' || input.kind === 'transfer') && input.categoryId !== null) {
    return { error: 'Owner pay and transfers do not use a category.' }
  }
  return null
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

type LedgerTxnRow = {
  id: string
  date: string
  amount_cents: number
  cleared: 'uncleared' | 'cleared' | 'reconciled'
  import_id: string | null
  source: 'manual' | 'import'
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
      .select('id, date, amount_cents, cleared, import_id, source')
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
    .from('ledger_transactions').select('cleared').eq('id', input.id).maybeSingle()
  if (!existing) return { error: 'That transaction no longer exists.' }
  if (existing.cleared === 'reconciled') return { error: 'Reconciled transactions are locked.' }

  if (!isPlainDate(input.date)) return { error: 'Pick a date.' }
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

/** Removes a transaction. Same reconciled-lock as updateLedgerTransaction. */
export async function deleteLedgerTransaction(id: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: existing } = await supabase
    .from('ledger_transactions').select('cleared').eq('id', id).maybeSingle()
  if (!existing) return { error: 'That transaction no longer exists.' }
  if (existing.cleared === 'reconciled') return { error: 'Reconciled transactions are locked.' }

  const { error } = await supabase.from('ledger_transactions').delete().eq('id', id)
  if (error) return { error: error.message }

  revalidatePath('/money')
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

// A real statement is a few hundred KB at most; this is a fat-finger/DoS
// guard on the string a browser hands the server action body, not a limit
// anyone should ever brush up against.
const MAX_OFX_TEXT_LENGTH = 2 * 1024 * 1024

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
): Promise<Fail | { imported: number; matched: number; duplicates: number; skipped: number }> {
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

  const { rows: existingRows, error: existingError } = await fetchAllLedgerTransactions(supabase, accountId)
  if (existingError) return { error: existingError }

  const plan = planImport(parsed.transactions, existingRows as ExistingTxn[])

  let matched = 0
  let duplicates = plan.duplicates.length

  for (const m of plan.matches) {
    // Guarded on import_id still being null: if a concurrent import already
    // claimed this manual row (see the doc comment above), this update
    // touches zero rows instead of overwriting a match someone else made.
    const { data: updated, error } = await supabase
      .from('ledger_transactions')
      .update({ import_id: m.importId, cleared: 'cleared' })
      .eq('id', m.existingId)
      .is('import_id', null)
      .select('id')
    if (error) return { error: error.message }
    if (updated && updated.length > 0) matched += 1
    else duplicates += 1
  }

  let imported = 0
  for (const ins of plan.inserts) {
    const { error } = await supabase.from('ledger_transactions').insert({
      owner_id: user.id,
      account_id: accountId,
      date: ins.row.date,
      amount_cents: ins.row.amountCents,
      kind: ins.kind,
      category_id: null,
      payee: ins.row.name,
      memo: ins.row.memo,
      cleared: 'cleared',
      import_id: ins.importId,
      source: 'import',
    })
    if (error) {
      if (error.code === '23505') { duplicates += 1; continue }
      return { error: error.message }
    }
    imported += 1
  }

  revalidatePath('/money')
  return { imported, matched, duplicates, skipped: plan.skipped.length }
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

  const { rows, error: rowsError } = await fetchAllLedgerTransactions(supabase, input.accountId)
  if (rowsError) return { error: rowsError }

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

  if (diff !== 0 && input.createAdjustment) {
    const { error } = await supabase.from('ledger_transactions').insert({
      owner_id: user.id,
      account_id: input.accountId,
      date: input.reconciledOn,
      amount_cents: diff,
      kind: diff > 0 ? 'income' : 'expense',
      category_id: null,
      payee: 'Balance Adjustment',
      cleared: 'cleared',
    })
    if (error) return { error: error.message }
  }

  // Every 'cleared' row at this point — the adjustment above included, if
  // one was just booked — was just confirmed against this statement.
  const { error: lockError } = await supabase
    .from('ledger_transactions')
    .update({ cleared: 'reconciled' })
    .eq('account_id', input.accountId)
    .eq('cleared', 'cleared')
  if (lockError) return { error: lockError.message }

  const { error: reconError } = await supabase.from('ledger_reconciliations').insert({
    owner_id: user.id,
    account_id: input.accountId,
    statement_balance_cents: input.statementBalanceCents,
    reconciled_on: input.reconciledOn,
  })
  if (reconError) return { error: reconError.message }

  const { error: acctError } = await supabase
    .from('ledger_accounts')
    .update({ last_reconciled_at: new Date().toISOString() })
    .eq('id', input.accountId)
  if (acctError) return { error: acctError.message }

  revalidatePath('/money')
  return { ok: true, adjustedCents: diff }
}
