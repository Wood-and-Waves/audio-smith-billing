# Auto-Assign (Underfunded) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** One button that funds every underfunded target this month from Ready to Assign, written as one atomic batch of budget moves that Undo reverses in a single tap.

**Architecture:** Migration 0046 adds `batch_id` to `ledger_budget_moves`. A pure lib turns `buildBudget`'s rows into the assignment plan. The budget page's fetch+assembly moves to a shared module so the new server action recomputes the month from the same code the page renders from. Undo/redo widen to a whole batch when the head move carries one. A client button renders in the summary panel.

**Design doc:** `docs/superpowers/specs/2026-08-25-auto-assign-design.md`. Dan's three decisions are binding: Underfunded only; fund fully even when RTA goes negative; one tap undoes the batch.

## Global Constraints

- `lib/budget.ts` arithmetic is UNTOUCHABLE (1,421-row proof). The action only reads `neededCents` off `buildBudget` output. Any diff inside lib/budget.ts is a defect.
- Migration ADDITIVE ONLY: `scripts/sql/migrations/0046_budget_move_batch.sql`. **SHIP ORDER: prod migration FIRST, then merge.**
- `month` is the ONLY caller-supplied input to the action; category ids come from the server's own assembly — no client-supplied ids, no ownership walk needed beyond the owner-scoped fetches.
- Hidden categories with `neededCents > 0` ARE funded (hidden is presentation-only, CLAUDE.md doctrine).
- All batch moves land in ONE multi-row `.insert([...])` (single statement = atomic; no RPC). `note: 'Auto-assign'`, shared `batch_id` via `crypto.randomUUID()`.
- RTA may go negative — no gating on Ready to Assign anywhere (Dan's decision 2).
- The page extraction is a VERBATIM move: behavior-identical, comments carried along. `npm test`, cold tsc (`rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`), `npm run build` before every commit.
- Pure libs: relative `.ts` imports, no `@/`, no JSX, no clock reads.
- The accepted phase-two undo/redo TOCTOU stance carries over unchanged; do not harden, do not remove the comments that document it.

## Model tiering
Task 1 cheapest · Task 2 cheap · Tasks 3–4 standard · final review top model.

---

### Task 1: Migration 0046

**Files:** Create `scripts/sql/migrations/0046_budget_move_batch.sql`

Follow 0038's comment style (em-dash header, prose WHY, then DDL):

```sql
-- 0046 — a batch id on budget moves, for one-tap batch undo
--
-- Auto-assign (design: docs/superpowers/specs/2026-08-25-auto-assign-design.md)
-- writes one move per underfunded category in a single multi-row insert.
-- Dan's decision: Undo reverses the whole batch as a unit. This column is
-- how undo/redo know the unit: null on every existing and hand-made move
-- (they keep flipping singly), one shared fresh uuid across an auto-assign
-- batch. Moves are still never deleted (0038's doctrine) — a batch undo is
-- one UPDATE setting undone_at across the batch.

alter table ledger_budget_moves add column batch_id uuid;

comment on column ledger_budget_moves.batch_id is
  'Null for a hand-made move. Auto-assign stamps one shared uuid across '
  'its whole batch (one multi-row insert); undoLastMove/redoLastMove flip '
  'every move sharing the head move''s batch_id in one UPDATE, which is '
  'what makes Undo reverse the batch as a unit.';
```

- [ ] Write the file · `npm run db:migrate` (DEV) · verify via a db:sql information_schema check (delete the check file) · commit `0046: budget move batch id`. **Prod at ship, FIRST.**

---

### Task 2: The pure plan (TDD)

**Files:** Create `lib/budgetAutoAssign.ts`, `scripts/test/budgetAutoAssign.test.ts`

**Interfaces — Produces:**
- `underfundedPlan(rows: CategoryMonth[]): { categoryId: string; amountCents: number }[]`
- `autoAssignBatchLabel(count: number, totalCents: number): string` → `auto-assign (12 categories, $612.00)` / `auto-assign (1 category, $50.00)`

```ts
// The brain of auto-assign (design: docs/superpowers/specs/
// 2026-08-25-auto-assign-design.md): which categories get funded and by
// how much, read straight off buildBudget's own rows — neededCents is the
// figure the summary's Underfunded total already sums, so the plan funds
// exactly what that figure promises, both target kinds included (a monthly
// target's top-up and a by-date target's monthly share both surface as
// neededCents > 0). Hidden rows are NOT filtered: hidden is presentation,
// the money is real (lib/budget.ts's own hidden doctrine).
import type { CategoryMonth } from './budget.ts'
import { formatUSD } from './money.ts'

export type PlannedAssign = { categoryId: string; amountCents: number }

export function underfundedPlan(rows: CategoryMonth[]): PlannedAssign[] {
  return rows
    .filter((r) => r.neededCents > 0)
    .map((r) => ({ categoryId: r.categoryId, amountCents: r.neededCents }))
}

/** The informed-Undo description of a batch — same voice as a single
 *  move's own label, used by the page's headMoveLabel when the head move
 *  carries a batch_id. */
export function autoAssignBatchLabel(count: number, totalCents: number): string {
  return `auto-assign (${count} ${count === 1 ? 'category' : 'categories'}, ${formatUSD(totalCents)})`
}
```

Tests (node --test, TDD red → green; fixture helper making a minimal `CategoryMonth`):
- rows with `neededCents: 0` and negative available produce nothing; positive `neededCents` maps 1:1 with the exact cents
- a `hidden: true` row with `neededCents > 0` IS in the plan (pin the doctrine)
- plan preserves row order; sum of plan amounts equals the sum of positive neededCents
- label: 1 → `auto-assign (1 category, $50.00)`; 12 → `auto-assign (12 categories, $612.00)`

- [ ] Red → implement → green (`npm test -- scripts/test/budgetAutoAssign.test.ts`) · cold tsc · commit `feat: pure auto-assign plan`

---

### Task 3: Shared assembly + the action + batch undo/redo

**Files:** Create `app/money/budget/data.ts`; modify `app/money/budget/page.tsx`, `app/money/budget/actions.ts`

**3a — extraction.** Move VERBATIM from `page.tsx` into `data.ts` (comments included): `PAGE_SIZE`, `RawCategoryRow`/`fetchAllCategories`, `RawMoveRow`/`fetchAllBudgetMoves`, `RawTxnRow`/`fetchAllBudgetTxns`, `RawSplitLegRow`/`fetchAllBudgetSplitLegs`, `RawTargetRow`/`fetchAllCategoryTargets`. `RawMoveRow`'s select gains `batch_id` (type field `batch_id: string | null`) — the ONE change during the move, needed by both the page's batch label and redo below.

Then ONE new exported function that reproduces the page's assembly exactly (accountRow read → five fetches → `legsByTxnId` map → `categories`/`moves` mapping → explode + opening-seed + `buildBudget` call, moved verbatim from the page):

```ts
export type BudgetAssembly = {
  accountRow: { id: string; opening_balance_cents: number; opening_date: string }
  categories: BudgetCategory[]
  moveRows: RawMoveRow[]
  months: Map<string, MonthBudget>
}

/** The ONE budget assembly (page + auto-assign action): null accountRow is
 *  the page's own "no account yet" case, surfaced as ok with months empty. */
export async function assembleBudget(
  supabase: Awaited<ReturnType<typeof createClient>>,
  viewMonth: string,
): Promise<{ ok: true; assembly: BudgetAssembly | null } | { ok: false; error: string }>
```

`page.tsx` calls it and keeps ONLY its display derivations (movesByRecency, undo/redo state, labels, RecentMove list, rendering). The page must render byte-identically — no behavior change.

**3b — the action** in `actions.ts`:

```ts
/**
 * Auto-assign (Dan's decisions, 2026-08-25): fund every underfunded
 * target this month from Ready to Assign, fully, even when that drives
 * RTA negative — one multi-row insert sharing a batch_id so undoLastMove
 * reverses the whole batch in one tap. `month` is the only caller input;
 * the plan comes from the server's OWN assembly (assembleBudget — the
 * same code the page renders from), so no client-supplied category id
 * ever reaches this write and hidden-but-targeted categories fund
 * correctly. An empty plan (stale button) is { ok: true, wrote: false }.
 */
export async function autoAssignUnderfunded(month: string): Promise<WriteResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const validMonth = validBudgetMonth(
    month, todayInChicago().slice(0, 7), FIRST_BUDGET_MONTH, MAX_MONTHS_AHEAD,
  )
  if (!validMonth) return { ok: false, error: "That month is outside the budget's range." }

  const assembled = await assembleBudget(supabase, validMonth)
  if (!assembled.ok) return { ok: false, error: assembled.error }
  if (!assembled.assembly) return { ok: false, error: 'There is no checking account yet.' }

  const monthBudget = assembled.assembly.months.get(validMonth)
  const plan = monthBudget ? underfundedPlan(monthBudget.rows) : []
  if (plan.length === 0) return { ok: true, wrote: false }

  const batchId = crypto.randomUUID()
  const { error } = await supabase.from('ledger_budget_moves').insert(
    plan.map((p) => ({
      owner_id: user.id,
      month: validMonth,
      from_category_id: null,
      to_category_id: p.categoryId,
      amount_cents: p.amountCents,
      note: 'Auto-assign',
      batch_id: batchId,
    })),
  )
  if (error) return { ok: false, error: error.message }

  revalidatePath('/money/budget')
  return { ok: true, wrote: true }
}
```

**3c — batch-aware undo/redo.** `newestActiveMove` and `newestUndoneMove` add `batch_id` to their selects and return types. In `undoLastMove`, replace the single-row update with:

```ts
  const stamp = new Date().toISOString()
  let query = supabase
    .from('ledger_budget_moves')
    .update({ undone_at: stamp })
    .eq('owner_id', user.id)
    .is('undone_at', null)
  // A batch head widens the flip to its whole batch (Dan's one-tap batch
  // undo); a batchless head keeps the single-row shape, filters unchanged.
  query = active.row.batch_id !== null
    ? query.eq('batch_id', active.row.batch_id)
    : query.eq('id', active.row.id)
  const { data: updated, error } = await query.select('id')
```

`redoLastMove` mirrors it (`.not('undone_at', 'is', null)`, `.update({ undone_at: null })`, widened by `undone.row.batch_id`). `redoTarget` and both TOCTOU comments stay untouched; batch rows always flip together (a batch is only ever undone as a unit), so a batch's rows always share `undone_at` and the newest-undone row is a faithful representative.

- [ ] Extraction first; page renders identically (spot-check `/money/budget` on dev) · then action + undo/redo · gates · commit `feat: auto-assign underfunded (batch moves, one-tap batch undo)`

---

### Task 4: The button + the informed batch label

**Files:** Create `components/AutoAssignButton.tsx`; modify `components/BudgetSummary.tsx`, `app/money/budget/page.tsx`

**AutoAssignButton** — client, the BudgetHistory pending/refresh idiom exactly:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD } from '@/lib/money'
import { autoAssignUnderfunded } from '@/app/money/budget/actions'

