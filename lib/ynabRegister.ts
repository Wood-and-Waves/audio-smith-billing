// YNAB "Register" CSV export -> ledger_transactions rows.
//
// Two layers, deliberately kept apart:
//   parseYnabRegister  — pure CSV mechanics. Rows in, YnabRow[] out. Doesn't
//                         know what a "show" or an "owner" is.
//   mapYnabRow          — Dan's business rules. One YnabRow in, one decision
//                         out (a mapped transaction, or a reason to skip).
//
// Neither touches a database or a clock: the caller (scripts/import/
// ynab-backfill.mjs) supplies --account and --start, resolves category NAMES
// to ids, and does the actual writing. This module only decides what a row
// MEANS.
//
// No '@/' imports and no JSX — exercised by node --test.

import { roundCents } from './money.ts'

export type YnabRow = {
  account: string
  date: string // YYYY-MM-DD
  payee: string
  categoryGroup: string
  category: string
  memo: string
  outflowCents: number
  inflowCents: number
  cleared: string // 'Cleared' | 'Uncleared' | 'Reconciled', as YNAB wrote it
}

export type MappedTxn = {
  date: string
  payee: string
  memo: string | null
  amountCents: number
  kind: 'income' | 'expense' | 'owner_pay' | 'transfer'
  categoryName: string | null
  cleared: 'uncleared' | 'cleared'
}

export type MapOutcome =
  | { kind: 'txn'; txn: MappedTxn }
  | { kind: 'skip'; reason: 'zero-amount' | 'starting-balance' | 'before-start' | 'other-account' }

// YNAB spells category names exactly as Dan's chart does since 0039 converged
// the two lists, so nothing needs rewriting today. Kept because the moment YNAB
// and the chart disagree again, this is where the rewrite belongs — and leaving
// an unlisted name uncategorised is still better than guessing.
export const ALIASES: Record<string, string> = {}

// The YNAB category group Dan uses for moving money to/from his own pockets
// (owner draws, owner investments) rather than the business's. Transactions
// in this group are never income or a deduction.
const OWNER_GROUP = 'Owner Transactions'

const EXPECTED_HEADER = [
  'Account', 'Flag', 'Date', 'Payee', 'Category Group/Category',
  'Category Group', 'Category', 'Memo', 'Outflow', 'Inflow', 'Cleared',
]

/**
 * RFC4180-ish CSV -> rows of raw string fields. Handles quoted fields that
 * contain commas, embedded newlines (a multiline memo), and escaped quotes
 * ("" inside a quoted field). Blank lines (a lone empty field) are dropped —
 * YNAB's export often ends the file with one.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length

  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i += 1; continue
      }
      field += ch; i += 1; continue
    }
    if (ch === '"') { inQuotes = true; i += 1; continue }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue }
    if (ch === '\r') { i += 1; continue } // fold CRLF into the LF handling below
    if (ch === '\n') {
      row.push(field); field = ''
      rows.push(row); row = []
      i += 1; continue
    }
    field += ch; i += 1
  }
  // Final field/row when the file doesn't end on a newline.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

/** MM/DD/YYYY -> YYYY-MM-DD. Throws (naming the row) on anything else. */
function toIsoDate(raw: string, lineNo: number): string {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) throw new Error(`YNAB Register CSV row ${lineNo}: unparsable date "${raw}" (expected MM/DD/YYYY).`)
  const [, mm, dd, yyyy] = m
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
}

/**
 * "$1,234.56" or "1234.56" or "" -> integer cents. Currency symbol and
 * thousands separators tolerated; anything else unparsable throws (naming
 * the row and field) rather than silently reading as zero.
 */
function toCents(raw: string, lineNo: number, field: string): number {
  const s = raw.trim()
  if (s === '') return 0
  const stripped = s.replace(/[$,\s]/g, '')
  if (!/^-?\d+(\.\d+)?$|^-?\.\d+$/.test(stripped)) {
    throw new Error(`YNAB Register CSV row ${lineNo}: unparsable ${field} amount "${raw}".`)
  }
  // Same half-away-from-zero rule as lib/money.ts — parseFloat * 100 alone
  // can land a cent off (e.g. 19.99 -> 1998.9999999999998).
  return roundCents(parseFloat(stripped) * 100)
}

const CLEARED_VALUES = new Set(['Cleared', 'Uncleared', 'Reconciled'])

/**
 * Parses a full YNAB Register CSV export into rows. Throws (naming the
 * problem) on a header that doesn't match YNAB's export exactly, a row with
 * the wrong column count, or a field this can't read — a malformed source
 * file should stop the import cold, not load partial or wrong data.
 */
