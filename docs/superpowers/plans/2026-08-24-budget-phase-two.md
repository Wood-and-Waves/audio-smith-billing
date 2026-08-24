# Budget Phase Two — Assigning Money Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The budget's write half, per the shipped design's own phase split
(`docs/superpowers/specs/2026-08-22-ynab-budget-design.md`, "Sequencing"):
type a figure into Assigned, move money between categories, Undo/Redo, and
Recent Moves. Dan budgets September in the app beside YNAB; this is what
makes that possible.

**Architecture:** No migration — `ledger_budget_moves` (0038) already stores
immutable moves with `undone_at`, and `lib/budget.ts` already honours both.
New: one pure decision module (`lib/budgetMoves.ts`), four server actions in
`app/money/budget/actions.ts`, and three client components. The page passes
the month and existing figures down; every write is a move row; nothing ever
updates or deletes a move.

**Overnight rules:** branch `budget-phase-two`; build + review + walkthrough
on dev only; **nothing merges and prod is untouched** — the ship gate is
Dan's, in the morning.

## Global Constraints

- **Every mutation is an INSERT into `ledger_budget_moves`, or an UPDATE of
  exactly the `undone_at` column.** No move row is ever updated otherwise or
  deleted — corrections are the undo flag or a counter-move. This is the
  0030/0038 doctrine and `lib/budget.ts` depends on it.
- The validated arithmetic is untouchable: **`lib/budget.ts` may not change.**
  Assigned figures on screen must keep coming from `buildBudget` — after a
  write, `revalidatePath` + router refresh re-derives; no client-side ledger
  math beyond what a pure helper computes for the WRITE (the diff), which the
  re-render then confirms.
- **Typing a figure writes the difference**, not the figure: current assigned
  $500, typed $700 → one move RTA→category of $200; typed $300 → one move
  category→RTA of $200; typed $500 → no write at all. `amount_cents > 0`
  always; direction carries sign (0038 checks enforce this — a zero or
  negative insert must be impossible by construction, not by luck).
- Writes land on the **viewed month**, passed explicitly and validated
  server-side: `FIRST_BUDGET_MONTH <= month <= addMonths(today, MAX_MONTHS_AHEAD)`,
  shape `YYYY-MM` with month 01–12, stored as `YYYY-MM-01` (0038's
  `lbm_month_is_first` check). Reject anything else with a structured error.
- **Ownership:** every category id in a move is walked through
  `categoryOwnedByCaller` (already in `app/money/budget/actions.ts`) before
  writing. Both ids on a category-to-category move. Guard reads destructure
  `error` and return before any presence test — fail CLOSED.
- Assigning more than Ready to Assign holds is **allowed** (YNAB allows it;
  the red "More Assigned Than You Have" banner is the feedback). Moving money
  FROM a category below zero is also allowed — same principle, the pill goes
  red. No confirmations anywhere.
- Income-role and hidden categories are not assignable targets or sources;
  server-enforced (read the category's `budget_role`/`hidden` in the
  ownership walk), not just hidden in the UI.
- **Undo/Redo model** (settled here so nobody re-litigates it): the stack is
  the owner's moves ordered by `created_at, id`. Undo marks the newest move
  with `undone_at IS NULL` as undone. Redo clears `undone_at` on the newest
  undone move — but only if NO non-undone move is newer (a new move after an
  undo invalidates redo, standard editor semantics; enforce in the action).
  Undo/redo never touches the import's rows differently — they are moves like
  any other, and undoing into the backfill is legal (YNAB's own undo is
  session-scoped, ours is durable; Recent Moves makes it visible).
- Server actions: `'use server'`, presence-only auth, RLS for ownership on
  the write itself, structured `Result` returns, `revalidatePath('/money/budget')`.
- Money integer cents (`parseUSD`); theme tokens; `lib/*.ts` pure (no `@/`,
  no JSX, relative `.ts` imports, no clock reads — `today` is a parameter).
