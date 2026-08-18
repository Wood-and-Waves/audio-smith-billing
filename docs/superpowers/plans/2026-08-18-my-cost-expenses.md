# Per-Diem "My Cost" Expenses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Dan log per-diem expenses he pays himself ("my cost") on the show page — excluded from the invoice, the client PDF/snapshot, and the receipts-block-billing gate — while billable expenses behave exactly as today.

**Architecture:** Migration 0025 (`expenses.billable boolean not null default true`) is ALREADY APPLIED to the dev DB and committed. The invariant "a my-cost expense never reaches a client" is enforced at three pure chokepoints — `expenseLines`, `expensesMissingReceipts` (lib/expenses.ts) and `buildBackupSnapshot` (lib/backupSnapshot.ts) — filtered *inside* the functions so every caller stays in lockstep. Queries/actions add the column; `ExpenseLog` gains the choice + chip + toggle.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase. Tests: `node --test` via `npm test` (note: it type-strips, it does NOT typecheck — `npx tsc --noEmit` is the type gate).

## Global Constraints

- **A my-cost (`billable=false`) expense must NEVER appear on an invoice line, in `backup_snapshot`, on the client PDF, or block billing.** Enforced inside `expenseLines`, `expensesMissingReceipts`, `buildBackupSnapshot` — never at call sites.
- **`ExpenseLike.billable` is a REQUIRED field** (compiler forces every reader to select it). At the `addExpense` action boundary it is optional with default `true` (`input.billable ?? true`) so my-cost is always an explicit opt-in.
- **Existing behavior is unchanged for `billable=true`** — the DB default keeps every existing row billable; the lockstep preview-vs-billShows regression test must still pass with mixed rows.
- Pure modules stay free of `@/`/JSX/server-only; tests use relative `.ts` imports.
- `setExpenseBillable` refuses when the show is billed (same lock as `deleteExpense`) and is owner-scoped.
- Additive only; migration 0025 exists — do not write new migrations.

---

### Task 1: Billable-aware data layer (lib + snapshot + queries + actions), tsc-clean

**Files:**
- Modify: `lib/expenses.ts`, `lib/backupSnapshot.ts`
- Modify: `app/expenses/actions.ts` (addExpense input/insert; new `setExpenseBillable`)
- Modify: `app/shows/actions.ts` (billShows expense select, line ~598)
- Modify: `app/shows/[id]/page.tsx` (Expense type ~32-39, query ~61-75)
- Modify: `app/shows/page.tsx` (Expense type ~18-21, query ~40-48)
- Test: `scripts/test/expenses.test.ts`, `scripts/test/backupSnapshot.test.ts`

**Interfaces:**
- Produces: `ExpenseLike` with required `billable: boolean`; `expenseLines`/`expensesMissingReceipts` consider only billable rows; `buildBackupSnapshot` freezes only billable rows; `addExpense(input & { billable?: boolean })`; `setExpenseBillable(expenseId: string, billable: boolean): Promise<Fail | { ok: true }>`.

- [ ] **Step 1: Write the failing tests**

In `scripts/test/expenses.test.ts`, the `exp` factory gains the default:

```ts
function exp(over: Partial<ExpenseLike> = {}): ExpenseLike {
  return {
    id: 'e1',
    category: 'meals',
    where_spent: 'Somewhere',
    amount_cents: 1000,
    spent_on: '2026-08-01',
    receipt_path: 'u/s/r.jpg',
    billable: true,
    ...over,
  }
}
```

