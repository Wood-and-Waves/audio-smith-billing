-- 0032 — the invoice/expense bridge: links between bank rows and the
-- billing half, plus the date money actually landed.
--
-- invoices.paid_at is distinct from sent_at. It is stamped only by the two
-- paths that know money arrived: accepting a deposit match (the bank row's
-- own date — authoritative) and setInvoiceStatus(id,'paid') (today — a
-- guess the deposit match corrects later). Any other status clears it.
alter table invoices add column paid_at date;

-- Link TABLES, not columns on ledger_transactions: Streamline pays two
-- invoices with one check (N invoices per deposit), and one $40.25 Uber
-- Eats expense posted at Chase as $33.25 + $7.00 (N bank rows per
-- expense). No amount column on purpose: the invoice knows its total and
-- the bank row knows its own, so a link only asserts "these belong
-- together" — a link means paid in full. Partial payments, if they ever
-- happen, are a future nullable amount_cents (null = in full).
create table ledger_transaction_invoices (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references ledger_transactions(id) on delete cascade,
  invoice_id     uuid not null references invoices(id) on delete cascade,
  created_at     timestamptz not null default now(),
  unique (transaction_id, invoice_id)
);
create index lti_invoice_idx on ledger_transaction_invoices (invoice_id);

create table ledger_transaction_expenses (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references ledger_transactions(id) on delete cascade,
  expense_id     uuid not null references expenses(id) on delete cascade,
  created_at     timestamptz not null default now(),
  unique (transaction_id, expense_id)
);
create index lte_expense_idx on ledger_transaction_expenses (expense_id);

-- Proposals are recomputed fresh on every visit — the matcher is pure and
-- holds no state — so without this suppression list a rejected guess would
-- return after every import. Discriminated (invoice XOR expense) because a
-- dismissal names one target; dismissing a sum proposal writes one row per
-- target, and any dismissed pair suppresses the whole group.
create table ledger_match_dismissals (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references ledger_transactions(id) on delete cascade,
  invoice_id     uuid references invoices(id) on delete cascade,
  expense_id     uuid references expenses(id) on delete cascade,
  created_at     timestamptz not null default now(),
  check (num_nonnulls(invoice_id, expense_id) = 1),
  unique (transaction_id, invoice_id),
  unique (transaction_id, expense_id)
);

-- Standard owner-scoped RLS (the 0030 idiom).
do $$
declare t text;
begin
  foreach t in array array[
    'ledger_transaction_invoices',
    'ledger_transaction_expenses',
    'ledger_match_dismissals'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t || '_owner_all', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
