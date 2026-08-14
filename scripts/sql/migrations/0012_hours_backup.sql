-- 0012 — hours on the invoice, and a frozen backup
--
-- Two columns, one idea: the PDF's backup pages become part of the invoice
-- rather than a live view of the shows behind it.
--
-- invoice_lines has always been a snapshot. The expense itemisation shipped
-- deriving live from `shows where invoice_id = …`, so unlinking one show of two
-- left page 1 charging Meal Expenses $386.21 while the itemisation re-derived
-- to $266.21 — one document disagreeing with itself. Hours would be worse: they
-- are the JUSTIFICATION for money already charged, and backup that contradicts
-- the charge turns a client's silent trust into a dispute.
alter table invoices add column backup_snapshot jsonb;

-- Wanting backup is a property of the client, like their rate card — a
-- production company does, a church does not. Off by default.
alter table clients add column show_hours_on_invoice boolean not null default false;

comment on column invoices.backup_snapshot is
  'Frozen at bill time: hours rows, the expense itemisation, and the render '
  'decision. Null on every invoice billed before migration 0012 — those render '
  'no backup pages, which is what they already do.';