(match the existing factory's actual defaults — only ADD `billable: true`). Add tests:

```ts
test('a my-cost expense never becomes an invoice line', () => {
  const lines = expenseLines([
    exp({ amount_cents: 2000 }),
    exp({ id: 'e2', amount_cents: 1875, billable: false }),
  ])
  assert.equal(lines.length, 1)
  assert.equal(lines[0].unit_price_cents, 2000, 'only the billable amount')
})

test('a show with only my-cost expenses produces no expense lines at all', () => {
  assert.deepEqual(expenseLines([exp({ billable: false })]), [])
})

test('a my-cost expense without a receipt never blocks billing', () => {
  const missing = expensesMissingReceipts([
    exp({ id: 'b1', receipt_path: null }),                      // billable, blocks
    exp({ id: 'm1', receipt_path: null, billable: false }),     // my-cost, ignored
  ])
  assert.deepEqual(missing.map((e) => e.id), ['b1'])
})
```

And extend the preview-vs-billShows lockstep regression (the test at ~line 110): add one `billable: false` expense to its fixture rows on each side and assert the totals still agree (and exclude the my-cost amount).

In `scripts/test/backupSnapshot.test.ts`: the expense fixtures gain `billable: true`; add:

```ts
test('a my-cost expense never reaches the snapshot', () => {
  // build a snapshot whose input has one billable and one billable:false expense
  // assert snapshot.expenses has length 1 and only the billable where_spent
})
```

(write it concretely against the file's existing snapshot-builder helpers/fixtures.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test` — expected: new tests FAIL (billable ignored), everything else passes.

- [ ] **Step 3: Implement the pure filters**

`lib/expenses.ts` — `ExpenseLike` gains:

```ts
  /**
   * true = billed to the client (invoice line, receipt gates billing, frozen
   * into the snapshot). false = Dan's own cost (per-diem meals): never reaches
   * the invoice or the client, never blocks billing, receipt optional.
   */
  billable: boolean
```

`expenseLines` loop gains one guard as its first statement inside the inner loop:

```ts
    for (const e of expenses) {
      if (!e.billable) continue
      if (e.category === category) total += e.amount_cents
    }
```

`expensesMissingReceipts` becomes:

```ts
export function expensesMissingReceipts(expenses: ExpenseLike[]): ExpenseLike[] {
  return expenses.filter(
    (e) => e.billable && (!e.receipt_path || e.receipt_path.trim() === ''),
  )
}
```

(update both functions' doc comments to say my-cost rows are skipped and why.)

`lib/backupSnapshot.ts` — the expense mapping becomes:

```ts
    expenses: input.shows.flatMap((s) => s.expenses
      .filter((e) => e.billable)
      .map((e) => ({
        category: e.category,
        where_spent: e.where_spent,
        amount_cents: e.amount_cents,
        spent_on: e.spent_on,
        receipt_path: e.receipt_path,
      }))),
```

with a comment: the snapshot is the CLIENT-facing itemization; a my-cost expense here would print on the invoice PDF and the public link.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — all green.

- [ ] **Step 5: Wire the column through queries and actions**

- `app/shows/actions.ts` billShows select (~598): `expenses(id, category, where_spent, amount_cents, spent_on, receipt_path)` → add `billable`.
- `app/shows/[id]/page.tsx`: `Expense` type gains `billable: boolean`; the query's `expenses(...)` select adds `billable`.
- `app/shows/page.tsx`: same for its `Expense` type and select.
- `app/expenses/actions.ts` `addExpense`: input gains `billable?: boolean` (doc: "omitted = true; my-cost is an explicit opt-in") and the insert gains `billable: input.billable ?? true,`.
- `app/expenses/actions.ts` — add after `deleteExpense`:

```ts
/**
 * Flips an expense between billable and my-cost. Exists because expenses are
 * otherwise add/delete-only, and fixing a mis-flag by delete would force
 * re-uploading the receipt. Same lock rule as deleteExpense: a billed show's
 * expenses are frozen.
 */
export async function setExpenseBillable(
  expenseId: string, billable: boolean,
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: row, error: readErr } = await supabase
    .from('expenses')
    .select('show_id, shows(status)')
    .eq('id', expenseId)
    .maybeSingle()
  if (readErr) return { error: readErr.message }
  if (!row) return { error: 'That expense no longer exists.' }
  const status = (row as unknown as { shows: { status: string } | null }).shows?.status
  if (status === 'billed') {
    return { error: 'This show is billed. Unlink it before editing.' }
  }

  const { error } = await supabase
    .from('expenses').update({ billable }).eq('id', expenseId)
  if (error) return { error: error.message }

  revalidatePath(`/shows/${(row as unknown as { show_id: string }).show_id}`)
  return { ok: true }
}
```

(follow `deleteExpense`'s actual casting/lock style in the file — match it exactly.)

- [ ] **Step 6: Typecheck and build**

Run: `npx tsc --noEmit && npm run build` — both clean. (ExpenseLog is untouched this task: pages pass rows with an extra `billable` field, which is structurally fine.)

- [ ] **Step 7: Run the full suite once more, then commit**

```bash
git add lib/expenses.ts lib/backupSnapshot.ts app/expenses/actions.ts app/shows/actions.ts "app/shows/[id]/page.tsx" app/shows/page.tsx scripts/test/expenses.test.ts scripts/test/backupSnapshot.test.ts
git commit -m "Make the expense pipeline billable-aware: my-cost never reaches a client"
```

---

### Task 2: ExpenseLog UI — choose, see, and flip my-cost

**Files:**
- Modify: `components/ExpenseLog.tsx` (only file)

**Interfaces:**
- Consumes: `setExpenseBillable` (Task 1), `addExpense` with `billable`, `Row`/`BatchRow` types in the file.

Requirements (the implementer integrates these into the existing structure — `Row` type ~20-32, `BatchRow` ~42-71, single-add form state ~336-353, batch construction/`addAllBatch` ~571-870, `add` ~980, header ~1157-1170, expense list rows ~1189-1220, batch row grid ~1235-1264, single-add form ~1312-1360):

- [ ] **Step 1: `Row` gains `billable: boolean`; `BatchRow` gains `billable: boolean` (initialized `true` where batch rows are constructed).**
- [ ] **Step 2: Single-add form** — a compact "My cost" choice (checkbox or two-option control consistent with the app's field styles from `components/ui/field.ts`), default billable, on its own line under the form grid with the caption "My cost — per-diem, not billed to the client". `add()` passes `billable: !myCost` (or equivalent) to `addExpense` and resets the control after a successful add.
- [ ] **Step 3: Batch rows** — the same compact choice per batch row (default billable) inside each batch card; `addAllBatch` passes each row's value.
- [ ] **Step 4: Expense list rows** —
  - my-cost rows show a small "My cost" chip (muted/accent styling consistent with existing chips, e.g. the In-progress chip pattern);
  - the red "needs a receipt" appears **only when `e.billable`**; a my-cost row without a receipt shows a muted "no receipt (optional)" instead;
  - each row gains a small toggle ("Make my cost" / "Make billable") calling `setExpenseBillable(e.id, !e.billable)` via `useTransition`, disabled when `locked || pending`, refreshing the router on success, surfacing `{error}` like `remove()` does.
- [ ] **Step 5: Header** — replace the single total with "Billable $X · My costs $Y" (omit the "· My costs" segment when $Y is 0 so unchanged shows look identical). The "N need receipts" counter needs no change (lib-filtered).
- [ ] **Step 6: Helper copy** (~1358) — when the my-cost choice is active, the file-input caption reads "A receipt is optional for my-cost expenses — still worth keeping for tax records."; otherwise the current copy.
- [ ] **Step 7: Verify** — `npx tsc --noEmit && npm run build` clean; `npm test` unchanged.
- [ ] **Step 8: Commit** — `git add components/ExpenseLog.tsx && git commit -m "ExpenseLog: my-cost choice, chip, toggle, split totals"`

---

## Verification

- `npm test` (count rises; lockstep regression green with mixed rows), `npx tsc --noEmit`, `npm run build`.
- Sandbox walkthrough (controller, dev server against `billing-audiosmith-dev` — 🧪 SANDBOX): add a my-cost expense with no receipt to a seeded show → preview total unchanged, "Bill this show" not blocked, header shows split totals; flip it billable → gate reappears; bill a show with a my-cost expense → invoice/PDF omits it.

## Blast radius

One additive column (already applied on dev). Lib filters change behavior ONLY for `billable=false` rows, which cannot exist until the UI creates them. Prod untouched until Wave 3.
