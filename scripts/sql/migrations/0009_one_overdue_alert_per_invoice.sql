-- 0009 — one overdue alert per invoice, enforced
--
-- The cron emails first and logs second, so that a failed send never records a
-- message that did not go. The cost is that a failed INSERT leaves an invoice
-- that has been emailed but not logged — and since "have I alerted about this?"
-- is answered purely by the log, the same alert would send every morning
-- forever. Two overlapping invocations can also both read an empty log and both
-- send.
--
-- A partial unique index makes "at most one overdue alert per invoice" a
-- property of the database rather than a hope about timing. It does not
-- constrain client_reminder, which is deliberately repeatable.
create unique index reminder_overdue_alert_once
  on reminder_log (invoice_id)
  where kind = 'overdue_alert';
