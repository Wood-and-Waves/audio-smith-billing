# Money Reports Implementation Plan (wave B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Context (serves as spec — phase-2 "payoff" from the module reference):** the ledger collects but doesn't tell Dan anything. Wave B adds `/money/reports`: the year's P&L at a glance (income, expenses, net, owner pay, deductible subtotal), spend by category, income vs. expenses by month, and the uncategorized queue surfaced. Estimates/summaries only — the CPA export is a later wave. Owner pay is never an expense; transfers are neither income nor cost.

**Goal:** A Reports page that turns the ledger into a business picture, plus an uncategorized filter on the register.

**Tiering:** T1 exact-code → cheap model (controller verifies byte-fidelity); T2 → mid; the deferred opus whole-branch review (waves A+B) follows this wave.

## Global Constraints

- Money stays Dan-only. Pure math in `lib/ledgerReports.ts` (no `@/`/JSX), tested. Integer cents; `formatUSD`. Paged full-set loads (the 1000-row rule). No chart library — proportional CSS bars only.
- Owner pay: excluded from income AND expenses; shown as its own line. Transfers: ignored entirely. Deductible subtotal = expense rows in `deductible` categories only; uncategorized rows counted and surfaced, never guessed.

---

### Task 1 (cheap model): Report math (pure, exact code)

**Files:** Create `lib/ledgerReports.ts`; Test `scripts/test/ledgerReports.test.ts`.

- [ ] **Step 1:** `lib/ledgerReports.ts` — verbatim:

```ts
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
```

- [ ] **Step 2:** `scripts/test/ledgerReports.test.ts` — verbatim:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterYear, plSummary, spendByCategory, monthlyTotals,
  type ReportTxn, type ReportCategory,
} from '../../lib/ledgerReports.ts'

const CATS: ReportCategory[] = [
  { id: 'inc', name: 'Show Income', grp: 'Income', sort: 0, deductible: false },
  { id: 'meals', name: 'Meals', grp: 'Travel', sort: 22, deductible: true },
  { id: 'gear', name: 'Equipment & Gear', grp: 'Operations', sort: 10, deductible: true },
]

const T = (over: Partial<ReportTxn>): ReportTxn => ({
  date: '2026-05-10', amount_cents: -1000, kind: 'expense', category_id: 'meals', ...over,
})

const SAMPLE: ReportTxn[] = [
  T({ kind: 'income', amount_cents: 60000, category_id: 'inc', date: '2026-05-01' }),
  T({ amount_cents: -4253, category_id: 'meals', date: '2026-05-06' }),
  T({ amount_cents: -62000, category_id: 'gear', date: '2026-06-08' }),
  T({ amount_cents: -1500, category_id: null, date: '2026-06-09' }),        // uncategorized expense
  T({ kind: 'owner_pay', amount_cents: -200000, category_id: null, date: '2026-06-15' }),
  T({ kind: 'transfer', amount_cents: -5000, category_id: null, date: '2026-06-16' }),
  T({ amount_cents: -9999, category_id: 'meals', date: '2025-12-30' }),     // last year
]

test('the P&L keeps owner pay and transfers out of income and expenses', () => {
  const p = plSummary(filterYear(SAMPLE, 2026), CATS)
  assert.equal(p.incomeCents, 60000)
  assert.equal(p.expenseCents, 4253 + 62000 + 1500)
  assert.equal(p.netCents, 60000 - 67753)
  assert.equal(p.ownerPayCents, 200000)
})

test('the deductible subtotal never guesses about uncategorized rows', () => {
  const p = plSummary(filterYear(SAMPLE, 2026), CATS)
  assert.equal(p.deductibleCents, 4253 + 62000, 'the $15.00 uncategorized row is NOT counted')
  assert.equal(p.uncategorizedCount, 1)
})

