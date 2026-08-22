-- 0037 — travel_works requires a travel flag, enforced by the database
--
-- travel_works (0036) is meaningless without a travel flag, and the
-- forecast already ignores it there — but a stale `true` is INVISIBLE in
-- the UI, because TravelWorksToggle only renders when travel_in ||
-- travel_out is set. setTravelLeg used to enforce the clearing itself: read
-- both legs, and if the leg being cleared was the last one standing, also
-- clear travel_works in the same update. But that is a read-then-write, and
-- two legs racing (travel_in cleared and travel_out cleared in quick
-- succession) can interleave so both reads see the OTHER leg still true —
-- neither write clears travel_works, and the day ends with no travel flags
-- but travel_works still true. Re-flagging travel later would then silently
-- add a day rate to the forecast, with no record of why.
--
-- The invariant belongs to the row, not to whichever action last touched
-- it, so a trigger enforces it structurally: no combination of concurrent
-- writes can leave travel_works true on a day with neither travel flag set.
create or replace function show_days_travel_works_requires_travel() returns trigger
language plpgsql
as $$
begin
  if not new.travel_in and not new.travel_out then
    new.travel_works := false;
  end if;
  return new;
end $$;

create trigger show_days_travel_works_requires_travel
  before insert or update on show_days
  for each row execute function show_days_travel_works_requires_travel();

-- Normalize any rows that already reached the stale state before this
-- trigger existed.
update show_days set travel_works = false
  where travel_works and not travel_in and not travel_out;
