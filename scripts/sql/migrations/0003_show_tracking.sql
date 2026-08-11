-- 0003 — show time tracking
--
-- The rate card is COPIED onto the show, not referenced. Raising a client's
-- day rate next year must not retroactively change a show already billed —
-- the same reasoning as invoices.bill_to_snapshot.

create table shows (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete restrict,

  name        text not null,
  venue       text,
  timezone    text not null default 'America/Chicago',

  status      text not null default 'open',      -- open | billed
  invoice_id  uuid references invoices(id) on delete set null,

  -- Frozen rate card. Stored, not computed on read.
  day_rate_cents              bigint not null default 0,
  travel_rate_cents           bigint not null default 0,
  pm_rate_cents               bigint not null default 0,
  ot_after_hours              numeric(4,1) not null default 10,
  dt_after_hours              numeric(4,1),          -- null = no double time
  minimum_meal_break_minutes  int not null default 60,
  meal_break_deduction_cap    int not null default 60,
  meal_penalty_grace_hours    numeric(4,1) not null default 6,
  meal_penalty_cents          bigint not null default 0,
  short_turn_rest_hours       numeric(4,1) not null default 10,
  continuous_time_enabled     boolean not null default false,

  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint shows_status_valid check (status in ('open','billed')),
  constraint shows_name_not_blank check (length(btrim(name)) > 0)
);

create index shows_owner_status_idx on shows (owner_id, status);
create index shows_client_idx on shows (client_id);

create table show_days (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  show_id         uuid not null references shows(id) on delete cascade,

  date            date not null,
  day_type        text not null default 'show',   -- show | travel | pm
  pay_as_half_day boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now(),

  constraint show_days_type_valid check (day_type in ('show','travel','pm')),
  unique (show_id, date, day_type)
);

create index show_days_show_idx on show_days (show_id, date);

create table punches (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  show_day_id  uuid not null references show_days(id) on delete cascade,

  punch_type   text not null,
  punched_at   timestamptz not null,
  created_at   timestamptz not null default now(),

  constraint punches_type_valid check (
    punch_type in ('start','meal_out','meal_in','meal2_out','meal2_in','end')),
  unique (show_day_id, punch_type)
);

create index punches_day_idx on punches (show_day_id);

-- RLS, matching 0001.
alter table shows     enable row level security;
alter table show_days enable row level security;
alter table punches   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['shows','show_days','punches'] loop
    execute format(
      'create policy %I_owner_all on public.%I
         for all to authenticated
         using (owner_id = auth.uid())
         with check (owner_id = auth.uid())', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

create trigger shows_updated_at before update on shows
  for each row execute function set_updated_at();
