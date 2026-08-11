-- 0004 — show/invoice billing integrity
--
-- 0003 added shows.status ('open' | 'billed') and shows.invoice_id, always
-- set or cleared together in application code. Nothing in the schema
-- enforced that pairing, and the FK let it silently break: invoice_id was
-- declared `on delete set null`, so deleting an invoice would null the
-- reference but leave status = 'billed' behind. That show then matches
-- neither the open-show list (status <> 'billed') nor a lookup by
-- invoice_id — it vanishes, and the work it represents never gets rebilled.
-- `authenticated` holds delete on invoices, so this was reachable, not
-- theoretical.
--
-- Two corrections, both scoped to `shows`:
--   1. invoice_id's FK becomes `on delete restrict` — an invoice with shows
--      still attached can't be deleted out from under them.
--   2. A CHECK ties status and invoice_id together so the database rejects
--      any write that lets them disagree, rather than trusting every
--      caller to keep them in sync.

-- shows_invoice_id_fkey confirmed via pg_constraint before writing this
-- migration; dropping and re-adding by that name is how you change
-- ON DELETE behavior — there's no ALTER for it in place.
alter table shows
  drop constraint shows_invoice_id_fkey;

alter table shows
  add constraint shows_invoice_id_fkey
    foreign key (invoice_id) references invoices(id) on delete restrict;

-- status and invoice_id are one fact — "has this show been billed, and to
-- what" — stored in two columns because the invoice_id also needs to be
-- nullable when the show isn't billed. Verified zero existing rows would
-- violate this (shows was empty) before adding it. The database enforces
-- the pairing from here on rather than trusting every caller to set or
-- clear both together.
alter table shows
  add constraint shows_billed_matches_invoice
    check ((status = 'billed') = (invoice_id is not null));
