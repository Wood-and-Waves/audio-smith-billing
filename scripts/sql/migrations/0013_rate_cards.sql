-- 0013 — rate cards, travel at full or half day, addresses, and naming the work
--
-- Streamline Pictures pays $900 for PwC PM work and $780 for everything else.
-- A client has had exactly one day_rate_cents, frozen onto each show at
-- creation. Dan could already make a $900 show by editing the rate afterwards —
-- but travel_rate_cents and pm_rate_cents were derived from $780 at creation and
-- stayed there, because updateShow takes all three as independent raw inputs and
-- re-derives nothing. Choosing the right card at creation is what fixes that.
create table client_rate_cards (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  client_id        uuid not null references clients(id) on delete cascade,

  -- NULL is the default card, and a default decorates no invoice line. Naming
  -- it would put "Day Rate — Standard" on every invoice for every client,
  -- including the many who will only ever have one rate.
  name             text,

  day_rate_cents   bigint not null check (day_rate_cents > 0),
  ot_after_hours   numeric(4,1) not null default 10,

  -- Travel bills per LEG, so this doubles a fly-in/fly-out trip from one day
  -- rate to two. That is the intended reading of "some companies pay a full day
  -- rate for a travel day", and it is surprising enough to be worth saying here.
  travel_full_day  boolean not null default false,

  created_at       timestamptz not null default now(),
  constraint card_name_not_blank check (name is null or length(btrim(name)) > 0)
);

create index client_rate_cards_client_idx on client_rate_cards (client_id, name);

-- One default per client. Two would make "which rate does a new show get"
-- ambiguous, and the answer would be whichever row came back first.
create unique index client_rate_cards_default_once
  on client_rate_cards (client_id) where name is null;

alter table client_rate_cards enable row level security;
create policy client_rate_cards_owner_all on public.client_rate_cards
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.client_rate_cards from anon;
grant select, insert, update, delete on public.client_rate_cards to authenticated;
grant all on public.client_rate_cards to service_role;

-- Backfill: every client that has a rate gets it as their default card. Nothing
-- is invented. Nine of twenty clients have no rate at all — Journey Church and
-- Harvest Bible Chapel among them — because their invoices were always written
-- by hand rather than billed from shows. They get no card, and createShow keeps
-- refusing them with the message it already gives.
insert into client_rate_cards (owner_id, client_id, day_rate_cents, ot_after_hours)
select owner_id, id, day_rate_cents, ot_after_hours
  from clients
 where day_rate_cents is not null and day_rate_cents > 0;

comment on column clients.day_rate_cents is
  'SUPERSEDED by client_rate_cards. Left in place so 0013 stays reversible; a '
  'later migration drops it once cards are proven. Nothing reads it.';
comment on column clients.ot_after_hours is
  'SUPERSEDED by client_rate_cards — see clients.day_rate_cents.';

-- The show freezes the card it was created from, name included. Renaming a card
-- later must not rewrite an invoice already sent.
alter table shows add column rate_card_name text;

-- Who the work was for. billShows already writes show names into invoices.notes,
-- but notes prints in the small muted footer AND a hand-edit through
-- InvoiceEditor overwrites it, because that textarea is the source of truth.
alter table invoices add column work_for text;

alter table clients add column city text;
alter table clients add column state text;
alter table clients add column postal_code text;
