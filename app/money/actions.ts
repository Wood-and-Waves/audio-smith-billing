'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isPlainDate, todayInChicago } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import { DEFAULT_CATEGORIES } from '@/lib/ledgerCategories'
import { clearedBalance, type BalanceLike } from '@/lib/ledgerBalance'
import { envelopeBalances, type EnvelopeMoveLike } from '@/lib/envelopes'
import { parseOfx, type ParsedOfx } from '@/lib/ofx'
import { planImport, type ExistingTxn } from '@/lib/ledgerImport'
import { normalizePayee, rememberedCategories, memoryKey } from '@/lib/payeeMemory'
import { validateTxnShape, isSaneLedgerDate, type LedgerKind } from '@/lib/ledgerRules'

type Fail = { error: string }

const SANE_DATE_ERROR = "That date is outside the ledger's range (1990–2100)."

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

// Dan's actual YNAB Savings funds, in the order he already thinks of them.
const DEFAULT_ENVELOPES = ['Taxes', 'Tax Prep', 'Retained Earnings']

/**
 * Seeds the three savings-fund envelopes Dan already runs in YNAB the first
 * time this owner opens the ledger, and never again — same idempotent-by-
 * count shape as ensureDefaultCategories above, not name-matching, so an
 * envelope he's since renamed isn't mistaken for "missing" and reseeded next
 * to itself.
 */
export async function ensureDefaultEnvelopes(): Promise<Fail | { ok: true; seeded: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { count, error: countError } = await supabase
    .from('ledger_envelopes')
    .select('id', { count: 'exact', head: true })
  if (countError) return { error: countError.message }
  if ((count ?? 0) > 0) return { ok: true, seeded: 0 }

  const { error } = await supabase.from('ledger_envelopes').insert(
    DEFAULT_ENVELOPES.map((name, sort) => ({ owner_id: user.id, name, sort })),
  )
  if (error) {
    // Same race ensureDefaultCategories guards against, closed here by
    // migration 0030's (owner_id, name) unique index instead of 0028's: two
    // first loads can both read zero envelopes and both attempt to seed. The
    // second writer's bulk insert now fails on that index instead of
    // doubling every envelope — that's this call losing the race, not a real
    // failure, so it reports the same "already seeded" outcome as the count
    // check above.
    if (error.code === '23505') return { ok: true, seeded: 0 }
    return { error: error.message }
  }

  // No revalidatePath('/money') here — this runs during app/money/page.tsx's
  // own render (Next 16 throws if a revalidation runs mid-render, since it's
  // meant for the aftermath of a user-triggered Server Action, not a page's
  // own data loading), and that same render is about to read the envelopes
  // it just seeded fresh anyway, so there's nothing stale left to fix.
  return { ok: true, seeded: DEFAULT_ENVELOPES.length }
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
    const { error } = await supabase
      .from('ledger_categories')
      .update({ name, grp, hidden: input.hidden, is_equipment: input.isEquipment, deductible: input.deductible })
      .eq('id', input.id)
    if (error) {
      if (error.code === '23505') return { error: `You already have a category named "${name}".` }
      return { error: error.message }
    }
  }

  revalidatePath('/money')
  return { ok: true }
}

const ENVELOPE_MOVE_PAGE_SIZE = 1000

/**
 * Every ledger_envelope_moves row that named this envelope on either side,
 * paged past PostgREST's default 1000-row cap — same paged shape as
 * fetchAllLedgerTransactions further down, narrowed to the three columns
 * envelopeBalances (lib/envelopes) needs to add up. A move can only ever
 * name this envelope as its from side, its to side, or both across
 * different moves (never both at once on the SAME move — migration 0030's
 * lem_direction check) — the OR below is exactly "this envelope was one
 * side of the move."
 */
async function fetchEnvelopeMoves(
  supabase: Awaited<ReturnType<typeof createClient>>,
  envelopeId: string,
): Promise<{ rows: EnvelopeMoveLike[]; error: string | null }> {
  const rows: EnvelopeMoveLike[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_envelope_moves')
      .select('from_envelope_id, to_envelope_id, amount_cents')
      .or(`from_envelope_id.eq.${envelopeId},to_envelope_id.eq.${envelopeId}`)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + ENVELOPE_MOVE_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as EnvelopeMoveLike[]))
    if (!data || data.length < ENVELOPE_MOVE_PAGE_SIZE) break
    from += ENVELOPE_MOVE_PAGE_SIZE
  }
  return { rows, error: null }
}

