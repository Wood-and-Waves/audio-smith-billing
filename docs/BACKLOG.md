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
runway over a month table, booked work only, learned per-client pay lags.
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
