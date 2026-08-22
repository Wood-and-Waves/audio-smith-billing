@AGENTS.md

# audio-smith-billing — project conventions & hard-won lessons

Single-owner business app for Dan Smith (Smith Audio, LLC — an S-Corp; his CPA
files the 1120-S). Live at billing.theaudiosmith.com (Vercel, deploys `main`).
Two halves: **billing** (clients → shows → punches/expenses → invoices → email/
PDF/reminders) and **Money** (bookkeeping: ledger register, OFX import,
reconcile, reports, YNAB-style envelopes). Dan is not a developer — explain in
plain terms; he catches stale claims, so verify against git/DB before stating
status.

## Databases & environments (get this right first)

- **Two Supabase projects.** PROD `aiudzhtaflxjloaclpes` (real data). DEV
  sandbox `ddeutgidrqzfsqxnsxub` (`billing-audiosmith-dev`; login
  dev@example.com / sandbox-dev-1234; fake 🧪 SANDBOX data).
- **`.env.local` points at DEV** (plain names: `DATABASE_URL` = transaction
  pooler :6543, `DATABASE_URL_SESSION` = session pooler :5432, plus the three
  Supabase client vars). **`_PROD`-suffixed vars hold production**; only
  explicit `--prod` flags reach it. `.env.local.backup` = original prod copy.
  The deployed app reads Vercel's own env, never `.env.local`.
- **Migrations:** `scripts/sql/migrations/NNNN_*.sql`, applied by
  `npm run db:migrate` (dev) / `npm run db:migrate -- --prod`. Checksummed —
  **never edit an applied file**; fix with the next number. **ADDITIVE ONLY**
  (migration 0015 dropped a column running code still read and took the live
  app down). One-off SQL: `npm run db:sql -- [--prod] file.sql` (prints the
  project ref banner — read it before trusting a run). The session pooler is
  filtered on some of Dan's networks; db:sql (6543) is the fallback, recording
  checksums by hand.
- **SHIP ORDER (non-negotiable):** migrate prod FIRST, then merge/push (Vercel
  deploys). Code referencing a missing column 500s the app.

## Conventions that exist because something broke

- **Money = integer cents** everywhere (`lib/money.ts`; `parseUSD('')` returns
  **0, not null** — every blank-input guard must check `trim()` first; this
  trap has bitten twice).
- **Pure logic lives in `lib/*.ts`**: no `@/` imports, no JSX, no server-only,
  relative `.ts` imports; tested in `scripts/test/*.test.ts` under
  `npm test` (node --test, TZ=Chicago, `--conditions=react-server`). Server
  actions are deliberately untested — extract their brains into pure libs
  instead (`ledgerRules.ts` is the model). node --test **strips types without
  typechecking** — only tsc gates types.
- **Gates run cold:** `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo`
  before `npx tsc --noEmit` — a stale cache once produced a false "clean" on a
  commit that didn't compile.
- **Supabase selects cap at 1000 rows silently.** Anything summing or deduping
  money MUST page (`.range()` loop, stable `created_at,id` order — see
  `fetchAllLedgerTransactions` in `app/money/actions.ts` and the mirrored
  loaders in `app/money/*.tsx`).
