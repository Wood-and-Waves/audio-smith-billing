// The ledger's link matcher: proposes candidate invoice/expense links for
// unlinked bank rows, and nothing more. Like receiptDuplicates.ts's take on
// a repeated photo — "two $6 coffees at the same Starbucks on the same day
// are two real expenses" is strong evidence and nothing more — an amount
// and a date lining up here is a guess, never a fact. So a guess is only
// ever PROPOSED: named, unticked, and Dan's to accept or ignore. This
// module never writes to the database and never decides FOR him; it hands
// back proposals for a caller to act on, the same analyze-then-apply split
// planImport uses in ./ledgerImport.ts (plan the matches here, let the
// caller do the writing and the deciding).
//
// Ambiguity is surfaced, not resolved: when two proposals could each be
// right — the same deposit fits two invoices, or the same invoice fits two
// deposits — both come back at 'low' confidence and neither is
// pre-selected. Guessing between equals is exactly the kind of silent wrong
// answer this file exists to avoid.
//
// Pure: no database, no clock beyond the plain date strings it's handed.
// That's what lets every branch be pinned by a test instead of a live
// ledger.
//
// No '@/' imports and no JSX — exercised by node --test.

import { normalizePayee } from './payeeMemory.ts'

// Inputs are DB-shaped (snake_case) like ExistingTxn in ledgerImport.ts.
export type BankRow = {
  id: string
  date: string // YYYY-MM-DD
  amount_cents: number // signed: + deposit, − charge
  payee: string
  kind: 'income' | 'expense' | 'owner_pay' | 'transfer'
  linked: boolean // already has ANY link row (either table)
}

export type CandidateInvoice = {
  id: string
  number: number
  client_id: string
  client_name: string
  total_cents: number
  sent_at: string | null // ISO timestamptz; compare on its YYYY-MM-DD prefix
  status: 'sent' | 'paid' // paid-but-unlinked stays a candidate (spec)
  linked: boolean // already linked to any transaction
}

export type CandidateExpense = {
  id: string
  show_id: string
  amount_cents: number // positive (expenses table checks > 0)
  spent_on: string // YYYY-MM-DD
  where_spent: string
  linked: boolean
}

export type Dismissal = {
  transaction_id: string
  invoice_id: string | null
  expense_id: string | null
}

export type IncomeProposal = {
  transactionId: string
  invoiceIds: string[] // 1–3, ascending sent_at then id (deterministic)
  confidence: 'high' | 'low' // high = pre-selected by accept-all; low = never
}

export type ExpenseProposal = {
  transactionIds: string[] // 1–3, ascending date then id (deterministic)
  expenseId: string
  confidence: 'high' | 'low'
}

export type MatchProposals = { income: IncomeProposal[]; expense: ExpenseProposal[] }

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Whole-day distance between two YYYY-MM-DD strings, via Date.UTC so no
 * local timezone leaks in. Copied from ledgerImport.ts's findMatch helper.
 * The income half only ever needs a >= / <= comparison on the date strings
 * themselves; the expense half below uses this for its day-proximity rules
 * (findMatch's "closest candidate within N days" rule).
 */
function daysApart(a: string, b: string): number {
  const utc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number)
    return Date.UTC(y, m - 1, day)
  }
  return Math.abs(utc(a) - utc(b)) / MS_PER_DAY
}

/** Normalized payee text split into its space-separated tokens. */
function tokensOf(text: string): string[] {
  return normalizePayee(text).split(' ').filter((t) => t.length > 0)
}

/**
 * True when two texts share a token of length >= 3 once normalized — the
 * payee-similarity signal that raises confidence. Never used to decide
 * WHETHER two things match, only how sure the matcher is once amount and
 * date already agree; short tokens ("ab", "co", "llc") are too common to
 * mean anything, so they don't count.
 */
