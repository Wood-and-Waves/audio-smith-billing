// Budget arithmetic — YNAB's month grid.
//
// Two formulas run this screen, both validated against 1,421 rows of Dan's own
// YNAB export before a line of this existed:
//
//   available(c, m) = max(0, available(c, m-1)) + assigned(c, m) + activity(c, m)
//   rta(m) = rta(m-1) + income(m) - SUM assigned(c, m) + SUM min(0, available(c, m-1))
//
// The max(0, ...) is the whole trick. A positive balance rolls forward; a
// negative one does not. Cash overspending is absorbed by the NEXT month's Ready
// to Assign and the category restarts at zero. Letting negatives roll forward
// instead produces 23 mismatches against that same export, so this is settled by
// evidence rather than taste.
//
// Note what SUM assigned(c, m) quietly gets right: a move between two categories
// contributes +x and -x, so it nets to zero and never touches Ready to Assign.
// Only moves with a null on one side move the pool.
//
// No '@/' imports and no JSX — exercised by node --test. No clock reads: the
// month range is always a parameter.

import { addMonths } from './dates.ts'

/** Nothing before this has a ledger behind it, so nothing before it is honest. */
export const FIRST_BUDGET_MONTH = '2026-01'

/**
 * Where the opening seed lives. Navigation never reaches it: it exists so that
 * January's carry-in is whatever YNAB was holding at the end of 2025, and so
 * that the account's opening balance has a month to arrive in.
 */
export const OPENING_MONTH = '2025-12'

export type BudgetCategory = {
  id: string
  name: string
  grp: string
  sort: number
  hidden: boolean
  /** 'income' rows are inflows to Ready to Assign, never budget rows. */
  budgetRole: 'spending' | 'income'
}

export type BudgetMove = {
  /** 'YYYY-MM'. */
  month: string
  /** null = the Ready to Assign pool. */
  fromCategoryId: string | null
  /** null = the Ready to Assign pool. */
  toCategoryId: string | null
  /** Always positive; direction lives in from/to. */
  amountCents: number
  /** Set = undone, and the move stops counting. Undo marks, never deletes. */
  undoneAt?: string | null
}

export type BudgetTxn = {
  /** 'YYYY-MM'. */
  month: string
  categoryId: string | null
  /** Signed: + in, - out. */
  amountCents: number
}

export type CategoryTarget = {
  categoryId: string
  kind: 'monthly' | 'by_date'
  amountCents: number
  /** 'YYYY-MM-DD' for by_date, null for monthly. */
  dueDate: string | null
}

export type TargetStatus =
  | { kind: 'none' }
  | { kind: 'overspent'; spentCents: number; assignedCents: number }
  | { kind: 'underfunded'; neededCents: number }
  | { kind: 'needed_eventually'; remainingCents: number }
  | { kind: 'fully_spent' }
  | { kind: 'on_track' }
  | { kind: 'funded'; spentCents: number; targetCents: number }

export type CategoryMonth = {
  categoryId: string
  assignedCents: number
  activityCents: number
  availableCents: number
  status: TargetStatus
  /** What it would take to satisfy the target this month. Drives Underfunded. */
  neededCents: number
  /** The target's figure, or null when the category has none. The progress bar
   *  and the Overfunded filter both need it, and neither should have to be
   *  handed the raw targets list a second time. */
  targetCents: number | null
}

export type MonthBudget = {
  month: string
  rows: CategoryMonth[]
  readyToAssignCents: number
  /** Sum of what carried in — the summary panel's "Left Over from Last Month". */
  leftOverCents: number
  assignedCents: number
  activityCents: number
  availableCents: number
  underfundedCents: number
}

/** Inclusive month count from `month` to `dueDate`'s month; never below 1. */
function monthsUntil(month: string, dueDate: string): number {
  const [my, mm] = month.split('-').map(Number)
  const [dy, dm] = dueDate.slice(0, 7).split('-').map(Number)
  return Math.max(1, (dy - my) * 12 + (dm - mm) + 1)
}