- **Fail-direction rule:** flags read from hand-written select strings the
  compiler can't check use `=== false` / `!== false` so a dropped column fails
  toward *visible* old behavior, never silent omission (see
  `lib/expenses.ts`'s comment). Same rule for **guard reads that gate money
  writes**: `const { data } = await …; if (data && data.length > 0) refuse`
  fails OPEN on a query error (data=null reads as "nothing found", the write
  proceeds) — always destructure `error` and return before the presence
  test. The bridge shipped with nine such fail-open guards; the final
  review caught them (2026-08-21).
- **Owner-scoping:** RLS everywhere + explicit `.eq('owner_id', ...)` on
  sensitive reads/writes + `belongsToCaller` FK checks (Postgres FK checks
  bypass RLS). Security-definer functions for public reads (`public_invoice`,
  `public_invoice_backup`) select explicit columns; **`ach_details` never
  joins any select that can reach a client**, and `settings` reads use
  explicit column lists, never `*`.
- **Client-facing chokepoints** (a my-cost/non-reimbursable expense or any
  Money data must NEVER reach a client): invoice lines via `expenseLines`,
  the frozen `invoices.backup_snapshot` via `buildBackupSnapshot`, the
  receipts gate via `expensesMissingReceipts` — all filter internally so every
  caller stays in lockstep. Public surfaces: `/i/[token]` page + pdf route,
  emails. `/money*` is Dan-only and not in `proxy.ts` PUBLIC_PREFIXES.
- **Vercel "sensitive" env vars pull as the literal `<ENCRYPTED>`** — a
  `vercel env pull` can never prove or disprove a credential's value. Verify
  by making the system DO the thing (a real upload, a cron run); a morning
  was lost diagnosing "placeholders" that were real values (2026-08-21).
- **Browser-only shared code lives in `components/`** (`receiptCapture.ts` —
  the ONE capture pipeline both ExpenseLog and MoneyRegister consume;
  `ReceiptLightbox.tsx` likewise): it needs canvas/DOM/Storage that
  `node --test` can't run. The pure math stays in `lib/receipt*.ts`. Never
  re-inline the pipeline into a screen component.
- **Native date/time inputs are flattened globally** (`globals.css`
  `input[type=date|time] { appearance: none }`): iOS drew them taller than
  every other field. Never re-style them per component.
- **The light palette lives TWICE in globals.css** (media-query block +
  `[data-theme='light']` block) and the two must stay byte-identical — loud
  comments mark both. `app/layout.tsx` holds the app's ONLY inline script
  (pre-paint theme read), safe only because next.config deliberately ships
  no script-src CSP — adding one breaks theming.
- **UI copy:** minimal — Dan: "There are too many instructions. I understand
  what is happening." Use his vocabulary ("Non-reimbursable", not invented
  terms; category names come from his YNAB chart). List-row idiom:
  `border-b border-line py-4 pl-3 -ml-3 pr-3`; eyebrow headers; FIELD_FULL;
  `components/ui/Select`; useTransition + router.refresh + `{error}`.

## Money module map (migrations 0027–0034)

- Tables: `ledger_accounts` (one business checking), `ledger_categories`
  (Dan's YNAB chart; `deductible` drives the reports figure — "Taxes" seeds
  non-deductible on purpose), `ledger_transactions` (signed cents; kind
  income|expense|owner_pay|transfer with DB sign/category checks; cleared
  uncleared|cleared|reconciled; unique partial `(owner,account,import_id)`),
  `ledger_reconciliations`, `ledger_envelopes` + immutable
  `ledger_envelope_moves` (corrections = counter-moves). 0031 adds
  `receipt_path`/`receipt_original` to ledger_transactions — receipts attach
  to bank rows via the shared capture pipeline; storage paths are
  `{owner_id}/ledger/{stamp}-…` (folder[2]='ledger' can't collide with show
  uuids; every ledger-receipt action prefix-checks `${user.id}/ledger/`).
- **Import semantics:** OFX parse (`lib/ofx.ts`) → `planImport`
  (`lib/ledgerImport.ts`): duplicate by import_id (GEN ids use
  occurrence-position classification + maxN-anchored numbering — re-import is
  a no-op) | adopt a manual twin (same amount ±10 days; source='manual',
  import_id null; adoption preserves 'reconciled') | insert. **Backfilled rows
  are deliberately manual/null-import_id so future OFX adopts them.** Payee
  memory is kind-aware (`memoryKey(kind, payee)`).
- **Reconcile** is date-scoped (rows ≤ statement date) and atomic via the
  `reconcile_ledger_account` RPC (0029); its adjustment stays merely 'cleared'
  so mistakes remain correctable; reconciled rows are locked server-side
  except THREE carve-outs, all audit metadata that moves no money:
  categorization (`setTransactionCategory`), receipts (attach/replace/
  remove), and bridge links (accept/unlink — by design, since a month is
  usually reconciled before its deposits meet their invoices).
