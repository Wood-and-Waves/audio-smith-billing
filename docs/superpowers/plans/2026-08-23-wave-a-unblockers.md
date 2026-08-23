# Wave A — Walkthrough Unblockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the four things blocking Dan's dev walkthrough of the budget:
the register's 200-row display cap, eight missing categories, the budget
table's absent column headers, and the register's headers scrolling away.

**Architecture:** Four independent, small fixes on the existing `budget`
branch — no new subsystems. One additive migration (0041), one constant
deleted, two header rows touched. Items are Wave A of Dan's eleven findings
(`docs/BACKLOG.md`, "Dan's dev walkthrough findings").

**Tech Stack:** unchanged — Next.js 16, Supabase/Postgres, `node --test`.

## Global Constraints

- Branch: **`budget`** (unpushed, 41 commits ahead of main). Same ship gate as
  the budget itself; nothing here goes to prod separately.
- Migrations `scripts/sql/migrations/NNNN_*.sql`, checksummed, **ADDITIVE
  ONLY**, immutable once applied. This plan adds `0041`. Dev only —
  **prod migration happens at the wave's ship gate, not in any task.**
- Money integer cents. `lib/*.ts` pure. Theme tokens only, never a hex.
- Guard reads destructure `error` before any presence test.
- The seed chart (`lib/ledgerCategories.ts`) and the migration must agree —
  the I2 lesson: a value only a migration ever writes is a trap.
- Gates before every commit: `npm test` (775 pass today), cold
  `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`,
  `npm run build`.

## Model tiering

Task 1 cheapest. Tasks 2, 4 mid. Task 3 cheapest. Reviews mid-tier; no
whole-branch review here — a **delta review** of everything after `de2529e`
runs once, at the wave's ship gate (recorded in Task 5).

---

## Task 1: Every transaction reachable (Dan's #1)

**Files:**
- Modify: `app/money/page.tsx` (delete `RENDER_CAP`, the `.slice`)
- Modify: `components/MoneyRegister.tsx` (comments only)

The register renders `filtered.slice(0, RENDER_CAP)` with `RENDER_CAP = 200`
(`app/money/page.tsx:31`, `:467`) — the newest 200 of 325 rows, which is why
Dan cannot scroll past 4/17. Balances already compute over the FULL paged set
(pinned by existing comments/tests), so this is display-only.

**The fix is deletion, not a bigger number.** A bigger cap is still a silent
cap — this codebase's review doctrine ("no silent caps") exists because a
truncation that looks like completeness is worse than slowness. ~500 rows by
year-end is a trivial render for one CSS grid per row; YNAB renders full
registers the same way. If it ever genuinely drags, virtualisation is the
answer, not a cap — leave that judgement to the person who can measure it.

- [ ] **Step 1: Delete the cap**

In `app/money/page.tsx`: delete the `RENDER_CAP` constant (line 31 and its
comment block) and change line 467 to map over `filtered` directly:

```ts
const transactions: LedgerTxnRow[] = filtered.map((t) => ({
```

`totalCount` stays as is — `MoneyRegister` derives
`truncated = transactions.length < totalCount` (`components/MoneyRegister.tsx:486`),
so with the cap gone `truncated` is `false` everywhere automatically: the
"Showing the latest N of M" line stops rendering and the apply-to-more
prompt's `atLeast` hedge becomes exact, both for free. **Do not remove the
`truncated` plumbing** — `uncategorizedOnly` still filters (a different thing
than capping), and the prompt logic is correct as written.

- [ ] **Step 2: Correct the comments the deletion falsifies**

- `components/MoneyRegister.tsx:370-384` (the `totalCount` prop doc): says
  "capped from". Now the only narrowing is the uncategorized filter — say so.
- `components/MoneyRegister.tsx:716-719` (apply-to-more doc): says the count
  "counts only loaded rows" as a caveat — now the loaded rows ARE the full
  set (except under the uncategorized filter); tighten the wording.
- Search the file for other `200`/`cap` references and fix any stragglers.

