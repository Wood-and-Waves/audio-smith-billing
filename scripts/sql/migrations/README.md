# Migrations

Numbered, applied in filename order, once each. `db-migrate.mjs` records a
SHA-256 of every file it applies and **refuses to run if an applied file was
later edited** — so a mistake in a migration that has already run is fixed by
writing the next migration, never by editing the old one.

Only `*.sql` is picked up; this file is documentation.

## Known caveats

### 0005 — rebuilding from these files against old data

Migration 0005 (travel legs, PM log, dropping `day_type`) has been applied to
production. It is correct for the data that existed there — `show_days` was
empty. Two branches in it are **wrong for a restore from an older backup**, and
because 0005 is already applied and checksummed, neither can be corrected in
place. Both are recorded here so a future restore does not walk into them.

**1. It aborts if any date carries both a `show` row and a `travel` row.**

Migration 0003's constraint was `unique (show_id, date, day_type)`, so two rows
on one date were legal — and that was the *only* way the old model could say
"flew in and worked the same day", the exact case this change exists to fix. So
it is a likely shape in a real backup. 0005 converts the travel row to
`travel_in = true` but never folds it into its same-date sibling; after
`drop column day_type` the two rows collide, and
`add constraint ... unique (show_id, date)` fails.

It fails safely — the whole migration runs in a transaction and rolls back — but
the database then sits at 0004 while all shipped code selects `travel_in`,
`travel_out` and `pm_entries`. Repair before re-running: fold the leg onto the
work row and drop the orphan, keyed on `day_type` so it must run *before* the
column is dropped.

```sql
update show_days s set travel_in = true
  from show_days t
 where t.day_type = 'travel' and s.day_type = 'show'
   and s.show_id = t.show_id and s.date = t.date;

delete from show_days t using show_days s
 where t.day_type = 'travel' and s.day_type = 'show'
   and s.show_id = t.show_id and s.date = t.date;
```

Which leg the old row meant is unknowable from the old model; `travel_in` is the
consistent guess and is one checkbox to correct. Billing is unaffected either
way — a leg counts as one leg.

**2. Converted PM entries are gross minutes, not net.**

The conversion takes `max(end) - min(start)` and deducts nothing for meal
breaks, where `lib/payroll.ts` deducted a qualifying meal. On the Streamline
card ($780/day, OT after 11h → PM $70.91/hr), an 8-hour PM day with a 1-hour
meal billed 7 hours ($496.37) under the old model and converts to 480 minutes,
which ceilings to 8 hours ($567.28) — **$70.91 over.** Separately,
`greatest(1, ...)` turns a zero-length punched PM day into 1 minute, which
ceilings to a full billable hour where the old model billed nothing.

Any converted `pm_entries` row should be reviewed before the show is billed.
