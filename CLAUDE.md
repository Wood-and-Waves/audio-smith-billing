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
  `lib/expenses.ts`'s comment).
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

## Money module map (migrations 0027–0031)

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
  except TWO carve-outs, both audit metadata that moves no money:
  categorization (`setTransactionCategory`) and receipts (attach/replace/
  remove all work on reconciled rows by design).
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
  receipt + cleared columns) with date-grouped phone view; per-device
  System/Light/Dark in Settings; punch tiles 6-across from sm:.
- **The ledger is Dan's live books**: YNAB Register backfilled to prod
  2026-08-20 — 328 txns in "Chase Checking" (opening $585.75 @ 2026-01-01,
  ending verified against the bank). Monthly OFX imports adopt the manual
  rows. Dropbox archive LIVE (nightly cron; helper: `npm run dropbox:auth`,
  with `--push` to Vercel and `--probe` diagnostics; secrets never printed).
- **Backlog:** `docs/BACKLOG.md` (canonical). Module design reference:
  `docs/superpowers/specs/2026-08-18-bookkeeping-module-reference.md` (incl.
  Dan's CPA homework questions). Next big pieces: invoice/expense
  auto-bridge (matcher must handle 1 expense → N bank lines), CPA year-end
  export, income-by-payee report, W-9, MileIQ, calendar feed from shows.
