-- 0049 — the W-9 on file
--
-- New clients ask for a W-9 before they will pay a first invoice. Dan has
-- been emailing the PDF by hand from Dropbox; this puts it in the app so the
-- send-invoice panel can offer it as a second attachment on a checkbox.
--
-- The FILE itself lives in the existing private `receipts` bucket under
-- `{owner_id}/w9/…pdf`. That bucket's RLS already scopes every object by its
-- first path segment, so the W-9 inherits owner-only access with no new
-- policy. It is safe from the nightly receipt-reclaim sweep too: that stage
-- deletes only paths it reads out of the expenses table, never by listing the
-- bucket (app/api/cron/reminders/route.ts), so a path no expense row names
-- can never be selected for deletion.
--
-- A W-9 carries an EIN and a signature. It must never reach a public invoice
-- link or a backup snapshot — only the explicit checkbox attaches it, and
-- only to the client being invoiced.
--
-- Both columns nullable with no default: "no W-9 uploaded yet" is the honest
-- starting state and the panel hides the checkbox while it holds. ADDITIVE
-- ONLY, per the 0020 rule.

alter table settings add column w9_path text;
alter table settings add column w9_uploaded_at timestamptz;

comment on column settings.w9_path is
  'Storage path of the W-9 PDF in the private receipts bucket '
  '({owner_id}/w9/…pdf), or null when none is on file. Attached to an invoice '
  'email ONLY when Dan ticks the send panel''s checkbox; never public.';

comment on column settings.w9_uploaded_at is
  'When the current W-9 was uploaded — shown in Settings so Dan can see at a '
  'glance whether it is this year''s.';