/** One tap funds every underfunded target this month (design doc:
 *  2026-08-25-auto-assign-design.md) — no confirm dialog, because a batch
 *  Undo is the safety. The figure is display only; the server recomputes
 *  its own plan. wrote:false = a stale button (someone already funded the
 *  month) — the refresh that follows makes the button disappear. */
export default function AutoAssignButton({
  month, underfundedCents,
}: { month: string; underfundedCents: number }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function run() {
    setError(null)
    start(async () => {
      const result = await autoAssignUnderfunded(month)
      if (!result.ok) { setError(result.error); return }
      router.refresh()
    })
  }

  return (
    <div className="mt-3">
      <button
        type="button" onClick={run} disabled={pending}
        className="w-full rounded-field border border-line px-3 py-2 text-xs font-semibold
                   uppercase tracking-wider text-muted hover:text-ink transition-colors
                   disabled:opacity-40"
      >
        {pending ? 'Assigning…' : `Auto-assign ${formatUSD(underfundedCents)}`}
      </button>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  )
}
```

**BudgetSummary** renders it inside the existing `underfundedCents !== 0` block, after the Underfunded `<dl>` (guard `> 0`, not `!== 0` — a negative underfunded total cannot occur, but the button must never offer to assign a negative figure):

```tsx
      {month.underfundedCents > 0 && <AutoAssignButton month={month.month} underfundedCents={month.underfundedCents} />}
