-- 0025 — billable vs. "my cost" expenses
--
-- Until now every expense was billed to the client: expenseLines turned it
-- into an invoice line, its receipt gated billing, and it froze into the
-- invoice's backup_snapshot (the client-facing itemization). Per-diem shows
-- work the other way: the client pays a flat allowance (billed as its own
-- invoice line) and Dan buys his own meals — HIS deductible costs, never the
-- client's. billable=false marks those.
--
-- Default true: every existing row keeps today's behavior, and every code
-- path that ignores the column behaves exactly as before. ADDITIVE ONLY,
-- per the 0020 rule.
--
-- The enforcement lives in code, filtered at three chokepoints so a my-cost
-- expense can never reach a client: expenseLines and expensesMissingReceipts
-- (lib/expenses.ts) and buildBackupSnapshot (lib/backupSnapshot.ts).
alter table expenses add column billable boolean not null default true;

comment on column expenses.billable is
  'true = billed to the client (invoice line, receipt gates billing, frozen into backup_snapshot). false = Dan''s own cost (per-diem meals): stays off the invoice and out of the billing gate; receipt optional; counts toward the show''s own P&L.';