- [ ] **Step 3: Gates and commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit && npm run build
git add app/money/page.tsx components/MoneyRegister.tsx
git commit -m "fix: the register renders every transaction, not the newest 200"
```

---

## Task 2: Migration 0041 — the eight missing categories

**Files:**
- Create: `scripts/sql/migrations/0041_full_category_chart.sql`
- Modify: `lib/ledgerCategories.ts`, `scripts/test/ledgerCategories.test.ts`

The 0039 convergence scoped the chart to categories with 2026 activity in
Dan's export. He assigns to more of his YNAB chart than that. Restore the
rest, in YNAB's own order, so his in-app categorising stops hitting walls —
and so the $400 punch-list item (Temporary Transfer) becomes possible.

**Target end state per group** (sort values final; YNAB's order):

| Group | Category | sort | deductible | is_equipment | hidden |
|---|---|---|---|---|---|
| Expenses | Hotels *(rename of the hidden `Lodging` row)* | 25 | true | false | false |
| Purchases | Audio Tools *(exists)* | 30 | | | |
| Purchases | Office Expenses | 31 | true | false | false |
| Purchases | Computers | 32 | true | **true** | false |
| Purchases | Education | 33 | true | false | false |
| Purchases | Misc Business Expenses *(exists — resort)* | 34 | | | |
| Owner Transactions | Temporary Transfer | 40 | **false** | false | false |
| Owner Transactions | Loan to Wood and Waves | 41 | **false** | false | false |
| Owner Transactions | Charitable Giving | 42 | **false** | false | false |
| Owner Transactions | Owner Investment, Pay, and Personal Expenses *(exists — resort)* | 43 | | | |
| Owner Transactions | Money Due Wood and Waves | 44 | **false** | false | false |
| Hidden Categories | Apple Music / Waves / YNAB / Mexico | 910–913 | true | false | **true** |

Rationale to carry into the migration's comment: `Lodging` is renamed rather
than duplicated — it is hidden with zero transactions and it IS Hotels under
the app's old name, so renaming keeps one identity. The three
money-movement categories and Charitable Giving default **non-deductible**
per the chart's standing doctrine ("overstating deductions is the one
direction this tool must never fail" — the CPA flips what belongs to him).
Computers is equipment for the §179/depreciation surfacing, same as Audio
Tools. The hidden four go to the 900-block (0040's convention) so no active
group can ever collide with them.

- [ ] **Step 1: Write the migration**

Every statement safe on an owner missing the old rows (fresh environment),
per-owner via the 0039 `select distinct owner_id … cross join (values …)`
idiom, `on conflict (owner_id, name) do nothing` on inserts. The prose
header transcribes the rationale paragraph above; the statements, complete:

```sql
-- 0041 — the rest of Dan's YNAB chart
-- (prose header per 0039/0040's style, carrying the rationale above)

update ledger_categories set name = 'Hotels', hidden = false, sort = 25
 where name = 'Lodging';

update ledger_categories set sort = 34 where name = 'Misc Business Expenses';
update ledger_categories set sort = 43
 where name = 'Owner Investment, Pay, and Personal Expenses';

insert into ledger_categories (owner_id, name, grp, sort, deductible, is_equipment, hidden, budget_role)
select o.owner_id, v.name, v.grp, v.sort, v.deductible, v.is_equipment, v.hidden, 'spending'
  from (select distinct owner_id from ledger_categories) o
 cross join (values
   ('Office Expenses',          'Purchases',          31, true,  false, false),
   ('Computers',                'Purchases',          32, true,  true,  false),
   ('Education',                'Purchases',          33, true,  false, false),
   ('Temporary Transfer',       'Owner Transactions', 40, false, false, false),
   ('Loan to Wood and Waves',   'Owner Transactions', 41, false, false, false),
   ('Charitable Giving',        'Owner Transactions', 42, false, false, false),
   ('Money Due Wood and Waves', 'Owner Transactions', 44, false, false, false),
   ('Apple Music',              'Hidden Categories', 910, true,  false, true),
   ('Waves',                    'Hidden Categories', 911, true,  false, true),
   ('YNAB',                     'Hidden Categories', 912, true,  false, true),
   ('Mexico',                   'Hidden Categories', 913, true,  false, true)
 ) as v(name, grp, sort, deductible, is_equipment, hidden)
 on conflict (owner_id, name) do nothing;
```

- [ ] **Step 2: Apply to DEV and verify**

`npm run db:migrate` (banner must say `dev`; **never `--prod`**). Then a
`/tmp` check (delete after): the full chart ordered by sort, plus 0040's
no-collision query — `group by grp having count(*) <> count(distinct sort)`
must return **zero rows**.

- [ ] **Step 3: Seed chart follows — the I2 lesson**

`lib/ledgerCategories.ts`'s `DEFAULT_CATEGORIES` gains the same rows so a
fresh install matches: Lodging's line becomes
`c('Hotels', 'Expenses', 25)`, and the seven active categories above are
added with the same sorts/flags (`c('Temporary Transfer', 'Owner Transactions', 40, false)` etc.).
**The hidden four are deliberately NOT seeded** — they are Dan's personal
history, not a starting chart; say so in a comment where they would have
gone. Update `scripts/test/ledgerCategories.test.ts`'s expectations, and its
sort-uniqueness and owner-pay tests must still pass unchanged in meaning.

- [ ] **Step 4: Gates and commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit && npm run build
git add scripts/sql/migrations/0041_full_category_chart.sql lib/ledgerCategories.ts scripts/test/
git commit -m "0041: restore the rest of Dan's YNAB chart"
```

Note for the record (no task step): once Dan re-exports from YNAB,
`npm run import:plan` with the same `--start` refreshes assignments
idempotently — any amounts he has since assigned to these categories will
then land. His in-app categorising needs no re-import.

---

## Task 3: Budget column headers

**Files:**
- Modify: `components/BudgetTable.tsx`

The budget table has group rows and figures but nothing naming the columns —
Dan: "I am not sure what each row is." YNAB labels CATEGORY / ASSIGNED /
ACTIVITY / AVAILABLE above the first group.

- [ ] **Step 1: Add the header row**

Inside the non-empty branch (so an empty filter result keeps its existing
message without an orphaned header), render once above the sections map,
using the file's own `GRID` constant so the labels sit exactly over the
cells they name:

```tsx
{/* Column headers — desktop only: GRID is `hidden sm:grid`, and the phone
    cards already label each figure inline. Named after YNAB's own header
    row, which is what Dan reads this screen against. */}
<div className={`${GRID} border-b border-line pb-1.5 mb-2`}>
  <span className="eyebrow">Category</span>
  <span className="eyebrow text-right">Assigned</span>
  <span className="eyebrow text-right">Activity</span>
  <span className="eyebrow text-right">Available</span>
</div>
```

- [ ] **Step 2: Gates and commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit && npm run build
git add components/BudgetTable.tsx
git commit -m "feat: the budget table names its columns"
```

---

## Task 4: The register's header sticks

**Files:**
- Modify: `components/MoneyRegister.tsx`

Dan: "the ledger headers date/payee/category/etc need to stay in place when
I scroll." The column-header grid (`components/MoneyRegister.tsx:1656-1673`)
scrolls away with the page.

**Why plain `sticky` works here, verified before planning:** the register has
NO `overflow` wrapper anywhere above the header row (the one `overflow` hit
in the file is a comment), so the window is the scroll container and
`position: sticky` pins against the viewport. The app bar (`AppShell`) is
`sticky top-0 z-50 h-16`, so the register header pins directly beneath it at
`top-16`.

- [ ] **Step 1: Make the header sticky**

On the header grid div (the one carrying the `eyebrow` column labels and the
resize grips), add:

```
sticky top-16 z-10 bg-bg
```

`bg-bg` because a sticky element without its own ground lets rows ghost
through it; `z-10` above the rows, far below the app bar's `z-50`. Keep the
existing `border-b border-line` — it becomes the pinned edge.

- [ ] **Step 2: Verify in the browser — three interactions, not just a glance**

Dev server through the preview tool (**never `npm run dev` in Bash**), stop
it before the gates. With Task 1 in, the register is ~325 rows, plenty to
scroll. Check:

1. Scroll deep: the header pins below the app bar, labels readable, no rows
   ghosting through, the border still drawn.
2. **Drag a column grip while scrolled** — resizing must still work when the
   header is stuck (the grips are absolutely positioned inside it).
3. **Open an inline category Select on a row just beneath the stuck header**
   — the dropdown must not render underneath the header. If it does, that is
   a z-index fight to fix now, not note.

- [ ] **Step 3: Gates and commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit && npm run build
git add components/MoneyRegister.tsx
git commit -m "feat: the register's column headers stay put while it scrolls"
```

---

## Task 5: Controller wrap-up (no subagent)

- [ ] Browser pass over all four together: scroll to January in the register
  (the 4/17 wall is gone), the new categories present in the category picker
  and on `/money/categories` in YNAB's order, budget headers over their
  columns, sticky header holding through a long scroll.
- [ ] `docs/BACKLOG.md`: mark Wave A items 1–4 done-on-dev (branch `budget`),
  and note the $400 punch-list item is now actionable (Temporary Transfer
  exists).
- [ ] Ledger (`.superpowers/sdd/progress.md`) updated.
- [ ] Tell Dan dev is ready to re-walk, and re-raise the ship decision.

**Ship note (for the gate, not this wave):** prod migration order is now
0038→0039→0040→**0041** before merge; and a **delta whole-branch review**
(top model) of every commit after `de2529e` runs before that gate — the
month picker, the envelope deletion, and this wave have per-task reviews but
no branch-level look.

## Verification

Per-task gates plus Task 4's three browser interactions and Task 5's
combined pass. No real-data arithmetic is touched — `lib/budget.ts` is not
modified anywhere in this plan; if any task finds it needs to be, stop and
escalate rather than proceed.