export function parseYnabRegister(csv: string): YnabRow[] {
  // YNAB's export opens with a UTF-8 byte-order mark; left in place it glues
  // itself to the first header cell and fails the exact-header check below
  // with two visually identical strings. Discovered on Dan's real export.
  const rows = parseCsvRows(csv.replace(/^\uFEFF/, ''))
  if (rows.length === 0) throw new Error('YNAB Register CSV is empty.')

  const header = rows[0]
  const headerOk = header.length === EXPECTED_HEADER.length
    && EXPECTED_HEADER.every((h, i) => header[i] === h)
  if (!headerOk) {
    throw new Error(
      'YNAB Register CSV has an unexpected header.\n'
      + `  expected: ${EXPECTED_HEADER.join(',')}\n`
      + `  got:      ${header.join(',')}`,
    )
  }

  const out: YnabRow[] = []
  for (let r = 1; r < rows.length; r += 1) {
    const fields = rows[r]
    const lineNo = r + 1 // 1-based, counting the header row — matches what a spreadsheet shows
    if (fields.length !== EXPECTED_HEADER.length) {
      throw new Error(
        `YNAB Register CSV row ${lineNo}: expected ${EXPECTED_HEADER.length} columns, found ${fields.length}.`,
      )
    }
    const [
      account, , dateRaw, payee, , categoryGroup, category, memo,
      outflowRaw, inflowRaw, cleared,
    ] = fields

    const date = toIsoDate(dateRaw, lineNo)
    const outflowCents = toCents(outflowRaw, lineNo, 'Outflow')
    const inflowCents = toCents(inflowRaw, lineNo, 'Inflow')
    if (!CLEARED_VALUES.has(cleared)) {
      throw new Error(`YNAB Register CSV row ${lineNo}: unrecognized Cleared value "${cleared}".`)
    }

    out.push({
      account: account.trim(),
      date,
      payee: payee.trim(),
      categoryGroup: categoryGroup.trim(),
      category: category.trim(),
      memo: memo.trim(),
      outflowCents,
      inflowCents,
      cleared,
    })
  }
  return out
}

/**
 * The 0027 migration's own checks, asserted here so a bug in the mapping
 * logic below throws loudly at map time instead of failing silently at
 * insert time (or — worse — passing a check by accident). This is a
 * programmer error if it ever fires, not a data problem, hence throw rather
 * than a skip outcome.
 */
function assertInvariants(txn: MappedTxn): void {
  if (txn.kind === 'income' && !(txn.amountCents > 0)) {
    throw new Error(`ynabRegister bug: income row has non-positive amount (${txn.amountCents}).`)
  }
  if ((txn.kind === 'expense' || txn.kind === 'owner_pay') && !(txn.amountCents < 0)) {
    throw new Error(`ynabRegister bug: ${txn.kind} row has non-negative amount (${txn.amountCents}).`)
  }
  if ((txn.kind === 'owner_pay' || txn.kind === 'transfer') && txn.categoryName !== null) {
    throw new Error(`ynabRegister bug: ${txn.kind} row carries a category ("${txn.categoryName}").`)
  }
}

/**
 * Turns one YNAB Register row into either a mapped transaction or a reason
 * to skip it. Every branch below mirrors a line in the task's mapping rules
 * — read this top to bottom in that order when something looks wrong.
 */
export function mapYnabRow(row: YnabRow, opts: { accountName: string; startDate: string }): MapOutcome {
  // Only one YNAB account backs this ledger account; everything else in the
  // export belongs to a different budget-side account and isn't ours to import.
  if (row.account !== opts.accountName) return { kind: 'skip', reason: 'other-account' }

  // Backfill has a hard start line (default 2026-01-01) — string comparison
  // is safe because both sides are already YYYY-MM-DD.
  if (row.date < opts.startDate) return { kind: 'skip', reason: 'before-start' }

  // YNAB's own "Starting Balance" row records the account's balance on the
  // day it was opened. The ledger account being created here carries that
  // same number in opening_balance_cents/opening_date — importing this row
  // too would count the opening balance twice.
  if (row.payee === 'Starting Balance') return { kind: 'skip', reason: 'starting-balance' }

  const net = row.inflowCents - row.outflowCents
  if (net === 0) return { kind: 'skip', reason: 'zero-amount' }

  const memo = row.memo.trim() === '' ? null : row.memo.trim()
  const cleared: 'uncleared' | 'cleared' = row.cleared === 'Uncleared' ? 'uncleared' : 'cleared'

  // Owner group (by category) or a YNAB inter-account transfer (by payee,
  // e.g. "Transfer : Savings") — on a one-account business budget, both mean
  // money moving to or from Dan's own pockets, never the business's income
  // or a deduction. Same rule for both: outflow is Dan paying himself
  // (owner_pay), inflow is Dan putting his own money IN (an owner
  // investment, not income — hence 'transfer', not 'income'). Never
  // categorized: paying/funding yourself isn't a line item.
  const isOwnerLike = row.categoryGroup === OWNER_GROUP || row.payee.startsWith('Transfer')
  if (isOwnerLike) {
    const txn: MappedTxn = {
      date: row.date,
      payee: row.payee,
      memo,
      amountCents: net,
      kind: net > 0 ? 'transfer' : 'owner_pay',
      categoryName: null,
      cleared,
    }
    assertInvariants(txn)
    return { kind: 'txn', txn }
  }

  if (net > 0) {
    // Plain inflow. Dan's per-client detail lives on the payee, not the
    // category (YNAB usually shows these as "Inflow: Ready to Assign"
    // anyway) — every one of them books to the single Show Income category.
    const txn: MappedTxn = {
      date: row.date,
      payee: row.payee,
      memo,
      amountCents: net,
      kind: 'income',
      categoryName: 'Show Income',
      cleared,
    }
    assertInvariants(txn)
    return { kind: 'txn', txn }
  }

  // Plain expense. Rewrite the handful of category names YNAB and Dan's
  // chart disagree on (ALIASES); pass everything else through by name and
  // let the caller resolve it against the DB, leaving anything unknown
  // uncategorized rather than guessing. A blank YNAB category (never
  // assigned one) maps to null the same way.
  const rawCategory = row.category.trim()
  const categoryName = rawCategory === '' ? null : (ALIASES[rawCategory] ?? rawCategory)
  const txn: MappedTxn = {
    date: row.date,
    payee: row.payee,
    memo,
    amountCents: net,
    kind: 'expense',
    categoryName,
    cleared,
  }
  assertInvariants(txn)
  return { kind: 'txn', txn }
}
