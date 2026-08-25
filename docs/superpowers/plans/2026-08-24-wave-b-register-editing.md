# Wave B — Register Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dan's register-editing findings (docs/BACKLOG.md, Wave B): the edit
row aligned under its own headers with real Outflow/Inflow boxes, a
YNAB-style category picker with live budget balances, and math in every
money box. The two taste calls he has not made yet — retiring the kind
dropdown, and the show tag — are approved and planned as Tasks 5–6.

**Architecture:** One pure expression evaluator (`lib/moneyMath.ts`), one new
`CategoryPicker` component replacing `Select` for categories in the register,
and a structural rework of `MoneyRegister`'s add/edit rows onto the register's
own live `gridTemplate` so fields land under the headers they belong to. No
migration, no server-action changes except none.

**Why the edit row is misaligned today, precisely:** the register renders rows
on `registerTemplate(...)` — nine columns: receipt-rail · Date · Payee ·
Category · Memo · Outflow · Inflow · Balance · cleared-rail — while the add
and edit rows use a private `grid-cols-[9rem_8rem_1fr_7rem_9rem_9rem_1fr_auto]`
in a different ORDER (Date · Kind · Payee · Amount · Category · Show · Memo ·
buttons), `components/MoneyRegister.tsx:1083` and `:1557`. Nothing lines up
because nothing shares a template.

## Global Constraints

- Branch `register-edit`, cut from `main` AFTER the phase-two merge lands
  (this plan ships behind Dan's morning gate; do not branch off
  `budget-phase-two`).
- Money integer cents; every amount passes through the ONE new evaluator
  entry point so behaviour cannot fork per field.
