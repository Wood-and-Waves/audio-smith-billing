-- 0005 — travel becomes a flag, PM becomes a log, day_type disappears
--
-- Travel was a day type, which could not express flying in and working the same
-- day. The invoice history is unambiguous: travel bills as exactly two legs on
-- every trip while day rates range 1 to 6. It is a leg, not a day.
--
-- PM work was punched days. Real use showed prep happens in sporadic 30- and
-- 60-minute pieces; clocking in for half an hour of email is friction nobody
-- sustains. It becomes a logged duration.
--
-- With both gone, every show_days row is a work day and day_type has one
-- possible value, so it is dropped. That makes the unique constraint
-- (show_id, date) — one row per date — which removes the possibility of two
-- rows on one date each claiming the same travel leg.

alter table show_days
  add column travel_in  boolean not null default false,
  add column travel_out boolean not null default false;

-- Prep work, logged rather than punched. Minutes, because that is what gets
-- entered; hours are derived. Fifteen-minute increments are enforced in the
-- application, not here, so a correction typed directly into SQL is possible.
create table pm_entries (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  show_id    uuid not null references shows(id) on delete cascade,

  worked_on  date not null,
  minutes    int  not null,
  note       text,
  created_at timestamptz not null default now(),

  constraint pm_entries_minutes_positive check (minutes > 0)
);

create index pm_entries_show_idx on pm_entries (show_id, worked_on);

alter table pm_entries enable row level security;

create policy pm_entries_owner_all on public.pm_entries
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

revoke all on public.pm_entries from anon;
grant select, insert, update, delete on public.pm_entries to authenticated;
grant all on public.pm_entries to service_role;

-- --- Convert existing rows before the column can go -----------------------

-- A travel day becomes an ordinary day carrying the inbound leg. Which leg it
-- was is unknowable from the old model; inbound is the safer guess because a
-- trip's first travel day is its arrival, and it is one checkbox to correct.
update show_days set travel_in = true where day_type = 'travel';

-- A PUNCHED pm day carries real recorded time and must not be lost: convert it
-- to a log entry with its worked minutes. None exist today, but this migration
-- must be correct whenever it runs.
insert into pm_entries (owner_id, show_id, worked_on, minutes, note)
select d.owner_id, d.show_id, d.date,
       greatest(1, round(extract(epoch from (
         max(p.punched_at) filter (where p.punch_type = 'end') -
         min(p.punched_at) filter (where p.punch_type = 'start')
       )) / 60)::int),
       'Converted from a punched PM day'
  from show_days d
  join punches p on p.show_day_id = d.id
 where d.day_type = 'pm'
 group by d.id, d.owner_id, d.show_id, d.date
having max(p.punched_at) filter (where p.punch_type = 'end') is not null
   and min(p.punched_at) filter (where p.punch_type = 'start') is not null;

-- An UNPUNCHED pm day recorded no time at all, so it carries nothing forward.
delete from show_days where day_type = 'pm';

-- --- Drop the column ------------------------------------------------------

alter table show_days drop constraint if exists show_days_type_valid;
alter table show_days drop constraint if exists show_days_show_id_date_day_type_key;
alter table show_days drop column day_type;

-- One row per date. This is what makes a travel leg unambiguous.
alter table show_days add constraint show_days_show_date_uniq unique (show_id, date);
