-- 0047 — the calendar feed's day objects carry their show id
--
-- The feed becomes one VEVENT per show RUN instead of one per day (design:
-- docs/superpowers/specs/2026-08-25-calendar-show-bars-design.md, Dan's
-- own decision), so lib/ics.ts has to know which show each day belongs to
-- in order to group them. public_calendar_feed (0033) returns day objects
-- without show_id, and grouping by NAME would merge two different shows
-- that happen to share one. This adds the single missing field.
--
-- create or replace with an UNCHANGED signature: 0033's grants (anon,
-- authenticated), its security-definer posture and its pinned search_path
-- all carry over untouched, so no grant needs re-issuing here. The
-- SCHEDULE FACTS ONLY rule is unchanged — a show id is an opaque uuid, the
-- same class of identifier the old showday-<uuid> UIDs already published.

create or replace function public.public_calendar_feed(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select case when s.owner_id is null then null else jsonb_build_object(
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',         d.id,
        'show_id',    d.show_id,
        'date',       d.date,
        'show_name',  sh.name,
        'venue',      sh.venue,
        'location',   sh.location,
        'client',     c.name
      ) order by d.date)
      from show_days d
      join shows sh on sh.id = d.show_id
      join clients c on c.id = sh.client_id
      where d.owner_id = s.owner_id
    ), '[]'::jsonb),
    'flights', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',          f.id,
        'flight_no',   f.flight_no,
        'flight_date', f.flight_date,
        'dep_airport', f.dep_airport,
        'arr_airport', f.arr_airport,
        'dep_at',      f.dep_at,
        'arr_at',      f.arr_at
      ) order by f.flight_date)
      from flights f
      where f.owner_id = s.owner_id
    ), '[]'::jsonb)
  ) end
  from (
    select owner_id from settings where calendar_token = p_token
  ) s
$$;
