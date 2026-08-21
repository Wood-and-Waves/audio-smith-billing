-- 0031 — receipts on ledger transactions
--
-- Mirrors expenses' two-column pattern (0010): receipt_path is the enhanced,
-- flattened JPEG that gets shown; receipt_original is the untouched upload.
-- There is deliberately NO has_receipt flag — the file is the flag (0010's own
-- reasoning: a boolean beside a file is a second source of truth that can lie).
--
-- Nullable and additive: every existing row, the OFX importer and the YNAB
-- backfill keep inserting without these columns.
--
-- Storage path convention for ledger receipts (enforced per-action, the same
-- way addExpense enforces its show prefix): {owner_id}/ledger/{stamp}-enhanced.jpg
-- and {stamp}-original.{ext}, in the existing private `receipts` bucket. The
-- bucket's RLS keys only on folder[1] = owner, and 'ledger' in folder[2] can
-- never collide with a show id (shows use uuids).
alter table ledger_transactions
  add column receipt_path text,
  add column receipt_original text;
