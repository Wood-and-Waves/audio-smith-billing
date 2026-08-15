-- 0020 — how many nights a receipt has failed to archive
--
-- The archive stage took eight rows a night, oldest first, and a failure changed
-- no state whatsoever. So a row that can NEVER succeed — a storage object that
-- has gone missing, a path Dropbox refuses — was re-selected at the head of the
-- batch the next night, and the night after, forever.
--
-- Simulated over five nights with forty waiting receipts: eight such rows at the
-- head archived nothing at all, ever; three of them cut throughput to five a
-- night permanently. The cron stayed green throughout, because a failed archive
-- deliberately does not fail the run — that exclusion exists so a Dropbox
-- hiccup never trains Dan to ignore a red run, and it also meant the only signal
-- was a show page quietly reading "12 originals — 3 archived" and never moving.
--
-- Counting the failures fixes both halves. Ordering by this column ahead of
-- created_at lets a bad row drift to the back of the queue instead of blocking
-- everything behind it, and the count itself is what the cron reports so a
-- permanently stuck receipt is visible rather than merely slow.
--
-- ADDITIVE ONLY. Nothing is dropped, nothing is altered, no row is rewritten:
-- Postgres 11 and later store a non-volatile default in the catalogue rather
-- than rewriting the table. 0015 dropped a column that running code still read
-- and took the live app down, which is why every migration here since has been
-- additive.
alter table expenses add column receipt_archive_attempts integer not null default 0;

-- 0019's index is on (created_at) with this same predicate, which no longer
-- serves the ordering the archive query now uses. This one leads with the
-- attempt count so the sort is satisfied by the index rather than by sorting the
-- matched rows.
--
-- 0019's index is deliberately LEFT IN PLACE. Dropping it is a removal, and a
-- removal ships separately from the thing that replaces it — the same rule 0015
-- and 0018 cost us. It is a small partial index over a shrinking minority of
-- rows; it costs a little write amplification and nothing else until someone
-- decides to retire it on purpose.
create index expenses_unarchived_attempts_idx
  on expenses (receipt_archive_attempts, created_at)
  where receipt_original is not null and receipt_archived_at is null;