test('spend by category: grouped order, zero-spend omitted, uncategorized bucketed', () => {
  const { rows, uncategorizedCents } = spendByCategory(filterYear(SAMPLE, 2026), CATS)
  assert.deepEqual(rows.map((r) => r.category.id), ['gear', 'meals'], 'Operations before Travel')
  assert.equal(rows[0].spentCents, 62000)
  assert.equal(rows[1].spentCents, 4253)
  assert.equal(uncategorizedCents, 1500)
})

test('monthly totals cover all 12 months and exclude other years', () => {
  const months = monthlyTotals(SAMPLE, 2026)
  assert.equal(months.length, 12)
  assert.deepEqual(months[4], { month: '2026-05', incomeCents: 60000, expenseCents: 4253 })
  assert.equal(months[5].expenseCents, 62000 + 1500)
  assert.equal(months.reduce((t, m) => t + m.expenseCents, 0), 67753, 'last December stays out')
})

test('filterYear is a plain prefix match on the date', () => {
  assert.equal(filterYear(SAMPLE, 2025).length, 1)
})
```

- [ ] **Step 3:** Gates (`npm test` +5, cold-cache tsc/build clean); commit `"Money: report math (pure)"`.

---

### Task 2 (mid model): The Reports page + register filter

**Files:** Create `app/money/reports/page.tsx` (+ a client component only if interactivity demands — prefer a pure server page; year switching is `<Link>`s). Modify `app/money/page.tsx` (header gains a "Reports" link beside "Edit categories"; support `?filter=uncategorized` — filter the RENDERED list to uncategorized income/expense rows, balances untouched, with a "showing uncategorized · show all" toggle link). Modify `components/MoneyRegister.tsx` only if the filter needs a prop.

- [ ] Server page `/money/reports?year=2026` (default: current year, `todayInChicago()` for the year — reuse `@/lib/dates`): auth/error handling and PAGED full transaction load exactly like `/money` (all accounts' rows for the owner's first non-closed account — same single-account model as the register); load ALL categories (incl. hidden — a hidden category's history still counts). Compute via `filterYear`/`plSummary`/`spendByCategory`/`monthlyTotals`.
- [ ] Render, in order, AppShell current="money":
  1. **Header:** "Reports" + year with ‹ › `<Link>`s (`?year=2025` / `?year=2027`); back-link to /money.
  2. **Uncategorized banner** when count > 0 (accent, links to `/money?filter=uncategorized`): "N transactions need a category before these numbers are trustworthy."
  3. **This year** (P&L card): Income / Expenses / **Net** (semibold; `text-good` when ≥ 0, `text-danger` when negative) / Owner pay (muted, "excluded from expenses") / Deductible expenses (muted subtotal with "so far — categories drive this").
  4. **Spend by category:** grouped by `grp` (eyebrow per group), each row name + proportional bar (plain div, width % of the largest category, `bg-accent-wash` with a `bg-accent` core — no chart lib) + `formatUSD`. Uncategorized bucket last (danger tint) when > 0.
  5. **By month:** 12 rows (Jan–Dec labels), each with paired thin bars (income `bg-good`-ish / expense `bg-accent`) scaled to the year's max month value, amounts tabular right. Months with nothing render dashes muted.
- [ ] Register: the "Reports" link + the `?filter=uncategorized` rendered-list filter (server-side param → filter before the 200-cap; note "Showing N uncategorized · Show all" link clearing the param).
- [ ] Style: existing tokens/idioms only. Mobile-sane (bars are full-width blocks, amounts wrap under on 375px).
- [ ] Gates (tests unchanged from T1's count, cold-cache tsc/build clean, `/money/reports` in the route list); commit `"Money: reports page and uncategorized filter"`.

---

## Verification

Gates green; sandbox: Reports shows May–Aug numbers from the test statement (income $18,865.50 if all payments categorized as income rows — actual figures depend on Dan's categorization state), owner pay excluded, uncategorized banner matches the register count and its link filters the register; year ‹ › shows empty 2025 cleanly. Then the deferred **opus whole-branch review** of the entire `ledger` branch (waves spine+A+B) before any ship gate.

## Out of scope

CPA export, invoice/expense bridge, per-show cross-links, the pre-prod hardening list.