function statusFor(
  target: CategoryTarget | undefined,
  carriedIn: number, assigned: number, activity: number, available: number,
  month: string,
): { status: TargetStatus; needed: number } {
  if (!target) return { status: { kind: 'none' }, needed: 0 }

  const funded = Math.max(0, carriedIn) + assigned
  const shortfall = Math.max(0, target.amountCents - funded)

  // What this month is being asked for. A monthly target wants topping up to its
  // figure; a by-date target wants its share of what is still missing, measured
  // before this month's assignment so that assigning the share clears it.
  let needed: number
  if (target.kind === 'monthly') {
    needed = shortfall
  } else {
    const left = monthsUntil(month, target.dueDate ?? month)
    const missingBefore = Math.max(0, target.amountCents - Math.max(0, carriedIn))
    needed = Math.max(0, Math.ceil(missingBefore / left) - assigned)
  }

  // Red beats everything: an overspent category is the one thing Dan has to act on.
  if (available < 0) {
    return { status: { kind: 'overspent', spentCents: -activity, assignedCents: assigned }, needed }
  }
  if (needed > 0) {
    return target.kind === 'monthly'
      ? { status: { kind: 'underfunded', neededCents: needed }, needed }
      : { status: { kind: 'needed_eventually', remainingCents: shortfall }, needed }
  }
  if (available === 0) return { status: { kind: 'fully_spent' }, needed: 0 }
  if (target.kind === 'by_date' && funded < target.amountCents) {
    return { status: { kind: 'on_track' }, needed: 0 }
  }
  // "Funded" renders bare when nothing was spent, and as "Funded. Spent A of B"
  // when it was. Only THIS month's spending is reported: YNAB shows a running
  // figure across the target's whole window, which this does not model, and a
  // wrong cumulative number would be worse than an honest monthly one.
  return {
    // `-activity || 0` avoids reporting -0 when nothing was spent — `-0` is a
    // distinct value from `0` under strict-equality assertions.
    status: { kind: 'funded', spentCents: -activity || 0, targetCents: target.amountCents },
    needed: 0,
  }
}

export function buildBudget(input: {
  categories: BudgetCategory[]
  moves: BudgetMove[]
  txns: BudgetTxn[]
  targets: CategoryTarget[]
  fromMonth: string
  toMonth: string
}): Map<string, MonthBudget> {
  const { categories, moves, txns, targets, fromMonth, toMonth } = input

  const spending = categories
    .filter((c) => c.budgetRole === 'spending' && !c.hidden)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
  const spendingIds = new Set(spending.map((c) => c.id))
  const targetOf = new Map(targets.map((t) => [t.categoryId, t]))

  // month -> categoryId -> cents
  const assignedBy = new Map<string, Map<string, number>>()
  const bump = (bag: Map<string, Map<string, number>>, m: string, id: string, cents: number) => {
    let inner = bag.get(m)
    if (!inner) { inner = new Map(); bag.set(m, inner) }
    inner.set(id, (inner.get(id) ?? 0) + cents)
  }

  for (const mv of moves) {
    if (mv.undoneAt) continue
    if (mv.toCategoryId && spendingIds.has(mv.toCategoryId)) {
      bump(assignedBy, mv.month, mv.toCategoryId, mv.amountCents)
    }
    if (mv.fromCategoryId && spendingIds.has(mv.fromCategoryId)) {
      bump(assignedBy, mv.month, mv.fromCategoryId, -mv.amountCents)
    }
  }

  const activityBy = new Map<string, Map<string, number>>()
  const incomeBy = new Map<string, number>()
  for (const t of txns) {
    if (t.categoryId && spendingIds.has(t.categoryId)) {
      bump(activityBy, t.month, t.categoryId, t.amountCents)
    } else {
      // Income-role categories AND uncategorised rows alike: money without a job
      // sits in Ready to Assign until it gets one.
      incomeBy.set(t.month, (incomeBy.get(t.month) ?? 0) + t.amountCents)
    }
  }

  const out = new Map<string, MonthBudget>()
  const carry = new Map<string, number>()
  let rta = 0
  let carriedOverspend = 0

  for (let m = fromMonth; ; m = addMonths(m, 1)) {
    const assigned = assignedBy.get(m) ?? new Map<string, number>()
    const activity = activityBy.get(m) ?? new Map<string, number>()

    const rows: CategoryMonth[] = []
    let tAssigned = 0, tActivity = 0, tAvailable = 0, tLeftOver = 0, tUnderfunded = 0
    let overspendThisMonth = 0

    for (const c of spending) {
      const carriedIn = carry.get(c.id) ?? 0
      const a = assigned.get(c.id) ?? 0
      const act = activity.get(c.id) ?? 0
      const available = carriedIn + a + act

      const { status, needed } = statusFor(targetOf.get(c.id), carriedIn, a, act, available, m)

      rows.push({
        categoryId: c.id, assignedCents: a, activityCents: act,
        availableCents: available, status, neededCents: needed,
        targetCents: targetOf.get(c.id)?.amountCents ?? null,
      })

      tAssigned += a
      tActivity += act
      tAvailable += available
      tLeftOver += carriedIn
      tUnderfunded += needed
      if (available < 0) overspendThisMonth += available

      carry.set(c.id, Math.max(0, available))
    }

    rta = rta + (incomeBy.get(m) ?? 0) - tAssigned + carriedOverspend
    carriedOverspend = overspendThisMonth

    out.set(m, {
      month: m, rows,
      readyToAssignCents: rta,
      leftOverCents: tLeftOver,
      assignedCents: tAssigned,
      activityCents: tActivity,
      availableCents: tAvailable,
      underfundedCents: tUnderfunded,
    })

    if (m === toMonth) break
  }

  return out
}
