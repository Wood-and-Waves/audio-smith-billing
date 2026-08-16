-- 0021 — the Monday digest gets logged, like every other reminder
--
-- Every reminder kind writes a reminder_log row so it cannot fire twice. The
-- digest was the exception: it sent and recorded nothing. Vercel retries a cron
-- invocation that times out or errors, and two overlapping invocations both see
-- no log, so a slow Monday sends the digest twice.
--
-- It could not simply be added, which is why this migration exists. invoice_id
-- was NOT NULL, and a digest is not about one invoice — it is about all of
-- them. An insert would have been rejected every Monday, landed in `failed`,
-- and turned the run red permanently: worse than the duplicate it fixed.
--
-- Three parts, and each one is load-bearing.

-- 1. invoice_id becomes optional, but ONLY for a digest.
--
-- The CHECK is an equivalence, not a one-way rule: a digest MUST have no
-- invoice, and every other kind MUST have one. Written as `invoice_id is null
-- or kind = 'digest'` it would have quietly allowed a null invoice_id on an
-- overdue_alert too, which is the row that stops the same alert emailing every
-- morning forever.
alter table reminder_log alter column invoice_id drop not null;

alter table reminder_log add constraint reminder_invoice_id_presence
  check ((kind = 'digest') = (invoice_id is null));

-- 2. The calendar day the message went out, in Chicago.
--
-- NOT the UTC date of sent_at. A digest sent after 7pm Central falls on the
-- next UTC day, so a UTC-keyed uniqueness rule would let a Monday-evening
-- retry through as "Tuesday". lib/dates.ts warns this slicing "bit CrewTracker
-- twice"; this column is how the app stops doing it.
--
-- It is a stored column rather than an expression index because converting a
-- timestamptz to a local date is STABLE, not IMMUTABLE — Postgres will not
-- index it. The app already computes this exact value as `today` before it
-- sends anything.
--
-- NOT NULL is safe here: reminder_log is empty. Verified immediately before
-- writing this migration — `select kind, count(*) from reminder_log group by
-- kind` returned no rows.
alter table reminder_log add column sent_on date not null;

-- 3. One digest per owner per day, as a property of the database.
--
-- The same shape as 0009's reminder_overdue_alert_once, and for the same
-- reason: two overlapping invocations can both read an empty log, so "have I
-- sent this?" cannot be answered by reading. The index makes the second
-- claimant lose.
--
-- Partial, so it constrains nothing else. client_reminder in particular is
-- deliberately repeatable — Dan can nudge a client more than once.
create unique index reminder_digest_once_per_day
  on reminder_log (owner_id, sent_on)
  where kind = 'digest';
