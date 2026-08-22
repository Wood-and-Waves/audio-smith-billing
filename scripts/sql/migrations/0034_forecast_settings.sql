-- 0034 — the three numbers the cash-flow forecast needs from Dan.
--
-- tax_setaside_bp (0026) already carries the set-aside rate; these join it.
-- All nullable-or-defaulted and additive: every existing read keeps working.
alter table settings
  -- What Dan needs to draw each month. 0 = not set yet; the forecast asks
  -- for it rather than guessing.
  add column monthly_take_home_cents bigint not null default 0,
  -- An override for computed overhead. NULL = use the trailing 3-month
  -- average, which is the intended default; a number wins over the average.
  add column monthly_overhead_cents bigint,
  -- Days from a show's last day to the invoice going out.
  add column billing_lag_days int not null default 7;

comment on column settings.monthly_take_home_cents is
  'Dan''s monthly take-home need, integer cents. 0 = unset (forecast prompts).';
comment on column settings.monthly_overhead_cents is
  'Override for projected monthly overhead, integer cents. NULL = use the trailing 3-month average.';
comment on column settings.billing_lag_days is
  'Assumed days from last show day to invoice sent, for projecting when money lands.';
