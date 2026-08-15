-- 0016 — put travel_full_day back until the code stops asking for it
--
-- 0015 dropped it in the same migration that added the explicit
-- travel_rate_cents replacing it. The plan behind 0015 claimed the column was
-- referenced in two files. It is referenced in EIGHT, and this repo has no
-- generated database types, so nothing failed at compile time — the deployed
-- app simply started erroring at request time on /clients, /clients/new,
-- /clients/[id] and /shows/new, because their queries name a column that no
-- longer exists.
--
-- A schema change that removes something the running code still reads has to
-- come AFTER that code ships, not with it. Restoring the column costs nothing:
-- travel_rate_cents is already populated and authoritative, and nothing reads
-- this one for its value any more.
--
-- The drop belongs in its own migration, once the last of those eight files
-- has stopped selecting it.
alter table client_rate_cards
  add column travel_full_day boolean not null default false;

comment on column client_rate_cards.travel_full_day is
  'SUPERSEDED by travel_rate_cents, and restored only so the currently deployed '
  'code keeps working. Nothing reads it for its value. Drop it in a migration '
  'AFTER the code that selects it has shipped.';

-- Restore the flag from the rate it produced, so anything still reading it
-- during the changeover sees something true rather than a blanket false.
update client_rate_cards
   set travel_full_day = (travel_rate_cents = day_rate_cents);