/**
 * Creates or edits an envelope. A null id creates one, appended to the end
 * (max sort across all envelopes, plus one) so a new envelope never jumps
 * ahead of the ones Dan already ordered by hand — same shape as saveCategory
 * above, minus the per-group scoping, since envelopes aren't grouped.
 */
export async function saveEnvelope(input: {
  id: string | null
  name: string
  hidden: boolean
}): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const name = input.name.trim()
  if (!name) return { error: 'Give the envelope a name.' }

  if (input.id === null) {
    // RLS already scopes this to the caller's own rows, same as every other
    // owner-scoped select in this file — no explicit owner_id filter needed.
    const { data: top, error: sortError } = await supabase
      .from('ledger_envelopes')
      .select('sort')
      .order('sort', { ascending: false })
      .limit(1)
    if (sortError) return { error: sortError.message }
    const nextSort = (top?.[0]?.sort ?? -1) + 1

    const { error } = await supabase.from('ledger_envelopes').insert({
      owner_id: user.id,
      name,
      sort: nextSort,
      hidden: input.hidden,
    })
    if (error) {
      // Migration 0030's unique index (owner_id, name) — same race
      // ensureDefaultEnvelopes already guards against, but here it's a
      // genuine duplicate name Dan typed by hand, not a seeding race, so it
      // gets a message he can read instead of Postgres's raw constraint text.
      if (error.code === '23505') return { error: `You already have an envelope named "${name}".` }
      return { error: error.message }
    }
  } else {
    // BudgetPanel's own checkbox disable is a hint, not the invariant — a
    // stale second tab (still showing a balance that's since changed) or a
    // request replayed by hand must not be able to strand money in a hidden
    // envelope, since the Move Selects stop offering a hidden-and-empty row
    // as a source the moment it's hidden. Un-hiding never hits this: making
    // an envelope more visible again can't strand anything.
    if (input.hidden) {
      const { rows: moves, error: movesError } = await fetchEnvelopeMoves(supabase, input.id)
      if (movesError) return { error: movesError }
      const balanceCents = envelopeBalances(moves).get(input.id) ?? 0
      if (balanceCents !== 0) return { error: 'Empty this envelope before hiding it.' }
    }

    const { error } = await supabase
      .from('ledger_envelopes')
      .update({ name, hidden: input.hidden })
      .eq('id', input.id)
    if (error) {
      if (error.code === '23505') return { error: `You already have an envelope named "${name}".` }
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
  table: 'ledger_categories' | 'shows' | 'ledger_accounts' | 'ledger_envelopes',
  id: string,
): Promise<boolean> {
  const { data } = await supabase.from(table).select('id').eq('id', id).maybeSingle()
  return data !== null
}

/**
 * Records one move of money between the Available pool (a null envelope id)
 * and/or two envelopes. Migration 0030's ledger_envelope_moves is IMMUTABLE
 * by design — there is no updateEnvelopeMove or deleteEnvelopeMove anywhere
 * in this file, and there never should be: a mistaken move is corrected by
 * entering the opposite move as a new row, the same way a bank statement is
 * never edited after the fact, so the move history stays honest all the way
 * back instead of being rewritten to look like the mistake never happened.
 */
export async function moveEnvelopeMoney(input: {
  fromEnvelopeId: string | null
  toEnvelopeId: string | null
  amountCents: number
  note: string
}): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { error: 'Enter an amount to move.' }
  }
  if (input.fromEnvelopeId === null && input.toEnvelopeId === null) {
    return { error: 'Pick where the money moves.' }
  }
  // Mirrors migration 0030's lem_direction check constraint — Available ->
  // Available (or envelope X -> envelope X) would be a no-op pretending to
  // be a move, so it's refused here with a message Dan can read instead of
  // letting the insert below fail on Postgres's constraint text.
  if (input.fromEnvelopeId === input.toEnvelopeId) {
    return { error: 'Pick two different envelopes.' }
  }

  if (input.fromEnvelopeId !== null && !(await belongsToCaller(supabase, 'ledger_envelopes', input.fromEnvelopeId))) {
    return { error: 'That envelope does not belong to you.' }
  }
  if (input.toEnvelopeId !== null && !(await belongsToCaller(supabase, 'ledger_envelopes', input.toEnvelopeId))) {
    return { error: 'That envelope does not belong to you.' }
  }

  const { error } = await supabase.from('ledger_envelope_moves').insert({
    owner_id: user.id,
    from_envelope_id: input.fromEnvelopeId,
    to_envelope_id: input.toEnvelopeId,
    amount_cents: input.amountCents,
    moved_on: todayInChicago(),
    note: input.note.trim() || null,
  })
  if (error) return { error: error.message }

  revalidatePath('/money')
  return { ok: true }
}

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
      .select('id, date, amount_cents, cleared, import_id, source, payee, category_id, kind')
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
 * before anyone got to it. Amount, date, kind, and deletion stay locked
 * through updateLedgerTransaction/deleteLedgerTransaction; only this one
 * field is exempt.
 *
 * `applyToSamePayee` is the sweep half of payee memory: rememberedCategories
 * (lib/payeeMemory) only pre-fills NEW imports, so the first time a payee is
 * categorized by hand there can already be a pile of older uncategorized
 * rows for it sitting in the register. Turning this on backfills exactly
 * those — fetchUncategorizedSamePayeeCandidates above already limits the
 * pool to uncategorized income/expense rows, so a row that already has a
 * category, or an owner_pay/transfer row, is never touched. Off, or
 * `categoryId` null (clearing a category isn't something to fan out), it's
 * a no-op and `applied` reports 0.
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
    .from('ledger_transactions').select('kind, account_id, payee').eq('id', id).maybeSingle()
  if (!existing) return { error: 'That transaction no longer exists.' }
  // Same rule updateLedgerTransaction's validateTxnShape enforces on write
  // (lt_nocat_for_owner_or_transfer, migration 0027): paying yourself is not
  // a deduction and a transfer moves money between your own accounts, so
  // neither kind ever carries a category.
  if (existing.kind === 'owner_pay' || existing.kind === 'transfer') {
    return { error: 'Owner pay and transfers do not use a category.' }
  }

  if (categoryId !== null && !(await belongsToCaller(supabase, 'ledger_categories', categoryId))) {
    return { error: 'That category does not belong to you.' }
  }

  const { error } = await supabase
    .from('ledger_transactions')
    .update({ category_id: categoryId })
    .eq('id', id)
  if (error) return { error: error.message }

  let applied = 0
  // A blank payee matches nothing, deliberately: normalizePayee('') === '',
  // and sweeping every other payee-less row would categorize rows that share
  // no payee at all — the same rule rememberedCategories applies when it
  // refuses to learn from a blank payee.
  if (applyToSamePayee && categoryId !== null && normalizePayee(existing.payee) !== '') {
    // existing.kind is narrowed to 'income' | 'expense' here — the
    // owner_pay/transfer guard above already returned for either of the
    // other two kinds. Passed through so the sweep can never cross from an
    // expense row into that payee's income rows (or the reverse) — the same
    // kind-aware rule payeeMemory's memoryKey enforces on the import side.
    const { rows: candidates, error: candidatesError } =
      await fetchUncategorizedSamePayeeCandidates(supabase, existing.account_id, id, existing.kind)
    if (candidatesError) return { error: candidatesError }

    const targetKey = normalizePayee(existing.payee)
    const ids = candidates
      .filter((c) => normalizePayee(c.payee) === targetKey)
      .map((c) => c.id)

    if (ids.length > 0) {
      const { error: applyError } = await supabase
        .from('ledger_transactions')
        .update({ category_id: categoryId })
        .in('id', ids)
      if (applyError) return { error: applyError.message }
      applied = ids.length
    }
  }

  revalidatePath('/money')
  return { ok: true, applied }
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

  const plan = planImport(parsed.transactions, existingRows as ExistingTxn[])

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

  let imported = 0
  let autoCategorized = 0
  for (const ins of plan.inserts) {
    // Remembered category or null — keyed on (kind, payee) so an expense
    // teaching (e.g. "SQUARE INC" -> Bank Fees) can never pre-fill an
    // income row of the same payee, or the reverse (I1). Every plan.inserts
    // row is already income/expense (planImport's only two insert kinds),
    // so ins.kind is exactly what memoryKey wants; a payee with no memory
    // yet for that kind just gets null, same as before this feature existed.
    const categoryId = remembered.get(memoryKey(ins.kind, ins.row.name)) ?? null
    const { error } = await supabase.from('ledger_transactions').insert({
      owner_id: user.id,
      account_id: accountId,
      date: ins.row.date,
      amount_cents: ins.row.amountCents,
      kind: ins.kind,
      category_id: categoryId,
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
