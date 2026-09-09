-- 0051 — the draw Dan plans to take in a given month
--
-- The forecast used to charge a single monthly take-home every month, and to
-- pro-rate it by calendar day in the current month. Dan (2026-09-09):
-- "Proration is just flat out incorrect for how this should be calculated."
-- His draws are lumpy on purpose — $14,936 in July, $0 in August, $925 in
-- September because he took the rest from Wood and Waves that month — so a
-- calendar fraction cannot describe them.
--
-- WHY A TABLE rather than deriving it from the budget: the owner-pay
-- category's monthly ASSIGNMENT looks like a draw plan and is not one.
-- September assigns $3,784.65 while Dan intended to take $925; the envelope
-- accumulates toward future draws and also carries personal expenses. Dan:
-- "That available is set aside for the next time I pay myself." So the plan
-- has to be stated, not inferred.
--
-- A month with no row here falls back to settings.monthly_take_home_cents.
-- Absence means "the usual", never "zero" — a blank plan must not read as a
-- month where Dan takes nothing, which would flatter the runway.
--
-- ADDITIVE ONLY, per the 0020 rule.

create table forecast_draw_plans (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,

  -- Always the first of the month. The app writes 'YYYY-MM-01'; the check
  -- keeps a mid-month date from creating a second row for the same month
  -- that the unique constraint below would then fail to catch.
  month        date not null check (date_trunc('month', month) = month),

  -- A planned draw is never negative. Zero is meaningful and allowed: it is
  -- exactly September's case, a month where Dan plans to take nothing more.
  amount_cents integer not null check (amount_cents >= 0),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (owner_id, month)
);

alter table forecast_draw_plans enable row level security;
create policy forecast_draw_plans_owner_all on public.forecast_draw_plans
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.forecast_draw_plans from anon;
grant select, insert, update, delete on public.forecast_draw_plans to authenticated;
grant all on public.forecast_draw_plans to service_role;
