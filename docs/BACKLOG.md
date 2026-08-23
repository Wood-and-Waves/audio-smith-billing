# Backlog

The canonical list of deferred work. Each item carries just enough design that a
future session can build it without re-discovery. Dated when added.

## Per-month budgeting — PHASE ONE SHIPPED 2026-08-23

Dan's ask: *"I want to be able to budget per month and move between the months.
My plan is to go back to January and set the budgets the same as YNAB to prove
how they work."*

Built as `/money/budget` (design:
`docs/superpowers/specs/2026-08-22-ynab-budget-design.md`; plan:
`docs/superpowers/plans/2026-08-22-ynab-budget-phase-one.md`; migrations
0038-0040). The category list converged on his real YNAB 2026 chart, the
arithmetic lives in `lib/budget.ts` and reproduces all 1,421 rows of his export
with zero mismatches, and `scripts/import/ynab-plan.mjs` backfilled Jan-Aug.
See CLAUDE.md for the two formulas and the rules that must not be re-derived.

**Phase two — assigning and moving money.** Deliberately split out so the
numbers could be proved before any path existed that changes one:
- Typing a figure into the Assigned box (writes the difference as a move).
- Moving money between categories to cover an overspent one — one row, not two
  edits. The tables and the arithmetic already support it.
- Undo/Redo via `ledger_budget_moves.undone_at`, which the schema already has
  and `lib/budget.ts` already honours.
- Recent Moves — the move table read back.

**Also deferred, with reasons:**
- **Auto-assign.** Dan uses it in YNAB but did not pick it for phase one.
  `underfundedCents` is already computed per month, so the number the button
  needs exists; only the write path is missing.
- **Target history.** YNAB does not export targets and this stores only their
  current state, so a past month is judged against today's target. Assigned,
  Activity and Available stay exact — only the status wording on closed months
  can read oddly. Versioning targets by month is real work for a cosmetic gain.
- **Split transactions.** Exactly one occurred in all of 2026 (a 3/5 transfer
  YNAB split two ways).
- **Credit-card handling.** No card in the books; YNAB's hardest feature is out
  of scope by circumstance.
- **A second budget account.** `fetchAllBudgetTxns` filters to the one open
  account, matching every sibling `/money/*` page. The moment a second open
  account exists the budget understates itself with nothing on screen to say
  so — the source comment says as much.
- **`components/BudgetPanel.tsx` and the 0030 envelope tables** are now dead:
  the panel has no caller and the tables shipped empty and stayed empty. Left
  in place (ADDITIVE ONLY); retire deliberately, not incidentally.
- **`ensureDefaultEnvelopes`** in `app/money/actions.ts` lost its only caller
  when the budget page was rewritten.
- **`app/money/forecast/page.tsx`** still computes "available to allocate" from
  the empty envelope moves. Harmless — the answer equals the working balance —
  but it is a stale concept now.
- **`scripts/import/ynab-backfill.mjs`'s header** claims its CSV mechanics live
  in `lib/ynabRegister.ts`; nothing outside that module's own test imports it.
- **Import-script hardening:** `--start` accepts a shape-valid but impossible
  month like `2026-13`; `--file` silently overwrites an earlier path; and the
  "idempotent by deletion" claim in its header only holds for a re-run with the
  same `--start`.
- **A move's `owner_id` is not tied to the owner of its categories** — exact
  parity with 0030's `ledger_envelope_moves`, so not a regression, but the same
  gap the target actions now close by walking the category's own FK.

**Dan's ledger punch list** (independent of the code; doing these makes the two
books agree to the penny — every one was confirmed against the underlying rows):
1. Import the **$592.10** Fairmont Hotel Chicago charge (8/20).
2. Add the missing **$35.00** Insurance refund.
3. Add the missing **$112.51** of Audio Tools refunds.
4. **The $400 round trip — accept it as a known variance for now.** YNAB splits
   the 3/5 owner-pay row two ways, $400 of it to "Temporary Transfer"; the app
   records it whole. Its counterpart is already in the ledger: a **+$400.00**
   inflow on 3/2 from Smith Checking, sitting as an uncategorised `transfer`.
   **This one cannot be fixed in the app as it stands** — there is no split UI
   (deliberately out of scope, one split in all of 2026), there is no "Temporary
   Transfer" category in the converged chart, and `lt_nocat_for_transfer` still
   forbids a category on a transfer row. So Owner Pay will read $400 heavier
   than YNAB for March, and the inflow sits in Ready to Assign. Both are
   explainable and neither is a defect; closing the gap needs either split
   support or a decision to record the round trip differently.
5. Categorise the three **$15.00 Monthly Service Fee** rows (1/30, 2/27, 3/31)
   to **Retained Earnings**, which is where YNAB books them.

**And his 17 targets need entering by hand** — YNAB has no target export.

**Two things the design doc specifies that phase one did not build**, recorded
here so they are deferred rather than forgotten:
- **The wide canvas.** The spec puts the budget "on the wide canvas the register
  already uses"; the page uses the default `AppShell` width (`max-w-5xl`). Not a
  regression — the pre-rewrite page was the same — but it is why the category
  column is only ~224px once the summary panel takes its track, which is what
  forced the name/status truncation trade in `BudgetRow`. Widening the canvas
  would relieve that directly.
- **Collapsible groups.** The spec says "Groups collapse and carry roll-up
  totals." The roll-ups are built; the collapsing is not.

**Also open:** a transaction backdated into 2025 is silently dropped from the
budget (the page reads `date >= 2026-01-01`) while still counting in the
register's working balance, with nothing on screen reconciling the gap. And
`saveEnvelope`/`moveEnvelopeMoney` in `app/money/actions.ts` lost their only
caller when `BudgetPanel.tsx` was deleted — dead, but left in place because the
0030 envelope machinery was fenced off during this wave.

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

## Snap-a-receipt — SHIPPED 2026-08-22

Camera button in the mobile header (`components/SnapReceipt.tsx`); the show
is inferred (show page → today's show → picker) and always named on the
confirm screen with a Change control; the existing capture pipeline and OCR
run unchanged; nothing is written until Add. Design:
docs/superpowers/specs/2026-08-22-snap-receipt-design.md.
Worth knowing for anyone touching it:
- **The camera must open from live user activation.** iOS Safari refuses a
  programmatic `.click()` on a file input once the originating gesture has
  expired, so nothing may `await` between the tap and the open. That is why
  AppShell fetches shows on every render (bounded to OPEN shows) instead of
  lazily, and why "Add + another" shows a `saved` screen with a Take another
  button rather than reopening the camera itself.
Still open:
- No offline queue and no pending tray, deliberately — both create a place
  receipts pile up unseen. Revisit only if a real show floor proves the
  online path unreliable.
- The in-form picker in ExpenseLog stays for batches and emailed PDFs.

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
