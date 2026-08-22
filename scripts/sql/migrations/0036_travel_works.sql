-- 0036 — a travel day that is also a work day
--
-- Travel is a flag on a day, not a day type (0005), and INVOICES ALREADY GET
-- THIS RIGHT: computeShowLines counts travel_in/travel_out legs outside its
-- punched-hours gate, so a travel day nobody worked already bills its leg
-- alone, and one that was worked already bills the leg AND the day rate.
-- Nothing about billing needs this column.
--
-- The forecast is what cannot tell. A show that has not happened has no
-- punches, so lib/forecast.ts has no way to know whether a future travel day
-- will also be worked; it assumes not, which is conservative but wrong
-- whenever Dan does both ("Sometimes we travel and work the same day which
-- would be more money"). This column is that missing fact and nothing more:
-- when set, the PROJECTION adds a day rate on top of the travel rate.
--
-- Default false: every existing row keeps today's behavior, every projection
-- is unchanged, and every code path that ignores the column behaves exactly
-- as before. ADDITIVE ONLY, per the 0020 rule.
alter table show_days add column travel_works boolean not null default false;

comment on column show_days.travel_works is
  'Forecast-only: a travel day Dan also expects to work, so the projection adds a day rate on top of the travel rate. Meaningful only on a day carrying travel_in and/or travel_out; cleared when the last travel flag is cleared. Never read by computeShowLines or any invoice path — billing works from punches and legs.';
