# Backlog

The canonical list of deferred work. Each item carries just enough design that a
future session can build it without re-discovery. Dated when added.

## Per-month budgeting with month navigation (2026-08-22, Dan)

Dan: *"I want to be able to budget per month and move between the months. My
plan is to go back to January and set the budgets the same as YNAB to prove
how they work."* This is the real YNAB Rule-1 model and the biggest gap
between `/money/budget` and the tool he actually knows.

- **What exists today:** `ledger_envelopes` + an immutable
  `ledger_envelope_moves` ledger (0030). Allocation is a single running
  total — there is no notion of "August's budget" vs "September's", so
  there is nothing to navigate between and no month-over-month carryover.
- **What YNAB does:** each envelope gets an *amount budgeted this month*;
  a month's leftover rolls into the same envelope next month; overspend
  is handled per category. Available-to-allocate is computed per month
  from income received that month plus last month's leftover.
- **Likely shape:** moves already carry dates, so a per-month view can be
  derived rather than stored — bucket moves by month and show budgeted /
  activity / available per envelope per month, with ‹ › navigation like
  `/calendar`'s. Storing a per-month budgeted figure explicitly may still
  be needed for "budgeted but not yet moved."
- **His proof plan matters for design:** he intends to backfill January
  onward and compare against YNAB's own numbers, so the arithmetic has to
  match YNAB's definitions closely enough to reconcile, and entering a
  past month's budget must be as easy as the current month's.
- Brainstorm openers: does a month's leftover roll forward automatically or
  on a click; how is overspend shown; does the existing immutable-move
  ledger stay the source of truth (it should) or gain a per-month budgeted
  table beside it.

## Show day types — SHIPPED 2026-08-22

Built as `show_days.travel_works` (migration 0036; design:
docs/superpowers/specs/2026-08-22-show-day-types-design.md). An "Also
working" checkbox appears on any day flagged travelled in/out; ticking it
adds a day rate on top of the travel rate in the forecast. Forecast-only —
billing already handled worked travel days correctly, because
`computeShowLines` counts legs outside its punch gate.
Still open from that design:
- Marking day types at show creation (Dan had travel options removed from
  the create screen deliberately; the out-of-state assumption covers
  unmarked shows).
- The 2-day out-of-state fallback still prices as 2 travel + 0 work when
  nothing is marked. Explicit marks now answer it per-show; the fallback
  itself is unchanged.

## Snap-a-receipt button on mobile (2026-08-22, Dan)

Dan: *"I would like a snap receipt button at the top of the mobile view. If
I'm not in a show, there should be a Popup or something that lists all the
shows. After choosing the show, it will go straight to the camera to take a
photo. We will need to work out what happens after."*

- The point is capture speed on a show floor: today a receipt costs several
  taps to reach the right show's expense form.
- Sketch: a persistent control in the mobile header (`AppShell`'s `sm:hidden`
  region). On a show page it targets that show; anywhere else it opens a
  show picker first, then goes straight to the camera.
- Everything downstream already exists: `components/receiptCapture.ts` is the
  ONE capture pipeline (corner detect → flatten → enhance → upload pair) and
  `extractReceipt` can read vendor/amount/date.
