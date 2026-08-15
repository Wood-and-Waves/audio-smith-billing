-- 0019 — the record that an original is safely out of Supabase
--
-- Receipts are stored twice: receipt_path, the enhanced copy that goes on the
-- invoice, and receipt_original, the untouched upload. The original is ~95% of
-- what receipts cost, and the free tier's 1GB is about 250 of them.
--
-- Originals are copied to Dropbox and then deleted here. This column is what
-- makes the delete safe: it is set ONLY after an upload has been verified by
-- size and by Dropbox's own content hash, and the delete refuses to touch any
-- row where it is null. A failed or half-finished upload therefore cannot lose
-- the only untouched copy — it just gets retried tomorrow.
--
-- Inferring this by listing Dropbox each run was considered and rejected: slow,
-- rate-limited, and it would make deletion depend on a listing being correct at
-- that instant.
--
-- Additive only. Nothing is dropped, nothing is altered — 0015 dropped a column
-- that running code still read and took the live app down.
alter table expenses add column receipt_archived_at timestamptz;

-- The archive stage's query: the oldest expenses still holding an unarchived
-- original. Partial, because the rows it serves are the minority and shrink.
create index expenses_unarchived_idx on expenses (created_at)
  where receipt_original is not null and receipt_archived_at is null;
