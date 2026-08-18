# Per-diem "my cost" expenses — design

## Problem

Today every show expense is assumed to be *billed to the client*: it becomes an
invoice line via `expenseLines`, its receipt gates billing via
`expensesMissingReceipts`, and it freezes into the invoice's `backup_snapshot`
(the client-facing itemization + receipt pages).

Dan's per-diem clients work the opposite way: the client pays a flat allowance
(billed as an invoice line — "Per Diem ($65)" lines appear throughout his
history) and Dan buys his own meals. Those meal costs are **his** — deductible
business expenses, never billed. Right now there is nowhere to log them: putting
them in the expense log would wrongly bill them to the client, and leaving them
out loses the deduction record and makes future per-show profit math wrong.

## Goal

Add a **billable vs. "my cost"** distinction to show expenses:

- **Billable** (default — current behavior): becomes an invoice line, receipt
  required before billing, frozen into the snapshot, printed on the client PDF.
- **My cost**: logged on the show page with an *optional* receipt, **excluded
  from the invoice, the snapshot/PDF, and the receipt-before-billing gate** —
  it can never block billing and never reaches a client. It still shows in the
  expense log and counts toward the show's own cost total (feeding the upcoming
  per-show profit/take-home card).

## Schema — migration 0025 (additive)

```sql
alter table expenses add column billable boolean not null default true;
```

Default `true` preserves every existing row and code path. Column comment
explains the distinction. No RLS change (row policies are unchanged).

## The one invariant that matters most

**A my-cost expense must never reach a client.** Three chokepoints enforce it:

1. `expenseLines` (lib/expenses.ts) — builds invoice lines; filters to billable
   **inside the function**, so all three callers (billShows, show-page preview,
   shows-overview totals) stay in lockstep automatically.
2. `expensesMissingReceipts` (lib/expenses.ts) — the billing gate; filters to
   billable inside, so the server refusal, both page gates, and the ExpenseLog
   counter all skip my-cost rows at once.
3. `buildBackupSnapshot` (lib/backupSnapshot.ts) — drops non-billable expenses
   before freezing, so the client PDF/public link can never print them.

Each is pinned by a test, including the existing preview-vs-billShows lockstep
regression extended with mixed billable/my-cost rows.

## Server changes

- `ExpenseLike` gains `billable: boolean`; every expense select that feeds the
  lib functions adds the column: `billShows` (app/shows/actions.ts:598), the
  show page (app/shows/[id]/page.tsx), the shows overview (app/shows/page.tsx).
- `addExpense` (app/expenses/actions.ts) accepts `billable?: boolean`, defaulting
  `true` — my-cost is always an explicit opt-in.
- New `setExpenseBillable(expenseId, billable)` action — owner-scoped, refuses
  once the show is billed (same lock rule as delete). Exists because expenses
  are otherwise add/delete-only and a mis-flag would force deleting and
  re-uploading a receipt.

## UI — `components/ExpenseLog.tsx`

- Single-add form and each batch-capture row get the billable/my-cost choice
  (default billable).
- My-cost rows show a "My cost" chip and a toggle (calls `setExpenseBillable`;
  disabled when locked).
- "needs a receipt" (danger) appears only on billable rows; my-cost rows show a
  soft optional-receipt hint instead.
- The header total splits: "Billable $X · My costs $Y".
- The file-input helper copy ("A receipt is required before this show can be
  billed.") becomes conditional.

## Receipts & archive (accepted as-is, no change)

My-cost receipts upload exactly like billable ones. The archive cron copies
every original to Dropbox regardless of billing (good — the deduction record is
preserved), and the Supabase original is deleted only after the Dropbox copy
exists and the show's invoice is paid + 30 days. A my-cost expense on a
never-billed show is archived but its original is never deleted.

## Out of scope

Per-diem *income* capture (already handled: per-diem is billed as an invoice
line, so show revenue includes it), the profit/take-home card (next feature),
and the bookkeeping module.
