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

## Money module map (migrations 0027–0035)

- Tables: `ledger_accounts` (one business checking), `ledger_categories`
  (Dan's YNAB chart; `deductible` drives the reports figure — "Taxes" seeds
  non-deductible on purpose), `ledger_transactions` (signed cents; kind
  income|expense|owner_pay|transfer with DB sign/category checks; cleared
  uncleared|cleared|reconciled; unique partial `(owner,account,import_id)`),
  `ledger_reconciliations`, `ledger_envelopes` + immutable
  `ledger_envelope_moves` (0030 — shipped EMPTY, superseded by the budget
  below; left in place, unused, because ADDITIVE ONLY). 0031 adds
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
- **The forecast (0034, refined 0035)**: `/money/forecast` answers "covered
  through <month>". `lib/forecast.ts` holds ALL the math and **writes
  nothing** — derived every render. It counts BOOKED WORK ONLY (never assumes
  future bookings) and pairs the runway with the month booked work runs out.
  Projection is its own arithmetic, NOT `computeShowLines` — that earns the
  day rate from punched straight time, so a booked show projects $0 through
  it. Travel days are part of the scheduled block, never added on top of it
  (Dan: "for a 6 day show, 2 travel days and 4 working days. That is the most
  conservative."). A day flagged travel_in/out (either or both) IS a travel
  day, and counts ONCE at ONE travel rate even when both legs are flagged;
  with nothing flagged, an out-of-state show (location names a state other
  than `settings.home_state`) that runs >1 day is assumed to need its FIRST
  and LAST scheduled day as travel — flagged days always win over the
  assumption. Every remaining day is a work day at the show's own rate (half
  days halved). A 2-day out-of-state show with nothing flagged is therefore 2
  travel days and ZERO work days — deliberate, not special-cased.
  **`show_days.travel_works` (0036)** is the one way a day is both: on a
  FLAGGED travel day it adds a day rate on top of the travel rate (half if
  `pay_as_half_day`), so `dayCount + travelDays` exceeds the block by the
  number of worked travel days. It is ignored on a day with no travel flags,
  and never applies to an ASSUMED travel day (the assumption fires only when
  nothing was marked, so nothing is known about working it). Forecast-only —
  billing already gets worked travel days right, because `computeShowLines`
  counts legs outside its punch gate. Clearing a day's last travel flag
  clears `travel_works` with it. **PM** is a
  flat 4h at the show's PM rate when `shows.pm_role` is set (forecast-only;
  real PM still bills from `pm_entries`). No OT/DT/meal penalties/expenses
  are assumed — every omission understates EXCEPT an hourly show, the one
  place it can overstate.
  **Payment timing is each client's `terms_days`** (Net 30 today). A learned
  per-client pay lag was built and then DELIBERATELY REMOVED 2026-08-22 —
  Dan's lags come from him not being home when checks arrive, not from client
  behaviour, so learning them taught the wrong thing. Do not rebuild it.
  Overhead = trailing 3 COMPLETE months of expense-kind spend, averaged over
  months that actually have ledger history; the current month pro-rates its
  overhead and draw because month-0 income is only what's left to land. Tax
  uses `tax_setaside_bp` on projected PROFIT and is labeled an estimate —
  **nothing in this app is tax advice**. Anchor is working balance − net
  allocated. A show billed to a VOIDED invoice stays 'billed' upstream, so
  the page maps it back to open or it would vanish.
- **Register order and balances**: `lib/ledgerBalance.ts` is the single
  source — `compareLedgerOrder` (date asc, created_at asc, id asc; display =
  exact reverse) and `runningBalances` (pinned invariant: top rendered row's
  balance === working balance). Balances are computed over the FULL paged
  set, and the register renders every row — the old RENDER_CAP was deleted
  (2026-08-23) precisely because a display cap that looks like completeness
  is the failure mode this module exists to prevent. Do not reintroduce one.
- Envelopes (0030): dead. Three rows, zero moves, ever — an envelope
  transactions never point at can show a balance but never an activity. The
  budget below puts the budget ON the categories transactions already carry.
