-- 0033 — the calendar: flights, the feed token, and the feed's reader.
--
-- Flights are schedule entries, not billing data — no show link, no money
-- column. Everything except the number and date is nullable on purpose: a
-- lookup that fails must never block saving "AA1234 on 9/12"; the calendar
-- shows what it has (an all-day entry until times arrive).
create table flights (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  flight_no    text not null check (flight_no ~ '^[A-Z0-9]{2,8}$'),
  flight_date  date not null,
  dep_airport  text,        -- IATA ("ORD")
  arr_airport  text,
  dep_at       timestamptz, -- scheduled instants; flights cross timezones
  arr_at       timestamptz,
  dep_tz       text,        -- IANA zone when the provider supplies it;
  arr_tz       text,        --   display falls back to America/Chicago
  note         text,
  created_at   timestamptz not null default now(),

  constraint flights_arrival_after_departure
    check (dep_at is null or arr_at is null or arr_at >= dep_at)
);

create index flights_owner_date_idx on flights (owner_id, flight_date);

-- Standard owner-scoped RLS (the 0030/0032 idiom).
do $$
declare t text;
begin
  foreach t in array array['flights']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t || '_owner_all', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- The feed token. A uuid like invoices.public_token: crypto.randomUUID() on
-- the app side, nullable (null = no feed issued), regenerating kills the old
-- URL — which is the whole of revocation, same as 0006.
alter table settings add column calendar_token uuid;

-- The feed's reader. Security definer like public_invoice (0006): anon holds
-- no table privileges; this function returns ONE owner's schedule by
-- unguessable token and nothing else. SCHEDULE FACTS ONLY — names, places,
-- dates, flight times. No rates, totals, or invoice numbers may ever join
-- these selects: the feed is a client-facing surface even though only Dan
-- holds the URL.
create function public.public_calendar_feed(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select case when s.owner_id is null then null else jsonb_build_object(
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',         d.id,
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

-- Pin the search path (the 0007 hardening) and apply least privilege (0024):
-- create function grants EXECUTE to PUBLIC by default.
alter function public.public_calendar_feed(uuid) set search_path = public, pg_temp;
revoke all on function public.public_calendar_feed(uuid) from public;
grant execute on function public.public_calendar_feed(uuid) to anon, authenticated;
