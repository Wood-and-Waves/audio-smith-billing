-- 0038 — the budget: assignments, targets, and a category''s budget role
--
-- YNAB''s Rule 1, done properly this time. 0030 built envelopes beside the
-- categories and they shipped empty — three rows, zero moves — because an
-- envelope that transactions never point at can show a balance but never an
-- activity. This wave puts the budget ON the categories transactions already
-- carry, so Activity is real from day one.
--
-- An assignment is an IMMUTABLE move between Ready to Assign (a null category
-- id) and a category, stamped with the month it belongs to. What a category has
-- assigned in a month is nothing but the sum of its moves — no mutable column to
-- drift, same doctrine as 0030. Undo marks; it never deletes.
--
-- The 0030 envelope tables are left in place, empty and unused. Nothing dropped.

alter table ledger_categories
  add column budget_role text not null default 'spending'
    check (budget_role in ('spending', 'income'));

comment on column ledger_categories.budget_role is
  'Whether this category is a budget row (''spending'') or an inflow that lands '
  'in Ready to Assign (''income''). Explicit rather than matching on the group '
  'name, which is user-editable text. Income categories keep their accountant '
  'meaning but never appear on the budget screen.';

create table ledger_budget_moves (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  -- The budgeted month, always the first of that month.
  month            date not null,
  -- null on either side = the Ready to Assign pool.
  from_category_id uuid references ledger_categories(id) on delete restrict,
  to_category_id   uuid references ledger_categories(id) on delete restrict,
  amount_cents     bigint not null check (amount_cents > 0),
  note             text,
  -- Undo marks, never deletes; redo clears it again.
  undone_at        timestamptz,
  created_at       timestamptz not null default now(),

  constraint lbm_somewhere check (from_category_id is not null or to_category_id is not null),
  constraint lbm_direction check (from_category_id is distinct from to_category_id),
  constraint lbm_month_is_first check (extract(day from month) = 1)
);

comment on table ledger_budget_moves is
  'One immutable assignment move. assigned(category, month) is the sum of moves '
  'in minus the sum out, ignoring rows with undone_at set. A move between two '
  'categories changes neither Ready to Assign nor the total — money just changes '
  'jobs.';

create index lbm_owner_month_idx on ledger_budget_moves (owner_id, month);
create index lbm_owner_created_idx on ledger_budget_moves (owner_id, created_at desc, id desc);

create table ledger_category_targets (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  category_id  uuid not null unique references ledger_categories(id) on delete cascade,
  kind         text not null check (kind in ('monthly', 'by_date')),
  amount_cents bigint not null check (amount_cents > 0),
  -- Required for by_date, null for monthly.
  due_date     date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint target_date_matches_kind
    check ((kind = 'by_date') = (due_date is not null))
);

comment on table ledger_category_targets is
  'A category''s goal: ''monthly'' refills to amount_cents each month, ''by_date'' '
  'reaches amount_cents by due_date. One target per category. YNAB does not '
  'export targets, so these are entered by hand and have no history — looking '
  'back at a past month judges it against today''s target.';

-- Owner pay becomes a real budget category. It is Dan''s largest budget line
-- ($45,774 assigned in 2026) and the screen cannot add up without it. This is a
-- RELAXATION, not a removal: no column is dropped and no row is lost, so it does
-- not repeat 0015. Transfers still may not carry a category. The accountant
-- export is unaffected because the Owner Pay category carries deductible = false,
-- the same flag the Income categories already use.
alter table ledger_transactions
  drop constraint lt_nocat_for_owner_or_transfer;

alter table ledger_transactions
  add constraint lt_nocat_for_transfer
    check (kind <> 'transfer' or category_id is null);

do $$
declare t text;
begin
  foreach t in array array['ledger_budget_moves','ledger_category_targets']
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