- Gates before every commit: `npm test` (778), cold
  `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`,
  `npm run build`. Plus, at the final review: the real-export validator must
  still report 1421/1421 (it reads `lib/budget.ts`, which must not change —
  this is the tripwire proving it didn't).
- **`scripts/import/ynab-plan.mjs` becomes dangerous the moment hand
  assignments exist**: its idempotent delete wipes every move from the
  opening month forward, including September's hand-entered ones. Task 5
  defuses this.

## Model tiering

Task 1 mid (pure logic, TDD). Task 2 mid (money writes). Tasks 3–4 mid (UI).
Task 5 cheapest. Final review top model — these are the first hand-writes to
the live budget.

## File Structure

| File | Responsibility |
|---|---|
| `lib/budgetMoves.ts` (new) | Pure decisions: `assignmentDiff`, `redoEligibility`, month validation |
| `scripts/test/budgetMoves.test.ts` (new) | Pins them |
| `app/money/budget/actions.ts` | + `assignToCategory`, `moveBetweenCategories`, `undoLastMove`, `redoLastMove` |
| `components/AssignedCell.tsx` (new) | Click-to-edit Assigned figure |
| `components/MoveMoneyDialog.tsx` (new) | Pill-click → move money |
| `components/BudgetHistory.tsx` (new) | Undo/Redo buttons + Recent Moves list |
| `components/BudgetRow.tsx`, `BudgetTable.tsx`, `app/money/budget/page.tsx` | Wire-through (props: month, category names map, editability) |

---

## Task 1: `lib/budgetMoves.ts` (TDD)

**Interfaces — Produces:**
```ts
export type MoveWrite = { fromCategoryId: string | null; toCategoryId: string | null; amountCents: number } | null
export function assignmentDiff(categoryId: string, currentAssignedCents: number, typedCents: number): MoveWrite
export function validBudgetMonth(month: string, todayYm: string, firstMonth: string, maxAhead: number): string | null  // YYYY-MM-01 or null
export type RedoCheck = { newestActive: { created_at: string; id: string } | null; newestUndone: { created_at: string; id: string } | null }
export function redoTarget(check: RedoCheck): 'ok' | 'nothing' | 'superseded'
```
- `assignmentDiff`: null when equal; positive amounts only; direction from
  sign of `typedCents − currentAssignedCents`. Reject (`null`) negative typed
  values — the UI parses first, but the decision must be total.
- `validBudgetMonth` reuses `addMonths` from `./dates.ts`; clamps nothing —
  out of range is a refusal, not a correction (a write is not navigation).
- `redoTarget` compares `(created_at, id)` tuples — `'superseded'` when an
  active move is newer than the newest undone one.
- [ ] Tests first (each rule above, both directions, equality, zero, the
  tuple tie on identical `created_at`), red → implement → green → gates →
  commit `feat: budget move decisions`.

## Task 2: The four actions

In `app/money/budget/actions.ts`, following `setCategoryTarget`'s shape:

- `assignToCategory(categoryId, month, typedCents)` — validate month via
  `validBudgetMonth`; ownership-walk the category and refuse `income`/`hidden`
  (extend the walk's select to `owner_id, budget_role, hidden`); **read the
  category's current assigned for that month server-side** (page the moves?
  No — one aggregate select on `ledger_budget_moves` filtered by month +
  category, both directions, `undone_at is null`) and compute the diff with
  `assignmentDiff` against THAT, not a client-supplied current — a stale tab
  must not double-assign; insert the one move (or no-op `{ ok: true, wrote: false }`).
- `moveBetweenCategories(fromId, toId, month, amountCents)` — both ids walked
  (either may be null = RTA, not both, not equal — mirror 0038's checks in
  validation messages); `amountCents > 0` integer; insert one row.
- `undoLastMove()` / `redoLastMove()` — select newest active / newest undone
  (`order created_at desc, id desc limit 1`), apply `redoTarget` for redo,
  update `undone_at` only, with `.is('undone_at', null)` (resp. `.not`) on
  the update's filter so a raced double-undo is a no-op, not a corruption.
- All four: structured errors, `revalidatePath('/money/budget')`.
- [ ] Extract any branching decision that can be pure INTO Task 1's module
  (the actions stay thin I/O shells, the repo's stated doctrine) · gates ·
  commit `feat: budget write actions`.

## Task 3: AssignedCell + MoveMoneyDialog

- **AssignedCell**: the Assigned figure becomes a button (desktop and phone
  card alike); click → inline `<input>` prefilled with the current figure
  selected, `parseUSD` on Enter/blur-with-change, Escape cancels; calls
  `assignToCategory`; "Saving…" pending state; error renders in-row. Hidden
  rows and the Hidden section: not editable. Locked months don't exist —
  any in-range month is editable (that IS backfill parity).
- **MoveMoneyDialog**: clicking the Available pill opens it (keep the pill's
  aria-label; it becomes a real button). Contents: "Move money" — amount
  field (prefill: the row's overspend magnitude when `available < 0`, else
  empty), From/To selects listing RTA + every visible spending category with
  its current Available beside it (the page already holds every row's
  figures — pass them down, don't refetch), the clicked category preselected
  (as To when overspent — covering is the common case — else as From).
  Save → `moveBetweenCategories`. Reuse `components/ui/Select.tsx`.
- [ ] Wire `month` + a `{id → name, availableCents}` map through
  BudgetTable/BudgetRow props · gates · commit `feat: assign and move money`.

## Task 4: Undo/Redo + Recent Moves

- **BudgetHistory** renders beside the filter chips: `Undo` / `Redo` buttons
  (disabled-not-hidden when nothing to undo/redo — the page can tell from a
  small extra fetch of the newest active + newest undone move, two `.limit(1)`
  selects) and `Recent moves ▾` — a disclosure listing the newest ~15 moves:
  "$200.00 · Ready to Assign → Taxes · Aug 2026", undone ones struck through,
  each active one with its own Undo affordance? **No** — only the stack's
  head is undoable (the model above); the list is read-only plus the two
  buttons. Keep it honest rather than clever.
- Month label per move from its `month` column; names from the categories the
  page already fetched; import-era moves show like any other.
- [ ] Gates · commit `feat: undo, redo, recent moves`.

## Task 5: Defuse the import + docs

- [ ] `scripts/import/ynab-plan.mjs`: add a required `--replace` flag for any
  committing run when the moves table is non-empty beyond what a prior import
  wrote — simplest honest version: if ANY move exists with `undone_at` set or
  the table is non-empty, `--commit` without `--replace` prints what would be
  deleted (count + months) and refuses. Header comment updated: this is a
  backfill tool; after phase two, hand-entered moves live in the same table
  and a re-run DELETES them.
- [ ] `CLAUDE.md` budget section: one line — phase two shipped, writes are
  moves, undo marks. `docs/BACKLOG.md`: phase-two entry updated; note what
  was deliberately left out (auto-assign still out; per-move undo in the list
  out — stack-head only).
- [ ] Gates · commit.

## Task 6: Final review + walkthrough (controller)

- [ ] Whole-branch review, top model: every Global Constraint, and
  specifically — no path writes a move without ownership + month validation;
  the server-side current-assigned read (stale-tab double-assign); undo/redo
  race filters; no change to `lib/budget.ts` (tripwire: real-export validator
  still 1421/1421); import defused.
- [ ] Controller browser walkthrough on dev: type into Assigned (up, down,
  equal, garbage input), cover an overspent category via the pill, undo it,
  redo it, make a new move and confirm redo dies, Recent Moves matches, and
  the summary/RTA react correctly to each — checked against hand arithmetic.
- [ ] Ledger updated. **Stop. Morning report to Dan; ship gate his.**