function shareToken(a: string, b: string): boolean {
  const bTokens = new Set(tokensOf(b).filter((t) => t.length >= 3))
  return tokensOf(a).some((t) => t.length >= 3 && bTokens.has(t))
}

/** sent_at's YYYY-MM-DD prefix. Only ever called on an invoice that already passed the sent_at !== null filter. */
function sentDate(invoice: CandidateInvoice): string {
  return (invoice.sent_at as string).slice(0, 10)
}

/** Ascending by sent_at date, then id — the deterministic order pinned for invoiceIds within a proposal. */
function bySentThenId(a: CandidateInvoice, b: CandidateInvoice): number {
  return sentDate(a).localeCompare(sentDate(b)) || a.id.localeCompare(b.id)
}

/**
 * Every 2- or 3-invoice combination, within a single client, that sums to
 * targetCents exactly. Invoices from different clients never combine — a
 * deposit that happens to equal the sum of two different clients' invoices
 * is a coincidence, not a payment covering both.
 */
function sumCombinations(invoices: CandidateInvoice[], targetCents: number): CandidateInvoice[][] {
  const byClient = new Map<string, CandidateInvoice[]>()
  for (const invoice of invoices) {
    const forClient = byClient.get(invoice.client_id) ?? []
    forClient.push(invoice)
    byClient.set(invoice.client_id, forClient)
  }

  const combos: CandidateInvoice[][] = []
  for (const group of byClient.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        if (group[a].total_cents + group[b].total_cents === targetCents) {
          combos.push([group[a], group[b]])
        }
        for (let c = b + 1; c < group.length; c++) {
          if (group[a].total_cents + group[b].total_cents + group[c].total_cents === targetCents) {
            combos.push([group[a], group[b], group[c]])
          }
        }
      }
    }
  }
  return combos
}

type RawIncomeProposal = { transactionId: string; invoiceIds: string[]; single: boolean }

/**
 * Every exact-single or exact-sum candidate for one row, before suppression
 * or confidence. A row with an exact single never also gets a sum proposal
 * — if the exact amount is already spoken for, chasing a coincidental sum
 * on top of it would just be noise.
 */
function proposalsFor(row: BankRow, eligibleInvoices: CandidateInvoice[]): RawIncomeProposal[] {
  const exactSingles = eligibleInvoices.filter(
    (invoice) => invoice.total_cents === row.amount_cents && row.date >= sentDate(invoice),
  )
  if (exactSingles.length > 0) {
    return exactSingles.map((invoice) => ({ transactionId: row.id, invoiceIds: [invoice.id], single: true }))
  }

  const onOrBeforeRow = eligibleInvoices.filter((invoice) => sentDate(invoice) <= row.date)
  const combos = sumCombinations(onOrBeforeRow, row.amount_cents)
  // More than 3 ways to make the amount is too illegible to guess between —
  // Dan links it by hand later. Log nothing; this is a matcher, not an
  // auditor.
  if (combos.length === 0 || combos.length > 3) return []

  return combos.map((combo) => {
    const ordered = [...combo].sort(bySentThenId)
    return { transactionId: row.id, invoiceIds: ordered.map((i) => i.id), single: false }
  })
}

/** First token of normalizePayee(text), or null when it's under 3 chars — too weak to group rows on. */
function leadingToken(text: string): string | null {
  const [first] = tokensOf(text)
  return first && first.length >= 3 ? first : null
}

/** Ascending by date, then id — the deterministic order pinned for transactionIds within a proposal. */
function byDateThenId(a: BankRow, b: BankRow): number {
  return a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
}

/**
 * Every 2- or 3-row combination that sums exactly to targetCents, grouped by
 * shared leading payee token (rows with different leading tokens never
 * combine — the same restaurant split into an order and a tip is a real
 * pattern; two unrelated charges happening to add up is a coincidence), with
 * every pair in the group within 3 days of each other. The pairwise check
 * doubles as the triple's check: if two rows in a candidate triple are
 * already more than 3 days apart, no combination containing both of them —
 * pair or triple — can be valid, so that a/b is skipped outright.
 */