- **The budget (0038-0041, `/money/budget`).** YNAB's month grid, and the two
  formulas below were validated against 1,421 rows of Dan's own YNAB export
  BEFORE any code existed — 0 mismatches — so they are settled by evidence,
  not taste. Do not re-derive them:
  - `available(c,m) = max(0, available(c,m-1)) + assigned(c,m) + activity(c,m)`
  - `rta(m) = rta(m-1) + income(m) − Σ assigned(c,m) + Σ min(0, available(c,m-1))`
  The `max(0, …)` is the whole trick: a positive balance rolls forward, cash
  overspending does NOT — it hits the next month's Ready to Assign and the
  category restarts at zero. Letting negatives roll forward gives 23 mismatches
  against that same export.
  - `income(m)` is every transaction that does NOT land in a spending category
    — income-role categories plus uncategorised rows, any kind. Money without a
    job sits in Ready to Assign until it gets one.
  - `activity(c,m)` is a SIGNED sum over all transactions carrying `c`,
    regardless of kind, so refunds net down with no special case.
  - An assignment is an immutable move in `ledger_budget_moves` (null on either
    side = Ready to Assign); `assigned` is the sum of moves, never a stored
    column. Undo marks `undone_at`; it never deletes.
  - **`hidden` is presentation, never accounting.** Every spending category
    participates in every total; the TABLE decides what to draw. Putting
    `&& !c.hidden` back into `spendingIds` reintroduces a bug where a hidden
    category's spending counted as income and hiding one retroactively rewrote
    every past month's Ready to Assign.
  - `budget_role` says which categories are budget rows. It is an explicit
    column, never inferred from the group name, which is user-editable text.
  - Filters hide rows only. Group totals and the summary panel ALWAYS describe
    the whole month — a total ranging over a filtered subset would make the
    reconciliation against YNAB lie, which defeats the screen's whole purpose.
  - 0038 replaced `lt_nocat_for_owner_or_transfer` with `lt_nocat_for_transfer`:
    owner pay is a real budget category (Dan's largest line) and carries
    `deductible = false`, so the CPA export is unchanged. Transfers still may
    not carry a category.
  - Targets (`ledger_category_targets`) are monthly or by-date only, and have
    NO history — YNAB does not export targets, so Dan enters them by hand and a
    past month is judged against today's target. Assigned/Activity/Available
    stay exact; only the status wording on closed months can read oddly.
  - **Phase two SHIPPED 2026-08-24**: hand writes are immutable moves into `ledger_budget_moves`, undo marks `undone_at`, the import now requires `--replace` when moves exist.

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

## Register editing (Wave B, SHIPPED 2026-08-24) — rules that must not drift

- **Kind is DERIVED, not picked** — `deriveKind(category, direction)` in
  `lib/ledgerRules.ts`. The dropdown is gone. `owner_pay` keys on the ONE
  category (`OWNER_PAY_CATEGORY_NAME`), **never the group** — the Owner
  Transactions group holds five categories and only one is owner pay; the
  group-keyed version silently unbooked Charitable Giving from the P&L's
  expense side (final-review catch). Renaming that one category is the
  failure mode (loud in the P&L); the escape hatch is an explicit column.
- `setTransactionCategory` re-derives kind server-side through the SAME
  deriveKind — the inline picker and the edit form can never disagree, and
  no path can mint a row the edit form refuses to save.
- Transfers: the picker's pinned **Payment/Transfer** row (category null,
  kind transfer) — the form's only transfer path; the sweep never offers it.
- **`parseUSDMath`** (`lib/moneyMath.ts`) is the amount-field entry point
  (register, AssignedCell, MovePopover, TargetEditor): expressions with
  one rounding at the end, delegation to `parseUSD` for lone values —
  lone `(5.75)` is accounting-negative, `(5.75)+1` is grouping. Total by
  construction (length guard + catch); do not reimplement number parsing.
- `CategoryPicker` shows each category's current-month budget Available —
  computed by the SAME `buildBudget` assembly the budget page uses
  (`app/money/page.tsx` mirrors it, opening-balance injection included).
  If the two ever disagree, one of the assemblies drifted: fix that, never
  the display.
- **`npm run parity`** = live YNAB (API, budget id pinned) vs the app's own
  arithmetic. First hit ZERO 2026-08-24 (25/25 categories; RTA off by
  exactly the known $1.01 Novo remainder). This is September's arbiter.