- **The bridge (0032)**: `invoices.paid_at` + link tables
  `ledger_transaction_invoices` / `ledger_transaction_expenses` (N↔N by
  design: Streamline pays two invoices with one check; one Uber Eats expense
  posts as order + tip) + `ledger_match_dismissals` (suppression list — the
  matcher is stateless). `lib/ledgerMatch.ts` PROPOSES only; accept/dismiss/
  unlink actions in `app/money/actions.ts` re-verify everything server-side.
  `paid_at` is written ONLY by deposit-accept (the bank row's date) and Mark
  Paid (today, corrected by a later accept); unlink restores 'sent'. A linked
  expense's receipt surfaces on the bank row via DISPLAY-TIME JOIN — never
  copy receipt paths onto ledger rows (removeLedgerReceipt deletes storage
  objects; a copied path would delete the expense's file). Unlink dissolves
  expense groups whole. Link data never reaches any client-facing surface.
  Matching goes by EXACT amount + date sanity ONLY; payee similarity ranks
  confidence and badges cards but never creates a match; same-amount ties
  surface EVERY combination at low confidence (the matcher never guesses —
  accepting the right pair collapses the wrong cards). Paid invoices age
  out of the candidate pool 45 days after `paid_at` (null = never a
  candidate — keeps the 94 imported historical invoices out; unpaid 'sent'
  never ages out). Dismissals are reversible (Dismissed section + Restore
  on /money/matches); `paid_at` is a Postgres `date` on purpose — a
  timestamptz would NaN the matcher's daysApart and silently exclude every
  paid candidate.
- **The forecast (0034)**: `/money/forecast` answers "covered through
  <month>". `lib/forecast.ts` holds ALL the math and **writes nothing** —
  derived every render, no ledger rows, no envelope moves. It counts BOOKED
  WORK ONLY (never assumes future bookings) and pairs the runway with the
  month booked work runs out, so a short number reads as a thin calendar.
  Projection is its own arithmetic, NOT `computeShowLines` — that earns the
  day rate from punched straight time, so a booked show projects $0 through
  it; every `show_days` row is a work day (0005), travel flags add legs, no
  OT/penalties assumed. Pay lags are learned per client ONLY from
  deposit-LINKED invoices sent within 365 days, min 2 samples, else
  `terms_days` — the window exists because Dan's four ancient Journey
  settlements (393–752 days) would otherwise model a two-year payer.
  Overhead = trailing 3 COMPLETE months of expense-kind spend, averaged over
  months that actually have ledger history. Tax uses `tax_setaside_bp` on
  projected PROFIT and is labeled an estimate — **nothing in this app is
  tax advice**. Anchor is working balance − net allocated (envelope money is
  spoken for). A show billed to a VOIDED invoice stays 'billed' upstream, so
  the page maps it back to open or it would vanish from the forecast.
- **Register order and balances**: `lib/ledgerBalance.ts` is the single
  source — `compareLedgerOrder` (date asc, created_at asc, id asc; display =
  exact reverse) and `runningBalances` (pinned invariant: top rendered row's
  balance === working balance). Balances are computed over the FULL paged
  set, never the RENDER_CAP 200 slice — do not "optimize" that.
- Envelopes: Available-to-allocate = working balance − net allocated; hidden
  envelopes must stay reachable (the "Hidden (N)" disclosure); hide requires a
  zero balance, server-enforced.

## Process that has worked

- Superpowers flow: brainstorm → spec (`docs/superpowers/specs/`) → plan
  (`docs/superpowers/plans/`, exact code for cheap-model tasks) →
  subagent-driven dev with **model tiering (Dan's directive)**: cheapest for
  verbatim transcription (controller verifies byte-fidelity), mid-tier for
  logic/UI/task-reviews, the top model ONLY for whole-branch final reviews of
  money code — where it has repeatedly earned it (caught: silent GEN
  double-import, the 1000-row truncation, deposit-net revenue, import
  un-reconciling locked rows, cross-kind payee memory, unrecoverable hidden
  envelopes).
- Durable progress ledger: `.superpowers/sdd/progress.md` (gitignored) — the
  recovery map after compaction; trust it + `git log` over recollection.
- Reviews of money code are adversarial and worth it. Fix waves are ONE
  subagent with the complete findings list; tiny fixes are controller-direct.

## Current state (2026-08-21) & where things are written

- LIVE in prod: billing + full Money module + envelopes; receipt corner
  detection/flattening (CornerAdjuster + loupe; PDFs skip corners); attach/
  replace receipts on expenses AND on ledger rows; original PDF receipts ride
  the invoice as full-fidelity appendices (`lib/mergePdfAppendices.ts`,
  pdf-lib); day-rate shows get a times-not-math hours sheet; every client
  email BCCs Dan (`OWNER_BCC`) and files its exact PDF to Dropbox
  (`/receipts/{year}/{show}/`); send panel shows attachment contents + View
  PDF; never-sent drafts delete (and unbill) with number giveback; the
  register is a YNAB-style spreadsheet (running balance, outflow/inflow,
  receipt + cleared columns) with date-grouped phone view, a wide canvas
  (AppShell's `wide` prop — register only), and drag-resizable columns
  (grips at every boundary move ONLY that boundary; widths persist per
  device in localStorage 'registerCols'); per-device System/Light/Dark in
  Settings; punch tiles 6-across from sm:; the invoice/expense auto-bridge
  (0032: /money/matches review queue — nothing applies without a click;
  register shows #invoice chips + linked-expense receipts + Unlink; invoice
  page shows Paid date + its deposit; Matches count badge on /money; cards
  carry sent dates + a "Payee matches" badge, agreeing twin sorts first);
  the /calendar month grid + flights + public ICS feed (0033: `flights`
  table — schedule entries, no show link, only number+date required;
  `settings.calendar_token` uuid; feed at /cal/{token}.ics reads through
  the security-definer `public_calendar_feed` RPC like /i does — NEVER
  service-role, and it carries SCHEDULE FACTS ONLY (it joins the
  client-facing chokepoint list); '/cal' is a PUBLIC_PREFIX, the /calendar
  page is not; flight lookup = AeroDataBox via RapidAPI (`FLIGHT_API_KEY`,
  server-only; parser in lib/flightLookup.ts, canned-fixture tested;
  everything but lookup works keyless); month-grid helpers live in
  lib/dates.ts under its UTC-pinning doctrine; nav is SIX items).
- **The ledger is Dan's live books**: YNAB Register backfilled to prod
  2026-08-20 — 328 txns in "Chase Checking" (opening $585.75 @ 2026-01-01,
  ending verified against the bank). Monthly OFX imports adopt the manual
  rows. Bridge links re-run by Dan 2026-08-21 after a full reset (his first
  pass hit the same-amount-tie blind spot): 11 deposit→invoice links + 2
  expense links live, all bank-dated and audit-verified; 11 dismissals on
  file. Hand-marked paids from that cleanup carry paid_at = that day, NOT
  a real payment date — the forecast must learn pay-lag only from
  deposit-LINKED invoices (pinned in BACKLOG). Dropbox archive LIVE (nightly cron; helper: `npm run dropbox:auth`,
  with `--push` to Vercel and `--probe` diagnostics; secrets never printed).
- **Backlog:** `docs/BACKLOG.md` (canonical). Module design reference:
  `docs/superpowers/specs/2026-08-18-bookkeeping-module-reference.md` (incl.
  Dan's CPA homework questions). Next big pieces: CPA year-end export
  (awaits the CPA's answers — which also unblock reconciling the three
  charts of accounts), income-by-payee report, per-show profit on the show
  page, W-9, MileIQ, SimpleFIN.
