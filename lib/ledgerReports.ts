// The year's numbers, computed one honest way. Owner pay is never an expense
// (paying yourself is not a business cost — the whole reason kind exists);
// transfers are money moving between Dan's own pockets and count as nothing.
// The deductible subtotal trusts the category flag and NEVER guesses about
// uncategorized rows — they are counted and surfaced instead, because a
// deduction figure that quietly includes unreviewed rows is a lie at tax time.
//
// No '@/' imports and no JSX — exercised by node --test.

export type ReportTxn = {
  date: string
  amount_cents: number
  kind: string
  category_id: string | null
}

export type ReportCategory = {
  id: string
  name: string
  grp: string
  sort: number
  deductible: boolean
}

export function filterYear<T extends { date: string }>(txns: T[], year: number): T[] {
  const prefix = `${year}-`
  return txns.filter((t) => t.date.startsWith(prefix))
}

export type PlSummary = {
  incomeCents: number
  /** All kind='expense' outflow, as a positive number. */
  expenseCents: number
  netCents: number
  /** Positive; excluded from every other figure. */
  ownerPayCents: number
  /** Expense rows sitting in deductible categories, positive. */
  deductibleCents: number
  /** Income/expense rows still awaiting a category. */
  uncategorizedCount: number
}

export function plSummary(txns: ReportTxn[], categories: ReportCategory[]): PlSummary {
  const deductible = new Set(categories.filter((c) => c.deductible).map((c) => c.id))
  let income = 0, expense = 0, ownerPay = 0, deductibleSpend = 0, uncategorized = 0
  for (const t of txns) {
    if (t.kind === 'income') {
      income += t.amount_cents
      if (t.category_id === null) uncategorized += 1
    } else if (t.kind === 'expense') {
      expense += -t.amount_cents
      if (t.category_id === null) uncategorized += 1
      else if (deductible.has(t.category_id)) deductibleSpend += -t.amount_cents
    } else if (t.kind === 'owner_pay') {
      ownerPay += -t.amount_cents
    }
  }
  return {
    incomeCents: income,
    expenseCents: expense,
    netCents: income - expense,
    ownerPayCents: ownerPay,
    deductibleCents: deductibleSpend,
    uncategorizedCount: uncategorized,
  }
}

export type CategorySpend = { category: ReportCategory; spentCents: number }

export function spendByCategory(
  txns: ReportTxn[], categories: ReportCategory[],
): { rows: CategorySpend[]; uncategorizedCents: number } {
  const spent = new Map<string, number>()
  let uncategorizedCents = 0
  for (const t of txns) {
    if (t.kind !== 'expense') continue
    if (t.category_id === null) { uncategorizedCents += -t.amount_cents; continue }
    spent.set(t.category_id, (spent.get(t.category_id) ?? 0) + -t.amount_cents)
  }
  const rows = categories
    .filter((c) => (spent.get(c.id) ?? 0) !== 0)
    .sort((a, b) => a.grp.localeCompare(b.grp) || a.sort - b.sort)
    .map((category) => ({ category, spentCents: spent.get(category.id) as number }))
  return { rows, uncategorizedCents }
}

export type MonthTotals = { month: string; incomeCents: number; expenseCents: number }

export function monthlyTotals(txns: ReportTxn[], year: number): MonthTotals[] {
  const out: MonthTotals[] = []
  for (let m = 1; m <= 12; m++) {
    out.push({ month: `${year}-${String(m).padStart(2, '0')}`, incomeCents: 0, expenseCents: 0 })
  }
  for (const t of txns) {
    if (!t.date.startsWith(`${year}-`)) continue
    const idx = Number(t.date.slice(5, 7)) - 1
    if (idx < 0 || idx > 11) continue
    if (t.kind === 'income') out[idx].incomeCents += t.amount_cents
    else if (t.kind === 'expense') out[idx].expenseCents += -t.amount_cents
  }
  return out
}
