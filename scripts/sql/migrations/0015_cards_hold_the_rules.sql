-- 0015 — a rate card holds the whole rate agreement
--
-- Dan: "The rate card should hold all of the rate rules." A card held a day
-- rate, an overtime threshold and a full/half travel switch; everything else
-- took the shows-table default and was set by hand on every show. So a client
-- who pays meal penalties and one who does not looked identical on their cards.
--
-- His three Streamline arrangements make the case: the default at $780 with
-- overtime after 10 hours, "PwC A1" at $780 with overtime after 12, and
-- "PwC PM" at $900 after 12. The first two differ ONLY by a rule.
alter table client_rate_cards
  add column travel_rate_cents          bigint,
  add column pm_rate_cents              bigint,
  -- null = no double time, matching shows.dt_after_hours
  add column dt_after_hours             numeric(4,1),
  add column minimum_meal_break_minutes int          not null default 60,
  add column meal_break_deduction_cap   int          not null default 60,
  add column meal_penalty_grace_hours   numeric(4,1) not null default 6,
  add column meal_penalty_cents         bigint       not null default 0,
  add column short_turn_rest_hours      numeric(4,1) not null default 10,
  add column continuous_time_enabled    boolean      not null default false;

-- The defaults above are exactly the shows-table defaults, so a show created
-- from an existing card comes out identical to one created yesterday.

-- Backfill the two that used to be derived at show-creation time.
update client_rate_cards
   set travel_rate_cents = case when travel_full_day then day_rate_cents
                                else round(day_rate_cents / 2.0) end,
       pm_rate_cents     = case when ot_after_hours > 0
                                then round(day_rate_cents / ot_after_hours) else 0 end;

alter table client_rate_cards
  alter column travel_rate_cents set not null,
  alter column pm_rate_cents     set not null,
  add constraint card_travel_nonneg check (travel_rate_cents >= 0),
  add constraint card_pm_nonneg     check (pm_rate_cents >= 0);

-- Superseded by the explicit travel_rate_cents. A switch cannot express a flat
-- arrangement — $200 a leg regardless of the day rate — which is why it goes.
alter table client_rate_cards drop column travel_full_day;