- `lib/*.ts` pure (no `@/`, no JSX, relative `.ts` imports, no clock reads).
- The register's sign/kind invariants hold: income rows positive,
  expense/owner_pay negative (0027's checks). The Outflow/Inflow boxes carry
  MAGNITUDE + direction; `saveEdit`/`add` still submit the same signed shape
  they do today. Kind remains the authority until Dan's call says otherwise.
- Theme tokens only. Guard reads fail closed. No unbounded selects — any new
  moves fetch pages with `.range()` (mirror `fetchAllBudgetMoves`).
- Gates per commit: `npm test`, cold tsc, `npm run build`.

## Model tiering
Task 1 mid (TDD parser). Task 2 mid-high (structural UI on money paths).
Task 3 mid. Final review top model.

---

## Task 1: `lib/moneyMath.ts` — math in money boxes (TDD)

**Files:** Create `lib/moneyMath.ts`, `scripts/test/moneyMath.test.ts`;
modify `components/MoneyRegister.tsx`, `components/AssignedCell.tsx`,
`components/MoveMoneyDialog.tsx`, `components/TargetEditor.tsx` (call-site
swap only).

**Interfaces — Produces:**
```ts
/** '24.36+45.72' -> 7008. Plain '24.36' behaves exactly like parseUSD.
 *  null on anything unparseable. Integer cents out, always. */
export function parseUSDMath(input: string | number | null | undefined): number | null
```

- Grammar: numbers (with optional `$`, commas, decimals) joined by `+ - * /`,
  parentheses allowed, standard precedence. Evaluate in CENTS where possible:
  `+`/`-` are exact integer ops; `*`/`/` compute in floating dollars then
  round half-away-from-zero via `roundCents` once at the end — one rounding,
  documented. Division by zero → null. A lone number must round-trip
  IDENTICALLY to `parseUSD` (delegate to it — do not reimplement).
- Tests first: Dan's own case (`24.36+45.72` → `7008`), subtraction to
  negative, `3*12.99`, `100/3` rounding, `$` and comma tolerance, parens,
  whitespace, garbage → null, `/0` → null, lone-number parity with a direct
  `parseUSD` comparison over a value table.
- Call-site swap: the register's add/edit amount, `AssignedCell.commit()`,
  `MoveMoneyDialog.save()`, `TargetEditor`'s amount — each replaces its
  `parseUSD(` with `parseUSDMath(`. Nothing else about their validation
  changes (AssignedCell keeps its negative-allowed contract; the others keep
  their `> 0` checks).
- [ ] red → green → gates → commit `feat: arithmetic in money boxes`.

## Task 2: The add/edit rows land under their headers

**Files:** Modify `components/MoneyRegister.tsx` only.

The add row (`:1557`) and edit row (`:1083`) adopt the register's own
`gridTemplate` (style prop, same as `renderDesktopRow`), so every field sits
under its header — including while Dan drags a column grip, since the
template is the LIVE resizable one:

| Column | Add row | Edit row |
|---|---|---|
| receipt rail | empty span | empty span (receipt controls stay on the display row) |
| Date | date input | date input |
| Payee | payee input | payee input |
| Category | `CategoryPicker` (Task 3; plain `Select` until it lands) | same, with the hidden-category fallback option preserved |
| Memo | memo input | memo input |
| Outflow | amount box | amount box |
| Inflow | amount box | amount box |
| Balance | empty | the row's existing balance, static, muted |
| cleared rail | empty | empty |

**Outflow/Inflow semantics (the YNAB behaviour, without touching the kind
model):** two `inputMode="decimal"` boxes, right-aligned tabular, each fed
through `parseUSDMath`. Exactly one may be non-empty at save; typing into one
clears the other (YNAB's own behaviour). Direction drives kind where it is
unambiguous: a value in Inflow sets kind `income`; a value in Outflow with
kind currently `income` flips it to `expense` (never silently to
`owner_pay` — that distinction stays Dan's, via the dropdown). Editing seeds
the box matching the row's sign with `formatAmount(|amount|)`.

**The second line.** Kind, Show, Save/Cancel (and the edit row's existing
Unlink/Delete) move to a compact second line directly beneath, indented past
the receipt rail — mirroring YNAB's own two-line edit state (Dan's
screenshot). Same controls, same handlers, nothing removed: retiring Kind and
Show outright is gated on Dan (below), and this layout makes either removal a
one-line deletion later.

**Phone layout unchanged** — the 2-col stacked idiom stays; only `sm:+`
changes. The C1 owner-pay default-category effect on kind-switch stays
byte-identical.

- [ ] Verify in the browser (preview tool; stop before gates): fields under
  headers at default widths AND after dragging a grip; outflow/inflow
  exclusivity + kind flips; an edit of each kind seeds the right box; save
  paths write byte-identical rows to today for the same inputs (spot-check a
  refund-style income row); second line reads cleanly on a 1024px window.
- [ ] Gates → commit `feat: the edit row lands under its headers`.

## Task 3: `CategoryPicker` — YNAB's category dropdown

**Files:** Create `components/CategoryPicker.tsx`; modify
`components/MoneyRegister.tsx` (three call sites: add row, edit row, inline
uncategorized picker), `app/money/page.tsx` (budget balances).

Modelled on Dan's screenshot: a combobox — text input that filters as you
type — over a grouped list, each category row showing its **current-month
budget Available** right-aligned (`text-good`/`text-danger` by sign, plain
when zero), a pinned `＋ New Category` row linking to `/money/categories`,
and the currently-selected category shown checked under a "Selected" group
header. **No Payment/Transfer button** (gated on the kind decision below);
**no Split button** (Wave C).

- **Balances:** `app/money/page.tsx` fetches `ledger_budget_moves` (paged,
  mirroring `app/money/budget/page.tsx`'s `fetchAllBudgetMoves`) and
  `ledger_category_targets` is NOT needed — build with `buildBudget` from
  `OPENING_MONTH` to the current Chicago month, take that month's
  `availableCents` per category, pass `{id → availableCents}` down. Reuses
  the validated arithmetic; zero new math.
- **Keyboard:** arrows move, Enter selects, Escape closes just the picker
  (`stopPropagation` while open — `Select.tsx`'s own fixed idiom), typing
  filters. Follow `Select.tsx`'s listbox roles/labels; the filter input is
  the combobox.
- The inline uncategorized-row picker and the edit row's hidden-category
  fallback option keep their existing behaviours through the new component.
- [ ] Browser-verify all three call sites + filter + balances against the
  budget page's own figures for three categories · gates · commit
  `feat: the category picker shows where the money stands`.

## Task 3b: The move flow becomes YNAB's directional popover

**Files:** Modify `components/MoveMoneyDialog.tsx` (or replace with
`components/MovePopover.tsx`), `components/BudgetRow.tsx`.

Dan's finding on 2026-08-24, with YNAB screenshots on file: the current
modal's Select listbox fights the panel's scroll container (clipped, stray
scrollbars), and the flow itself should be directional and anchored at the
pill, the way YNAB does it:

- **Green pill (available > 0):** a small popover anchored to the pill —
  "Move" + an amount field prefilled with the full available (selected, so
  typing replaces) + a **To** picker offering Ready to Assign and every
  visible spending category. OK commits via `moveBetweenCategories`
  (from = this category).
- **Red pill (available < 0):** "Cover overspending from" + a **From**
  picker offering ONLY Ready to Assign and categories with money
  (`availableCents > 0`); the amount is implied — the full shortfall — no
  amount field, exactly YNAB's own flow. OK commits (to = this category).
- **Zero pill:** keep the current general dialog behaviour or a green-style
  popover with an empty amount — implementer's call, stated in the report.
- The picker inside is **Task 3's `CategoryPicker`** (balances, groups,
  filter) — build order matters: 3 before 3b.
- Anchored popover, not a fixed modal: position against the pill (the
  TargetEditor popover idiom), flipping above when the row sits low in the
  viewport; this removes the max-height scroll container and with it the
  clipping bug.
- Server contract unchanged — `moveBetweenCategories` already takes both
  directions; the popover only changes what is offered and prefilled.

- [ ] Browser-verify: green flow to a category and to RTA; red flow covers
  the exact shortfall and the pill goes grey-checked; the popover never
  clips against the viewport edges; Escape/outside-click behave.
- [ ] Gates → commit `feat: directional move popover`.

## Task 5: Retire the kind dropdown (Dan approved 2026-08-24)

**Files:** Modify `components/MoneyRegister.tsx`, `components/CategoryPicker.tsx`,
`lib/ledgerRules.ts` (one pure helper + tests); actions unchanged.

Kind derives from **(category, which box)**; the dropdown leaves both rows.
The derivation, exact — a pure `deriveKind(category, direction)` in
`lib/ledgerRules.ts` beside `validateTxnShape`, TDD:

| Category | Inflow | Outflow |
|---|---|---|
| **Payment/Transfer** (picker's special row) | `transfer`, category null | `transfer`, category null |
| income-role (`budget_role === 'income'`) | `income` | **refuse** — "Income categories take inflows." |
| the one **Owner Pay** category (`OWNER_PAY_CATEGORY_NAME`) | `income` (money in from Dan — a rare shape; bookable) | `owner_pay` |
| any other spending category — **including the other four Owner-Transactions categories** (Temporary Transfer, Loan to Wood and Waves, Charitable Giving, Money Due Wood and Waves) | `income` (a refund/repayment, category carried) | `expense` |
| none | `income`, uncategorized | `expense`, uncategorized |

- (Corrected at the final review, 2026-08-24: the table originally keyed
  owner_pay on the GROUP name, but the group holds five categories and only
  one is owner pay — Charitable Giving outflows would have vanished from the
  P&L's expense side. The inference keys on `OWNER_PAY_CATEGORY_NAME`; the
  failure mode is a rename of that one category, loud in the P&L; the escape
  hatch stays an explicit column, one migration.)
- **Payment/Transfer** joins `CategoryPicker` as a pinned row (Dan's YNAB
  screenshot). Selecting it = category null + kind `transfer` — which also
  gives the register its FIRST way to create transfer rows from the form,
  un-blocking the $400 punch-list item's inflow leg properly.
- Editing an existing row seeds the picker from its category, or
  Payment/Transfer for a transfer row. `saveEdit`/`add` submit the derived
  kind through the same actions — `validateTxnShape` stays the backstop.
- `ledgerReports`/P&L untouched: every row still carries a kind, derived
  instead of picked.
- [ ] TDD the helper (every cell of the table, both refusals) → wire →
  browser-verify each derivation lands the right kind (check the row's
  rendered category/sign) → gates → commit.

## Task 6: The show tag leaves the row (Dan approved 2026-08-24)

**Files:** Modify `components/MoneyRegister.tsx`.

Remove the show-name chip from `renderDesktopRow` and the phone row; the
Show select stays in the edit second line, and rows linked to shows keep
their invoice chips untouched. One commit.

## Task 7: Review + ship

- [ ] Final whole-branch review (top model): the sign/kind invariant under
  the new boxes (each existing kind round-trips), one evaluator entry point
  everywhere, balances match `buildBudget`, no unbounded reads, a11y of the
  combobox, and that the two gated items were NOT built.
- [ ] Controller walkthrough, then Dan's gate: merge → push → prod smoke.
