# Backlog

The canonical list of deferred work. Each item carries just enough design that a
future session can build it without re-discovery. Dated when added.

## Receipt photo: corner-finding + flattening (2026-08-19, Dan)

The batch/single receipt capture already downscales, grayscales and
contrast-stretches in the browser (`lib/receiptImage.ts` math +
`components/ExpenseLog.tsx`'s `enhance()` canvas wiring). Missing: detect the
receipt's four corners in the photo and perspective-flatten it, so an
angled-on-the-diner-table shot becomes a straight document.
- Lives in the same browser pipeline (photos are 3–5MB; server round-trips are
  out, same reason as the existing enhancement).
- Approach to evaluate at build time: hand-rolled edge-scan + largest-quad
  heuristic + a small homography/perspective remap on ImageData (pure,
  testable math in `lib/receiptImage.ts`), vs. pulling in OpenCV.js/jscanify
  (heavy — the pdf.js lazy-load precedent shows how to isolate it if chosen).
- Must degrade gracefully: corners not found → current behavior, never a
  mangled crop. OCR quality is the payoff to measure.

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

## Money module — remaining phases

- **Invoice/expense auto-bridge** (phase 3 of the bookkeeping design): paid
  invoices → income transactions; show expenses → ledger expenses; both match
  the bank feed via the existing adopt-on-import machinery. Also auto-feeds
  the Taxes envelope from each show's set-aside. Design in
  `docs/superpowers/specs/2026-08-18-bookkeeping-module-reference.md`.
- **CPA year-end export**: category totals + income + per-show profit +
  MileIQ/home-office slots + receipts, shaped by the CPA's answers to the
  homework questions (in the reference doc).
- **Income-by-payee report**: Dan's YNAB tracked income per client; payee
  carries that here — a Reports section grouping income by payee.
- **SimpleFIN auto-connect** (optional, privacy-first alternative to Plaid).
- **Mark-as-owner-pay quick control** on imported rows (Edit covers it today).
- Category editor: no "new group" control (add categories only within existing
  groups); percent-style targets/goals per envelope; envelope auto-funding
  rules.

## Small / cosmetic

- Recent-moves line field order differs from the original sketch (info
  complete; cosmetic).
- Delete remains available on transfer-kind ledger rows (legitimate but
  unguarded by any special copy).
- `ledger_reconciliations` is written but never surfaced anywhere (audit trail
  only).
