-- 0026 — the tax set-aside rate behind the per-show take-home estimate
--
-- Each show's profit card multiplies profit by this rate to say "set aside
-- $X for taxes, take home $Y." Basis points, like default_tax_bp beside it:
-- 3000 = 30%. Default 0 = "not configured" — the card shows a nudge to set
-- it in Settings instead of inventing a number. The rate is Dan's (or his
-- CPA's) figure; the app only stores and applies it. It is an ESTIMATE —
-- S-Corp tax is annual and entity-level, not per-show — never tax advice.
--
-- ADDITIVE ONLY, per the 0020 rule.
alter table settings add column tax_setaside_bp integer not null default 0;

comment on column settings.tax_setaside_bp is
  'Tax set-aside rate in basis points (3000 = 30%) for the per-show take-home estimate. 0 = unset; the UI nudges instead of estimating. Dan''s/CPA''s number — the app never picks it.';