function sumCombinationsRows(rows: BankRow[], targetCents: number): BankRow[][] {
  const byToken = new Map<string, BankRow[]>()
  for (const row of rows) {
    const token = leadingToken(row.payee)
    if (token === null) continue
    const forToken = byToken.get(token) ?? []
    forToken.push(row)
    byToken.set(token, forToken)
  }

  const combos: BankRow[][] = []
  for (const group of byToken.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        if (daysApart(group[a].date, group[b].date) > 3) continue
        if (-(group[a].amount_cents + group[b].amount_cents) === targetCents) {
          combos.push([group[a], group[b]])
        }
        for (let c = b + 1; c < group.length; c++) {
          if (daysApart(group[a].date, group[c].date) > 3) continue
          if (daysApart(group[b].date, group[c].date) > 3) continue
          if (-(group[a].amount_cents + group[b].amount_cents + group[c].amount_cents) === targetCents) {
            combos.push([group[a], group[b], group[c]])
          }
        }
      }
    }
  }
  return combos
}

type RawExpenseProposal = { expenseId: string; transactionIds: string[]; single: boolean }

/**
 * Every exact-single or exact-sum candidate for one expense, before
 * suppression or confidence. The mirror image of proposalsFor: income sums
 * combine several invoices onto one deposit, so that iterates per row;
 * expense sums combine several charges onto one expense (order plus tip),
 * so this iterates per expense instead. An expense with an exact single
 * never also gets a sum proposal, for the same reason as the income half —
 * a coincidental sum on top of an already-spoken-for amount is just noise.
 */
function proposalsForExpense(expense: CandidateExpense, eligibleRows: BankRow[]): RawExpenseProposal[] {
  const exactSingles = eligibleRows.filter(
    (row) => -row.amount_cents === expense.amount_cents && daysApart(row.date, expense.spent_on) <= 10,
  )
  if (exactSingles.length > 0) {
    return exactSingles.map((row) => ({ expenseId: expense.id, transactionIds: [row.id], single: true }))
  }

  const withinRange = eligibleRows.filter((row) => daysApart(row.date, expense.spent_on) <= 10)
  const combos = sumCombinationsRows(withinRange, expense.amount_cents)
  // More than 3 ways to make the amount is too illegible to guess between —
  // same cap, same reasoning as the income half.
  if (combos.length === 0 || combos.length > 3) return []

  return combos.map((combo) => {
    const ordered = [...combo].sort(byDateThenId)
    return { expenseId: expense.id, transactionIds: ordered.map((row) => row.id), single: false }
  })
}