- **Open (Dan's own words, "we will need to work out what happens after"):**
  does the photo create the expense immediately with OCR-guessed fields and
  let him fix them later, or land in a pending tray to be completed? What
  happens offline mid-show, and what does the confirmation look like when
  the answer must be readable one-handed in a dark room?

## Calendar: one bar per show, not a chip per day (2026-08-22, Dan)

Dan: *"I would like the calendar to show one big bar for each show instead of
a breakdown per day."*

- `/calendar`'s month grid currently renders one chip per `show_days` row, so
  a 9-day Orlando run reads as nine separate marks instead of one booking.
- Wanted: a single spanning bar per show across its date range.
- The hard part is layout, not data: a bar spanning a week boundary has to
  break across grid rows, and overlapping shows need stacking lanes within a
  cell's height. Flights stay per-day marks.
- Consider whether the ICS feed should follow (one multi-day VEVENT per show
  instead of one all-day event per show day) — currently deliberately
  per-day; changing it changes every subscriber's calendar.

## Flights — display FIXED and lookup LIVE 2026-08-22 (one gap left)

The reported "arrival time does not show" was not a display bug: the flight
had no times stored at all, because `FLIGHT_API_KEY` was not yet set. Both
halves are now resolved — Dan added the key (verified: UA1016 came back
SAN→ORD with both times and both zones), and the display was fixed to show
elapsed time, honest zone labels, and a visible "No times yet" state.
Still open:
- **Hand-entered flights have no way to say which zone the times are in.**
  They are assumed Chicago and stored as Chicago wall time, so a time typed
  meaning Eastern is stored an hour off. The display no longer LIES about it
  (no zone label, no elapsed figure when zones are unknown), but the data is
  still wrong. A zone picker beside the time fields would fix it, and would
  make elapsed time work without a lookup at all. Matters whenever the API
  misses a flight — a charter, a codeshare, a very new schedule.

## W-9 on file + attach-to-invoice checkbox + annual refresh reminder (2026-08-19, Dan)

New clients ask for a W-9. Wanted: upload one to the app; a checkbox on the
send-invoice panel attaches it to that email; rare but ready. Plus a yearly
nudge to upload a fresh one.
- **Storage:** private bucket path `{owner_id}/w9/…pdf` (receipts-bucket RLS
  pattern); settings gains `w9_path` + `w9_uploaded_at` (additive migration).
  A W-9 carries SSN/EIN: owner-only, never on any public link, attached ONLY
  on the explicit checkbox.
- **Send:** `SendInvoicePanel` checkbox (unchecked default) →
  `sendInvoice` adds a second attachment; `lib/invoiceEmail.ts`'s attachments
  array already supports it. Panel hides the checkbox when no W-9 is on file
  (with an upload link to Settings).
- **Settings:** upload/replace control showing "uploaded <date>".
- **Annual reminder:** the existing cron digest
  (`app/api/cron/reminders/route.ts` + `reminder_log` once-per-day dedupe
  pattern) gains a line when `year(w9_uploaded_at) < current year`: "Upload a
  fresh W-9 for <year>."

## MileIQ import: reimbursable miles (2026-08-19, Dan)

Dan already classifies every drive in MileIQ; the "Mileage Reimbursement"
category exists in his chart, and the CPA-export sketch reserves a MileIQ slot.
Wanted: import MileIQ data to track reimbursable miles instead of retyping them.
- MileIQ exports drives as CSV/XLSX (date, start/end location, miles, purpose,
  computed value at the IRS rate). Import path can mirror the YNAB backfill
  pattern: pure parser lib + dry-run-default script or an upload UI.
- Open design questions for the brainstorm: do imported drives attach to SHOWS
  (feeding a mileage invoice line at the IRS rate, like per-diem) or to the
  LEDGER (a Mileage Reimbursement expense row), or both via the auto-bridge?
  How does Dan mark which drives belong to which show — by date match against
  show dates, or manual assignment from an imported queue?
- Rate: use MileIQ's own computed value column rather than hardcoding the IRS
  rate (it changes yearly and MileIQ already applies the right one per drive).

## Calendar from shows — SHIPPED 2026-08-21 (deferred bits below)

Built as /calendar (month grid + flights + public ICS feed, migration 0033;
design: docs/superpowers/specs/2026-08-21-calendar-flights-design.md).
Still open from that design, deliberately deferred:
- Travel-flagged show days rendering differently (grid and feed).
- Punch in/out times inside feed events (all show days are all-day today).
- Show↔flight linkage; personal-vs-work flight separation.
- Live flight delay tracking / airline pushes (lookup is once, at entry).

## Cash-flow forecast — SHIPPED 2026-08-21 (deferred bits below)

Built as /money/forecast (migration 0034; design:
docs/superpowers/specs/2026-08-21-cash-flow-forecast-design.md). Headline
runway over a month table, booked work only.
A per-client pay-lag learner WAS built and then deliberately REMOVED
2026-08-22: the lags it found were an artifact of Dan not being home when
checks arrive, not client behavior, so it was teaching the forecast the
wrong thing. Payment timing is each client's `terms_days` now, always — do
not rebuild the learner (see CLAUDE.md).
Still open from that design, deliberately deferred:
- **Per-show profit on the show page** — `projectedShowCents` in
  lib/forecast.ts makes "this show could make ~$X" a small addition.
- **Scenarios** — "what if I book two more Streamline weeks."
- **Assumed future bookings** of any kind (Dan chose booked-only on purpose;
  revisit only if the honest number proves too pessimistic to use).
- **Seasonality** in the overhead average.
- **Envelope auto-funding** from the projected tax set-aside (still waiting
  on the CPA's rate, same as the bridge's deferred set-aside).

## Money module — remaining phases

- ~~Invoice/expense auto-bridge~~ **BUILT 2026-08-21** (migration 0032;
  design: `docs/superpowers/specs/2026-08-21-invoice-expense-bridge-design.md`).
  Deliberately deferred from that wave, still open here:
  - **Tax set-aside on income** — waits for the CPA's rate AND for per-show
    profit as the base (a deposit is gross, not profit).
  - **Partial payments** — a link means paid in full. The pre-existing,
    still-unused `payments` table (0001) was deliberately left untouched;
    it is the natural home if partial payments ever land (its `paid_cents`
    plumbing in `lib/status.ts` is dead today).
  - **N expenses ← one bank line** (the mirror of the Uber case) — the
    matcher groups bank rows per expense, not expenses per bank row.
- **One chart of accounts, three places** (2026-08-21, Dan: "I would like
  them all to agree"): show-expense categories are four fixed billing
  labels (meals/rides/baggage/other), the ledger uses Dan's YNAB chart, and
  the CPA has a third list. The auto-bridge deliberately does NOT guess a
  ledger category from an expense label. Once the CPA answers homework
  question 1, reconcile all three — then an accepted expense match can
  fill the ledger category too.
- **CPA year-end export**: category totals + income + per-show profit +
  MileIQ/home-office slots + receipts, shaped by the CPA's answers to the
  homework questions (in the reference doc).
- **Income-by-payee report**: Dan's YNAB tracked income per client; payee
  carries that here — a Reports section grouping income by payee.
- **SimpleFIN auto-connect** (optional, privacy-first alternative to Plaid).
- **Mark-as-owner-pay quick control** on imported rows (row-click → edit
  mode covers it today — less discoverable since the register rebuild, which
  strengthens the case for a quick control).
- Category editor: no "new group" control (add categories only within existing
  groups); percent-style targets/goals per envelope; envelope auto-funding
  rules.

## Small / cosmetic

- Calendar feed link moved to Settings (2026-08-22, Dan: "I don't want to
  accidentally hit the refresh button" — he has shared his feed with his
  wife). `/calendar` keeps only Add flight. Considered and not done: an
  arm-then-confirm on Regenerate in place. If the link is ever re-shared
  often enough that the Settings trip grates, a read-only copy control could
  come back to /calendar with Regenerate staying put.

- Forecast vs invoice on a both-legs day (2026-08-22): a day flagged BOTH
  `travel_in` and `travel_out` projects as ONE travel day at one travel rate
  (`lib/forecast.ts`), while `computeShowLines` bills TWO legs for it. The
  forecast is the conservative side, and the case is rare, so it was left
  alone deliberately rather than reconciled. Decide which is right if it ever
  comes up in a real show.

- Bridge accepted trade-offs (2026-08-21 final review): dismissals are a
  one-way door (no UI lists or deletes `ledger_match_dismissals`; dismissing
  a sum also suppresses future singles on the same pair); a bank row whose
  linked expense has a receipt loses its own attach affordance until
  unlinked; an expense link with no show chip is invisible on the register
  when the show-tag write failed (recoverable via edit-mode Unlink) — an
  expense-link chip like the `#N` invoice chip would fix it; `/money`
  runs the matcher on every load for the badge (fine at hundreds of rows,
  revisit at thousands); `ledger_match_dismissals` has no far-side indexes
  (nothing queries them today; 0033 if ever needed).
- `lib/receiptRetention.ts` still derives settlement from the dead
  `payments` table / `updated_at` fallback — `invoices.paid_at` (0032) is
  now the right source; direction is safe (delays reclaim), fix when
  touching retention.

- Register rebuild accepted trade-offs (2026-08-21 review): row-click-to-edit is
  pointer-only (no keyboard path to edit/delete); both layouts mount in the DOM
  at once (duplicate aria-labels, ~400 nodes at the cap); punch 6-across is
  borderline at exactly 640px. Revisit in a register a11y pass.

- Browser-chrome tint (theme-color meta + manifest) stays media-based and does
  not follow the manual Appearance setting (2026-08-21). Accepted: a JS
  meta-updater on toggle is the known fix if it ever grates.

- Mixed hourly+day-rate invoice hours sheet (2026-08-20 review): the page-wide
  DT column trigger isn't scoped to full-sheet shows (a day-rate show's DT can
  add an empty DT column to an hourly show's table), and the ALL SHOWS total
  row sums NET/ST from day-rate shows whose columns don't print. Cosmetic;
  single-show invoices unaffected.

- Recent-moves line field order differs from the original sketch (info
  complete; cosmetic).
- Transfer-kind ledger rows are now uneditable AND undeletable from the
  register UI (2026-08-21 rebuild: delete moved inside edit mode, and edit is
  gated `kind !== 'transfer'`); the server action still permits deletion.
  Fine while nothing writes transfers — revisit when account pairing lands.
- `ledger_reconciliations` is written but never surfaced anywhere (audit trail
  only).

- Forecast per-show breakdown line is ambiguous once a travel day can also be
  worked (2026-08-22, day-types final review): "3 days · 2 travel" can't
  distinguish a fully-accounted 5-day block from one where a worked travel
  day is counted in both the days figure and the travel figure — and unlike
  `travelAssumed`, which gets its own "assumed" tag, the double-counted case
  gets no marker at all. Fixing it needs a block-length field on
  `ShowProjection` (`lib/forecast.ts`) so the line can say "5-day block" and
  let "days" and "travel" both be sub-counts of it. Deliberate follow-up, not
  shipped with day-types.
