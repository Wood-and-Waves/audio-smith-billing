-- 0008 — the reminder kinds this app actually writes
--
-- 0001 allowed 'upcoming' | 'overdue' | 'digest', written before the reminder
-- feature existed. The feature distinguishes three things that vocabulary
-- cannot express: a note to the OWNER the first morning an invoice goes late,
-- a nudge sent to the CLIENT by hand, and the weekly digest.
--
-- This matters more than naming. The route emails first and logs second, on
-- purpose, so that a failed send never records a message that did not go. With
-- a rejected insert the log stays empty, the "already alerted" check never
-- becomes true, and the same invoice emails every morning forever.
--
-- The old values are kept: the table is empty today, but a constraint that
-- narrows is a constraint that can fail on data someone else wrote.
alter table reminder_log drop constraint reminder_kind_valid;

alter table reminder_log add constraint reminder_kind_valid
  check (kind in ('upcoming', 'overdue', 'digest', 'overdue_alert', 'client_reminder'));
