-- 0017 — where a show is, separately from where in it
--
-- shows.venue already exists and is already rendered on both the shows list and
-- the show page. But venue is the BUILDING — "Manchester Grand Hyatt - San
-- Diego" — so the city lands at the end of a long string and cannot be scanned.
-- Dan started putting the city in the show NAME as well, which is why two of
-- three shows read "... - San Diego, CA" and "... - ORLANDO, FL" with the city
-- also inside the venue.
--
-- One short field, free text, because that is how he types it: "San Diego, CA".
-- Deliberately NOT structured city/state — a show is not billed to an address,
-- nothing computes on it, and the clients table already learned that structured
-- address parts only earn their keep when something reads them back.
alter table shows add column location text;

comment on column shows.location is
  'Where the show is, for scanning a list — "San Diego, CA". venue stays the '
  'building. Nothing computes on this.';
