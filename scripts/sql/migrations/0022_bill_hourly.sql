-- 0022 — bill a show by the hour below the overtime threshold
--
-- Some work (a church, Willow Creek) pays hourly for a sub-10-hour day, then
-- day-rate + OT at 10h+. The hourly rate is always day_rate / ot_after_hours
-- ($600/10 = $60), so it is derived, never stored — this flag is the only new
-- state. Off by default: every existing show and card bills exactly as before.
--
-- On both tables, mirroring every other rate rule: the card carries the
-- default, the show freezes it at creation and can override it.
--
-- Additive only. Nothing dropped or altered — Postgres stores a non-volatile
-- default in the catalogue rather than rewriting the table.
alter table client_rate_cards add column bill_hourly boolean not null default false;
alter table shows            add column bill_hourly boolean not null default false;
