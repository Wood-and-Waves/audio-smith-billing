-- 0035 — two facts the forecast needs and could not infer.
--
-- pm_role: whether Dan is the production manager on this show. Actual PM work
-- has always billed from pm_entries; this flag is what lets a show that has
-- not happened yet project the PM hours it will almost certainly carry.
alter table shows add column pm_role boolean not null default false;

comment on column shows.pm_role is
  'Dan is PM on this show. Forecast-only: projects a fixed block of PM hours. Actual PM billing still comes from pm_entries.';

-- home_state: the forecast assumes a show outside Dan''s home state costs two
-- travel legs (out and back) at that show''s own travel rate. Same-state shows
-- are drives — Chicago and South Barrington both being IL is exactly the case
-- a city-name test got wrong.
alter table settings add column home_state text not null default 'IL';

comment on column settings.home_state is
  'Two-letter state Dan travels from. A show whose location names a different state projects two travel legs.';
