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
  paid_at: string | null // YYYY-MM-DD or null; drives the paid-candidate recency rule (see eligibleForRow).
  // Must stay a Postgres `date`, not a timestamptz: daysApart splits on '-'
  // and Date.UTC's its parts, so a timestamptz string here would make it
  // return NaN and silently exclude every paid candidate.
  status: 'sent' | 'paid' // paid-but-unlinked stays a candidate only within paid_at's recency window (see eligibleForRow)
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
  payeeAgrees: boolean // row payee shares a token with the client name — display only, never changes confidence
}

export type ExpenseProposal = {
  transactionIds: string[] // 1–3, ascending date then id (deterministic)
  expenseId: string
  confidence: 'high' | 'low'
  payeeAgrees: boolean // row payee shares a token with where_spent — display only, never changes confidence
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

/**
 * Normalized payee text, punctuation stripped, split into its tokens — the
 * design spec's own "lowercased, punctuation stripped" pin. normalizePayee
 * alone only lowercases and collapses whitespace (it also keys exact-match
 * payee memory, where "streamline," and "streamline" are legitimately
 * different strings), so the punctuation strip lives here, not there:
 * "Streamline, Inc." and "STREAMLINE INC" must tokenize the same way for
 * similarity, without changing what payee memory treats as identical.
 */
function tokensOf(text: string): string[] {
  return normalizePayee(text).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length > 0)
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

const PAID_RECENCY_DAYS = 45

/**
 * Whether a candidate invoice is eligible against THIS particular row — the
 * one check that depends on the row's date rather than just the invoice.
 * A 'sent' invoice is always eligible: an unpaid debt is still owed no
 * matter how old. A 'paid' invoice is eligible only within
 * PAID_RECENCY_DAYS of paid_at — the owner's 94 imported historical
 * invoices are all status 'paid' from day one, and without this they'd
 * flood every future deposit's candidate pool (a 2024 invoice offered
 * against a 2026 recurring deposit of the same amount). The carve-out this
 * preserves is "marked paid by hand a few days before the deposit landed";
 * 45 days generously covers that flow while excluding archives.
 */
function eligibleForRow(invoice: CandidateInvoice, rowDate: string): boolean {
  if (invoice.status === 'sent') return true
  return invoice.paid_at !== null && daysApart(rowDate, invoice.paid_at) <= PAID_RECENCY_DAYS
}

type RawIncomeProposal = { transactionId: string; invoiceIds: string[]; single: boolean }

/**
 * Every exact-single or exact-sum candidate for one row, before suppression
 * or confidence. A row with an exact single never also gets a sum proposal
 * — if the exact amount is already spoken for, chasing a coincidental sum
 * on top of it would just be noise. eligibleInvoices is narrowed further
 * here by eligibleForRow, since a paid invoice's eligibility depends on
 * this specific row's date.
 */
function proposalsFor(row: BankRow, eligibleInvoices: CandidateInvoice[]): RawIncomeProposal[] {
  const forRow = eligibleInvoices.filter((invoice) => eligibleForRow(invoice, row.date))

  const exactSingles = forRow.filter(
    (invoice) => invoice.total_cents === row.amount_cents && row.date >= sentDate(invoice),
  )
  if (exactSingles.length > 0) {
    return exactSingles.map((invoice) => ({ transactionId: row.id, invoiceIds: [invoice.id], single: true }))
  }

  const onOrBeforeRow = forRow.filter((invoice) => sentDate(invoice) <= row.date)
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
    // First invoice stands for the whole combo's payee check: sums are
    // always same-client (sumCombinations never mixes clients), so every
    // invoice in a combo shares one client_name.
    const bankRow = rowsById.get(p.transactionId)
    const firstInvoice = invoicesById.get(p.invoiceIds[0])
    const payeeAgrees = Boolean(bankRow && firstInvoice && shareToken(bankRow.payee, firstInvoice.client_name))

    let confidence: 'high' | 'low' = 'low'
    if (p.single) {
      const invoiceId = p.invoiceIds[0]
      const unambiguous =
        transactionCounts.get(p.transactionId) === 1 && invoiceCounts.get(invoiceId) === 1
      if (unambiguous && payeeAgrees) {
        confidence = 'high'
      }
    }
    return { transactionId: p.transactionId, invoiceIds: p.invoiceIds, confidence, payeeAgrees }
  })

  // Ascending by transaction date, then transaction id; twins for the same
  // transaction (a tie on both) order the payee-agreeing card first, and a
  // joined-invoiceIds compare is the last, fully deterministic tiebreak.
  income.sort((a, b) => {
    const dateA = rowsById.get(a.transactionId)?.date ?? ''
    const dateB = rowsById.get(b.transactionId)?.date ?? ''
    return (
      dateA.localeCompare(dateB) ||
      a.transactionId.localeCompare(b.transactionId) ||
      Number(b.payeeAgrees) - Number(a.payeeAgrees) ||
      a.invoiceIds.join(',').localeCompare(b.invoiceIds.join(','))
    )
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
    // First transaction stands for the whole group's payee check: every row
    // in a group shares a leading payee token by construction
    // (sumCombinationsRows groups by it), so any one of them will do.
    const bankRow = rowsById.get(p.transactionIds[0])
    const candidateExpense = expensesById.get(p.expenseId)
    const payeeAgrees = Boolean(bankRow && candidateExpense && shareToken(bankRow.payee, candidateExpense.where_spent))

    let confidence: 'high' | 'low' = 'low'
    if (p.single) {
      const txId = p.transactionIds[0]
      const unambiguous =
        expenseTxCounts.get(txId) === 1 && expenseCounts.get(p.expenseId) === 1
      if (unambiguous && payeeAgrees) {
        confidence = 'high'
      }
    }
    return { transactionIds: p.transactionIds, expenseId: p.expenseId, confidence, payeeAgrees }
  })

  // Ascending by first-transaction date, then id; ties order the
  // payee-agreeing card first, then a joined-transactionIds compare as the
  // deterministic final key — expenseId alone would tie for two combos of
  // the same expense that share a first transaction (e.g. a single-row
  // proposal and a sum proposal both starting at the same transaction id),
  // mirroring the income sort's joined-invoiceIds tiebreak above.
  expense.sort((a, b) => {
    const dateA = rowsById.get(a.transactionIds[0])?.date ?? ''
    const dateB = rowsById.get(b.transactionIds[0])?.date ?? ''
    return (
      dateA.localeCompare(dateB) ||
      a.transactionIds[0].localeCompare(b.transactionIds[0]) ||
      Number(b.payeeAgrees) - Number(a.payeeAgrees) ||
      a.transactionIds.join(',').localeCompare(b.transactionIds.join(','))
    )
  })

  return { income, expense }
}
