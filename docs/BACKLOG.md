# Backlog

The canonical list of deferred work. Each item carries just enough design that a
future session can build it without re-discovery. Dated when added.

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

## Calendar from shows (2026-08-21, Dan)

"This system drives my calendar" — every booked show already carries the
dates, venue, location and notes that could fill and update his calendar.
- Sketch: a tokenized read-only **ICS feed** (the public-invoice-token
  pattern): `/calendar/{token}.ics` serving every show day as an event —
  title = show name, location = venue + city, all-day (or in/out times once
  punches exist), description = client + rate-card name. Google/Apple
  Calendar subscribe once and auto-refresh. No OAuth or push API needed for
  a first pass.
- Brainstorm openers: which calendar app; what belongs in the event body;
  should travel days render differently; prep/lead-time events?

## Show revenue projection + cash-flow forecast (2026-08-21, Dan)

"I am putting all shows in. This should give me a calculation of what each
show could make and do some cash flow predictions… a valuable tool for my
forecasting."
- **Per-show projection**: before punches exist, scheduled days already imply
  revenue — days x frozen day rate (+ travel legs x travel rate, half days),
  assuming a standard day (no OT). `lib/showBuckets.ts` computes ACTUALS from
  punches; a projection variant assumes st = a full day per scheduled date.
  Surface on the show page pre-punch ("could make ~$X") and in a Forecast
  list of upcoming shows.
- **Cash-flow timeline**: expected invoice date (last show day + a billing-lag
  assumption) + payment timing → expected inflows by week/month. The payment
  timing should be LEARNED per client: invoices carry sent_at and paid dates,
  so each client's real median pay-lag beats assuming Net-30. Outflows: the
  ledger's own history gives trailing-average monthly spend per Bills/
  Expenses category. Anchor at the current working balance → projected cash
  position / runway chart.
- **Runway, not just a timeline** (2026-08-21, Dan): "I know what I need to
  take home each month. The cash flow calc should tell me how far in the
  future my finances will hold me." So: a **monthly take-home need** Dan
  sets, then walk forward month by month — projected inflows minus the
  need minus projected outflows — **carrying surplus forward** (a month
  that earns more than the need funds the next one). The headline figure
  is "covered through <month>", not a chart. A month that comes up short
  after the carry-forward is the first uncovered month.
- **Assumptions to surface (and let Dan tweak)**: monthly take-home need,
  all scheduled days worked, no cancellations, per-client pay lag
  (fallback terms_days), recurring bills at trailing-3-month average.
- Likely home: /money/forecast or a Reports section. Needs the shows +
  ledger + invoice-history joins that all exist today; no new data entry
  beyond the take-home need. **Pay-lag learning depends on `invoices.paid_at`
  — which does not exist until the auto-bridge lands it.**

## Money module — remaining phases

- **Invoice/expense auto-bridge** (phase 3 of the bookkeeping design): paid
  invoices → income transactions; show expenses → ledger expenses; both match
  the bank feed via the existing adopt-on-import machinery. Also auto-feeds
  the Taxes envelope from each show's set-aside. Design in
  `docs/superpowers/specs/2026-08-18-bookkeeping-module-reference.md`.
  **Matcher must handle 1 expense → N bank lines** (2026-08-21, Dan's real
  case: one $40.25 Uber Eats show expense posted at Chase as $33.25 order +
  $7.00 tip — same payee, sum matches within a short date window). The mirror
  case (one bank line covering several expenses) deserves a look too.
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
