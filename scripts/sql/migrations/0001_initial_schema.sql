-- 0001 — initial schema for The Audio Smith invoicing
--
-- Single-user app. Every table is owner-scoped by `auth.uid()` rather than the
-- multi-org machinery CrewTracker needs; one policy per table, not 43.
--
-- Money is ALWAYS bigint cents. Never numeric, never float. See lib/money.ts.
-- Quantity is bigint hundredths, so 4.5 hours is 450 and stays exact.

-- ---------------------------------------------------------------------------
-- settings — exactly one row, the business's own details
-- ---------------------------------------------------------------------------
create table settings (
  id                  int primary key default 1,
  owner_id            uuid not null references auth.users(id) on delete cascade,

  business_name       text not null default 'The Audio Smith',
  legal_name          text not null default 'Smith Audio, LLC',
  address_line1       text,
  address_line2       text,
  phone               text,
  email               text,

  -- Prints on every invoice.
  remit_to            text,
  -- Stored but NOT printed: clients ask for it. Keeping bank details off a
  -- PDF that gets forwarded around is the whole point.
  ach_details         text,

  default_terms_days  int not null default 30,
  default_tax_bp      int not null default 0,   -- basis points; 0 on all 94 to date
  next_invoice_number int not null default 389, -- sheet ended at 388

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint settings_singleton check (id = 1)
);

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------
create table clients (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete cascade,

  name               text not null,
  billing_email      text,
  contact_name       text,
  phone              text,
  address_line1      text,
  address_line2      text,

  terms_days         int not null default 30,

  -- The rate card. Travel and overtime are DERIVED from these two at
  -- suggestion time, then stored on the line — see lib/money.ts. Dan's
  -- history has both $106.36 and $106.37 for the same computed rate, so
  -- recomputing on read would silently rewrite invoices already sent.
  day_rate_cents     bigint,
  ot_after_hours     numeric(4,1) not null default 10,

  -- Spellings this client appeared under in the old sheet. Kept so the
  -- import is auditable and a stray variant can be traced back.
  legacy_names       text[] not null default '{}',

  notes              text,
  archived           boolean not null default false,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint clients_name_not_blank check (length(btrim(name)) > 0)
);

create unique index clients_owner_name_uniq on clients (owner_id, lower(name));
create index clients_owner_active_idx on clients (owner_id) where not archived;

-- ---------------------------------------------------------------------------
-- items — the reusable catalogue (Day Rate, Travel, Overtime, Per Diem, ...)
-- ---------------------------------------------------------------------------
create table items (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references auth.users(id) on delete cascade,

  name                text not null,
  unit_label          text not null default 'each',  -- day | hour | each
  default_price_cents bigint not null default 0,

  -- 'flat'     — price comes from the item or the client rate card
  -- 'derived'  — price is computed from the client's day rate (travel, OT, DT)
  kind                text not null default 'flat',
  derive_rule         text,   -- 'travel_half' | 'overtime_1_5x' | 'double_time_2x'

  sort_order          int not null default 0,
  archived            boolean not null default false,
  created_at          timestamptz not null default now(),

  constraint items_kind_valid check (kind in ('flat', 'derived')),
  constraint items_derive_rule_valid check (
    (kind = 'flat' and derive_rule is null) or
    (kind = 'derived' and derive_rule in ('travel_half','overtime_1_5x','double_time_2x'))
  )
);

create unique index items_owner_name_uniq on items (owner_id, lower(name));

-- ---------------------------------------------------------------------------
-- client_rates — per-client price override for a catalogue item
-- ---------------------------------------------------------------------------
create table client_rates (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  client_id        uuid not null references clients(id) on delete cascade,
  item_id          uuid not null references items(id) on delete cascade,
  unit_price_cents bigint not null,
  created_at       timestamptz not null default now(),

  unique (client_id, item_id)
);