```

(`BudgetSummary` stays a server component rendering a client child; add the import.)

**Informed batch label** in `page.tsx` — `headMoveLabel` becomes batch-aware, using Task 2's `autoAssignBatchLabel` over the ACTIVE moves sharing the head's batch:

```ts
  const headMoveLabel = (() => {
    if (!newestActiveMoveRow) return null
    if (newestActiveMoveRow.batch_id !== null) {
      const batch = moveRows.filter(
        (m) => m.batch_id === newestActiveMoveRow.batch_id && m.undone_at === null,
      )
      return autoAssignBatchLabel(batch.length, batch.reduce((s, m) => s + m.amount_cents, 0))
    }
    return `${formatUSD(newestActiveMoveRow.amount_cents)} · ${categoryDisplayName(newestActiveMoveRow.from_category_id)} → ${categoryDisplayName(newestActiveMoveRow.to_category_id)} · ${monthLabel(newestActiveMoveRow.month.slice(0, 7))}`
  })()
```

- [ ] Gates · commit `feat: auto-assign button + informed batch undo label`

---

### Task 5: Docs, final review, walkthrough, ship

- [ ] **Docs:** BACKLOG — move auto-assign out of "Deliberately left out of phase two" into a SHIPPED note (date, decisions, batch undo); CLAUDE.md — one line in the budget doctrine section (auto-assign writes batches; undo flips whole batches by batch_id; the plan reads neededCents only, never re-derives).
- [ ] **Final review** (top model, whole branch): lens = Global Constraints, especially `lib/budget.ts` untouched (`git diff` must be empty for it), the verbatim page extraction (page renders identically), the one-insert atomicity, batch undo flipping exactly the still-active batch members, hidden-category inclusion, and no client-supplied category ids.
- [ ] **Walkthrough** (browser, dev sandbox): set 2–3 targets (one monthly, one by-date, one on a hidden category) → button shows the summed figure → tap → categories fund, RTA drops (negative allowed), Recent Moves shows the batch noted 'Auto-assign' → Undo once reverses ALL of them (button label says "Undo auto-assign (N categories, $X)") → Redo restores the batch → clean up sandbox targets/moves.
- [ ] **Ship (Dan's gate):** `npm run db:migrate -- --prod` (0046) FIRST → merge → push → prod smoke (307) → `npm run parity` (tripwire — must still read 25/25 + $1.01 Novo).

## Verification

Task 5's walkthrough + parity tripwire. Automated: the new plan tests, full `npm test`, cold tsc, `npm run build` green at every commit.