export function proposeMatches(input: {
  rows: BankRow[]
  invoices: CandidateInvoice[]
  expenses: CandidateExpense[]
  dismissed: Dismissal[]
}): MatchProposals {
  const eligibleRows = input.rows.filter(
    (r) => !r.linked && r.amount_cents > 0 && r.kind === 'income',
  )
  const eligibleInvoices = input.invoices.filter(
    (i) => !i.linked && (i.status === 'sent' || i.status === 'paid') && i.sent_at !== null,
  )

  const dismissedPairs = new Set(
    input.dismissed
      .filter((d) => d.invoice_id !== null)
      .map((d) => `${d.transaction_id}:${d.invoice_id}`),
  )

  const raw = eligibleRows.flatMap((row) => proposalsFor(row, eligibleInvoices))

  const suppressed = raw.filter(
    (p) => !p.invoiceIds.some((invoiceId) => dismissedPairs.has(`${p.transactionId}:${invoiceId}`)),
  )

  // Ambiguity is computed over the full suppressed list: if two proposals
  // (of either shape) name the same transaction or the same invoice, every
  // proposal touching that transaction or invoice stays low.
  const transactionCounts = new Map<string, number>()
  const invoiceCounts = new Map<string, number>()
  for (const p of suppressed) {
    transactionCounts.set(p.transactionId, (transactionCounts.get(p.transactionId) ?? 0) + 1)
    for (const invoiceId of p.invoiceIds) {
      invoiceCounts.set(invoiceId, (invoiceCounts.get(invoiceId) ?? 0) + 1)
    }
  }

  const rowsById = new Map(input.rows.map((r) => [r.id, r]))
  const invoicesById = new Map(input.invoices.map((i) => [i.id, i]))

  const income: IncomeProposal[] = suppressed.map((p) => {
    let confidence: 'high' | 'low' = 'low'
    if (p.single) {
      const invoiceId = p.invoiceIds[0]
      const unambiguous =
        transactionCounts.get(p.transactionId) === 1 && invoiceCounts.get(invoiceId) === 1
      const bankRow = rowsById.get(p.transactionId)
      const invoice = invoicesById.get(invoiceId)
      if (unambiguous && bankRow && invoice && shareToken(bankRow.payee, invoice.client_name)) {
        confidence = 'high'
      }
    }
    return { transactionId: p.transactionId, invoiceIds: p.invoiceIds, confidence }
  })

  income.sort((a, b) => {
    const dateA = rowsById.get(a.transactionId)?.date ?? ''
    const dateB = rowsById.get(b.transactionId)?.date ?? ''
    return dateA.localeCompare(dateB) || a.transactionId.localeCompare(b.transactionId)
  })

  const eligibleExpenseRows = input.rows.filter(
    (r) => !r.linked && r.amount_cents < 0 && r.kind === 'expense',
  )
  const eligibleExpenses = input.expenses.filter((e) => !e.linked)

  const dismissedExpensePairs = new Set(
    input.dismissed
      .filter((d) => d.expense_id !== null)
      .map((d) => `${d.transaction_id}:${d.expense_id}`),
  )

  const rawExpense = eligibleExpenses.flatMap((expense) => proposalsForExpense(expense, eligibleExpenseRows))

  const suppressedExpense = rawExpense.filter(
    (p) => !p.transactionIds.some((txId) => dismissedExpensePairs.has(`${txId}:${p.expenseId}`)),
  )

  // Ambiguity, same shape as income's: if two expense proposals name the
  // same row or the same expense, every proposal touching that row or
  // expense stays low. Income and expense rows can never overlap (opposite
  // signs), so this is computed over expense proposals alone.
  const expenseTxCounts = new Map<string, number>()
  const expenseCounts = new Map<string, number>()
  for (const p of suppressedExpense) {
    expenseCounts.set(p.expenseId, (expenseCounts.get(p.expenseId) ?? 0) + 1)
    for (const txId of p.transactionIds) {
      expenseTxCounts.set(txId, (expenseTxCounts.get(txId) ?? 0) + 1)
    }
  }

  const expensesById = new Map(input.expenses.map((e) => [e.id, e]))

  const expense: ExpenseProposal[] = suppressedExpense.map((p) => {
    let confidence: 'high' | 'low' = 'low'
    if (p.single) {
      const txId = p.transactionIds[0]
      const unambiguous =
        expenseTxCounts.get(txId) === 1 && expenseCounts.get(p.expenseId) === 1
      const bankRow = rowsById.get(txId)
      const candidateExpense = expensesById.get(p.expenseId)
      if (unambiguous && bankRow && candidateExpense && shareToken(bankRow.payee, candidateExpense.where_spent)) {
        confidence = 'high'
      }
    }
    return { transactionIds: p.transactionIds, expenseId: p.expenseId, confidence }
  })

  expense.sort((a, b) => {
    const dateA = rowsById.get(a.transactionIds[0])?.date ?? ''
    const dateB = rowsById.get(b.transactionIds[0])?.date ?? ''
    return dateA.localeCompare(dateB) || a.transactionIds[0].localeCompare(b.transactionIds[0])
  })

  return { income, expense }
}
