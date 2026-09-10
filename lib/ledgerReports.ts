// The year's numbers, computed one honest way. Owner pay is never an expense
// (paying yourself is not a business cost — the whole reason kind exists);
// transfers are money moving between Dan's own pockets and count as nothing.
// The deductible subtotal trusts the category flag and NEVER guesses about
// uncategorized rows — they are counted and surfaced instead, because a
// deduction figure that quietly includes unreviewed rows is a lie at tax time.
//
// No '@/' imports and no JSX — exercised by node --test.

import { addMonths } from './dates.ts'

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

/**
 * Every row inside an inclusive date range. Dates are 'YYYY-MM-DD', which
 * sorts lexicographically — that is why the whole app stores them that way,
 * and why this needs no date parsing.
 *
 * Replaced filterYear on 2026-09-09: the Reports screen stopped being a
 * calendar-year screen when Dan needed quarters for his accountant.
 */
export function filterRange<T extends { date: string }>(
  txns: T[], from: string, to: string,
): T[] {
  return txns.filter((t) => t.date >= from && t.date <= to)
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

export type CategoryIncome = { category: ReportCategory; earnedCents: number }

/**
 * spendByCategory's mirror for the income half of a P&L. Income amounts are
 * stored POSITIVE, so unlike spendByCategory there is no sign flip here — the
 * asymmetry is in the ledger, not in this pair of functions.
 */
export function incomeByCategory(
  txns: ReportTxn[], categories: ReportCategory[],
): { rows: CategoryIncome[]; uncategorizedCents: number } {
  const earned = new Map<string, number>()
  let uncategorizedCents = 0
  for (const t of txns) {
    if (t.kind !== 'income') continue
    if (t.category_id === null) { uncategorizedCents += t.amount_cents; continue }
    earned.set(t.category_id, (earned.get(t.category_id) ?? 0) + t.amount_cents)
  }
  const rows = categories
    .filter((c) => (earned.get(c.id) ?? 0) !== 0)
    .sort((a, b) => a.grp.localeCompare(b.grp) || a.sort - b.sort)
    .map((category) => ({ category, earnedCents: earned.get(category.id) as number }))
  return { rows, uncategorizedCents }
}

export type MonthTotals = { month: string; incomeCents: number; expenseCents: number }

/**
 * One row per month the range touches, in order — three for a quarter, twelve
 * for a year, one for a range inside a single month.
 *
 * Rows are bucketed by month for display, but membership is decided by the
 * range's DAYS: a transaction in the right month but outside the range is not
 * counted. A quarter that started mid-month would otherwise quietly include
 * the days before it.
 */
export function monthlyTotals(txns: ReportTxn[], from: string, to: string): MonthTotals[] {
  const out: MonthTotals[] = []
  const lastMonth = to.slice(0, 7)
  for (let m = from.slice(0, 7); m <= lastMonth; m = addMonths(m, 1)) {
    out.push({ month: m, incomeCents: 0, expenseCents: 0 })
  }
  const indexOf = new Map(out.map((row, i) => [row.month, i]))
  for (const t of txns) {
    if (t.date < from || t.date > to) continue
    const i = indexOf.get(t.date.slice(0, 7))
    if (i === undefined) continue
    if (t.kind === 'income') out[i].incomeCents += t.amount_cents
    else if (t.kind === 'expense') out[i].expenseCents += -t.amount_cents
  }
  return out
}
