-- 0010 — expenses, and the receipts that make them billable
--
-- Replaces the "Gig Expense Calc" sheet: one tab per trip, three columns of
-- where+amount, each totalled, each total retyped onto an invoice. That
-- retyping is why the same expense appears as Baggage, Baggage Fees, Baggage
-- Expenses and Baggage Fee across five years. The category now owns the label.
--
-- Every expense must have a receipt to be billed. There is deliberately NO
-- has_receipt column: the file is the flag. A boolean beside a file is a second
-- source of truth, and the sheet's own Rcpt column is the evidence that it
-- drifts out of step.
create table expenses (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  show_id     uuid not null references shows(id) on delete cascade,

  -- Fixed set. The category carries the invoice-line label, which is the whole
  -- point: a label that is chosen cannot drift.
  category    text not null check (category in ('meals', 'rides', 'baggage', 'other')),

  -- "where", but not `where` — that is a reserved word and quoting it forever
  -- is a tax on every query that touches this table.
  where_spent text not null check (length(btrim(where_spent)) > 0),

  amount_cents bigint not null check (amount_cents > 0),
  spent_on    date not null,

  -- Storage keys. receipt_path is the enhanced image and is what gets shown and
  -- sent; receipt_original is the untouched upload, kept because hard contrast
  -- can erase a faint thermal total, and because a future OCR pass should
  -- re-read the original rather than a lossy derivative.
  receipt_path     text,
  receipt_original text,

  note        text,
  created_at  timestamptz not null default now()
);

create index expenses_show_idx on expenses (show_id, category, spent_on);

alter table expenses enable row level security;

create policy expenses_owner_all on public.expenses
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

revoke all on public.expenses from anon;
grant select, insert, update, delete on public.expenses to authenticated;
grant all on public.expenses to service_role;

-- Receipts live in a PRIVATE bucket. A receipt carries a vendor, a date and an
-- amount; the bucket must never be enumerable and no public URL may exist.
-- Reads go through short-lived signed URLs.
--
-- 10MB ceiling and an image whitelist: the browser uploads a downscaled JPEG,
-- so anything larger is a bug or an accident, and the limit is enforced by
-- storage rather than trusted from the client.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760, array['image/jpeg', 'image/png']);

-- Paths are {owner_id}/{show_id}/{stamp}-{enhanced|original}.jpg, so the leading
-- folder is the owner and this policy can match on it. The name cannot carry the
-- expense id: the files are uploaded before the row exists, which is deliberate
-- -- a row pointing at a failed upload is a receipt that appears to exist and
-- cannot be opened.
create policy receipts_owner_all on storage.objects
  for all to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