-- ---------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------
create table invoices (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  client_id        uuid not null references clients(id) on delete restrict,

  number           int not null,
  issue_date       date not null,
  due_date         date not null,
  terms_days       int not null default 30,

  -- draft | sent | paid | void.
  -- "Overdue" is deliberately NOT a status: it is derived from due_date and
  -- the balance. A stored overdue flag is a lie whenever the cron hasn't run.
  status           text not null default 'draft',

  -- The client's address frozen at issue time. Editing a client later must
  -- not silently rewrite an invoice already in someone's inbox.
  bill_to_snapshot text,

  subtotal_cents   bigint not null default 0,
  tax_bp           int    not null default 0,
  tax_cents        bigint not null default 0,
  deposit_cents    bigint not null default 0,
  total_cents      bigint not null default 0,

  notes            text,
  sent_at          timestamptz,

  -- True for the 94 rows loaded from the Google Sheet.
  imported         boolean not null default false,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint invoices_status_valid check (status in ('draft','sent','paid','void')),
  constraint invoices_number_positive check (number > 0)
);

create unique index invoices_owner_number_uniq on invoices (owner_id, number);
create index invoices_client_idx on invoices (client_id);
create index invoices_open_idx on invoices (owner_id, due_date) where status = 'sent';

-- ---------------------------------------------------------------------------
-- invoice_lines
-- ---------------------------------------------------------------------------
create table invoice_lines (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  invoice_id       uuid not null references invoices(id) on delete cascade,

  position         int not null default 0,
  description      text not null default '',
  qty_hundredths   bigint not null default 100,   -- 4.5 -> 450
  unit_price_cents bigint not null default 0,
  line_total_cents bigint not null default 0,

  -- Where the price came from, for reporting. Null on imported history.
  item_id          uuid references items(id) on delete set null,

  created_at       timestamptz not null default now()
);

create index invoice_lines_invoice_idx on invoice_lines (invoice_id, position);

-- ---------------------------------------------------------------------------
-- payments — a table, not an amount_paid column, so partial payments work
-- ---------------------------------------------------------------------------
create table payments (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  invoice_id   uuid not null references invoices(id) on delete cascade,

  paid_on      date not null default current_date,
  amount_cents bigint not null,
  method       text,          -- check | ach | bill.com | other
  note         text,
  created_at   timestamptz not null default now()
);

create index payments_invoice_idx on payments (invoice_id);

-- ---------------------------------------------------------------------------
-- reminder_log — stops the daily cron sending the same notice every morning
-- ---------------------------------------------------------------------------
create table reminder_log (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,

  kind       text not null,   -- upcoming | overdue | digest
  sent_to    text,
  sent_at    timestamptz not null default now(),

  constraint reminder_kind_valid check (kind in ('upcoming','overdue','digest'))
);

create index reminder_log_invoice_idx on reminder_log (invoice_id, kind, sent_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The project has automatic RLS on, so these tables already have it enabled —
-- but state it explicitly rather than depending on a project setting that a
-- future rebuild might not carry. Without a policy, RLS denies everything.
-- ---------------------------------------------------------------------------
alter table settings      enable row level security;
alter table clients       enable row level security;
alter table items         enable row level security;
alter table client_rates  enable row level security;
alter table invoices      enable row level security;
alter table invoice_lines enable row level security;
alter table payments      enable row level security;
alter table reminder_log  enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'settings','clients','items','client_rates',
    'invoices','invoice_lines','payments','reminder_log'
  ] loop
    execute format(
      'create policy %I_owner_all on public.%I
         for all to authenticated
         using (owner_id = auth.uid())
         with check (owner_id = auth.uid())', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
--
-- "Automatically expose new tables" is off, so `authenticated` has no SELECT
-- and must be granted it explicitly. `anon` gets nothing at all — and the
-- stray TRUNCATE/REFERENCES/TRIGGER that Supabase's defaults hand it are
-- revoked here too, so the app is locked from both directions.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'settings','clients','items','client_rates',
    'invoices','invoice_lines','payments','reminder_log'
  ] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql
security definer
set search_path = public   -- CrewTracker lost every signup to a missing one of these
as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger settings_updated_at before update on settings
  for each row execute function set_updated_at();
create trigger clients_updated_at before update on clients
  for each row execute function set_updated_at();
create trigger invoices_updated_at before update on invoices
  for each row execute function set_updated_at();