## Splits & pending (Wave C) — rules that must not drift

- **A split is legs under ONE bank row** (`ledger_transaction_splits`): the
  parent keeps date/payee/amount/cleared/import identity; legs carry
  category + amount + their OWN kind (per-leg `deriveKind` — the $400 case
  is one owner_pay leg + one expense leg). Postgres enforces the whole
  contract: a deferred trigger (≥2 legs, signs match the parent, sum exact),
  an ownership trigger (leg's owner = txn's owner, category's owner too),
  and an amount-edit refusal while legs exist. Leg replacement is the
  `replace_transaction_splits` RPC — atomic, ownership-checked inside.
- **One explosion helper** (`lib/ledgerSplits.ts`): category-reading
  consumers call `explodeForCategories` (budget) or `explodeForReports`
  (kind-aware — P&L); balance-reading consumers NEVER explode and NEVER
  filter pending. A THIRD kind exists and must be named when adding one:
  LINK-shaped readers (the invoice matcher, bridge links) match on
  amount/date/payee — the matcher excludes pending rows (an unaccepted
  import cannot pay an invoice) and never needs legs. Adding a consumer?
  Decide which of the three it is, in a comment, before the query.
- **Pending = `entered_at IS NULL`** — only the OFX importer inserts it;
  the column defaults to now() so a forgotten path is safe-by-construction
  (0044's lesson: reconcile's adjustment predated the column). Pending
  counts in working AND cleared balances (Dan's chosen semantics), and in
  nothing category-shaped. Reject = tombstone FIRST
  (`ledger_import_rejections`, consulted by the import's dedupe), delete
  second. Reconcile refuses while pending rows sit at or before the
  statement date.
- Split parents refuse category and amount edits everywhere
  (`This is a split — edit its legs.`); payee memory skips them entirely;
  the Pending section's queue is its OWN unfiltered prop — the page's
  display filter must never narrow it. Reconciled rows refuse splits
  server-side (no carve-out yet — a deliberate open decision, BACKLOG);
  the 3/5 $400 hand-split was deliberately collapsed on 2026-08-25 at
  Dan's request: merged to the bank's one −$2,912.60 line, then split
  Owner Investment $2,512.60 / Temporary Transfer $400.00 to mirror
  YNAB's own split row (the old warning was against splitting WITHOUT
  merging — that double-counts $400; merge-then-split is the sanctioned
  path, parity re-run after).

## Current state (2026-08-24) & where things are written

- LIVE in prod: billing + full Money module; receipt corner
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
  server-only, LIVE on prod since 2026-08-22; parser in lib/flightLookup.ts,
  canned-fixture tested; everything but lookup works keyless); month-grid
  helpers live in lib/dates.ts under its UTC-pinning doctrine; nav is SIX
  items). **The feed link lives in SETTINGS, not /calendar** (moved
  2026-08-22): Regenerate IS revocation with no undo, and Dan has shared his
  feed with his wife, so an accidental click on a daily page would break her
  subscription too. Flight times render in EACH airport's own zone, never
  converted (the boarding-pass convention), with `elapsedLabel` reconciling
  them — the zone LABEL prints only when the zone is known, because
  hand-typed times carry none and were stored as Chicago wall time.
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
  Dan's CPA homework questions). Of the pieces Dan filed 2026-08-22:
  **per-month budgeting** — phase one SHIPPED (see the budget notes above);
  phase two (assigning by hand, moving money between categories, undo/redo,
  Recent Moves) is a separate plan. **show day types** (travel-only vs travel+work, replacing the forecast's
  first/last-day assumption and superseding the deferred 2-day out-of-state
  case); **snap-a-receipt on mobile** (header button → show picker →
  straight to camera; the post-capture flow is explicitly unresolved);
  **calendar one bar per show** instead of a chip per day; **flight arrival
  time not displaying** (verify the dialog before assuming data loss —
  `arr_at`/`arr_tz` are stored) plus rendering each end in its own zone.
  Then: CPA year-end export (awaits the CPA's answers — which also unblock
  reconciling the three charts of accounts), income-by-payee report,
  per-show profit on the show page, W-9, MileIQ, SimpleFIN.
