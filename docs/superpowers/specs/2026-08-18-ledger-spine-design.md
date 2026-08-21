> **Postscript (2026-08-19):** SHIPPED to production (migrations 0027–0031 —
> envelopes/0030 arrived in a later wave). Two things below are superseded:
> the DEFAULT_CATEGORIES list (the seed is now Dan's own YNAB chart — see
> lib/ledgerCategories.ts) and the GEN import-id description (re-import is now
> a no-op via occurrence-position classification; see lib/ledgerImport.ts).
> **Postscript 2 (2026-08-21):** the register UI described below is
> superseded — rebuilt as a YNAB-style grid (balance column, equation
> header, phone date groups; delete moved inside edit mode; transfer rows
> uneditable). See docs/superpowers/plans/2026-08-21-register.md.

# Money — the ledger spine (bookkeeping phase 1) — design

## Problem

The bookkeeping module (reference: `2026-08-18-bookkeeping-module-reference.md`)
needs its spine: a ledger for Dan's **one business checking account** where every
transaction gets a tax category and an optional show tag. Today that money lives
only in his bank's website; deductions get reconstructed at tax time.

## Goal (phase 1 only)

A new **Money** section: create the checking account, enter transactions
manually, import the bank's **OFX/QFX** downloads with YNAB-grade dedupe,
categorize into an **editable default S-Corp chart**, tag transactions to shows,
and **reconcile** against the real bank balance. Dashboard/exports (phase 2) and
the invoice/expense auto-bridge (phase 3) come later. **Built and used against
the dev sandbox first**; prod ships at an explicit gate.

## Schema — migration 0027 (additive; RLS per repo pattern: owner_all policy,
revoke anon, explicit grants to authenticated, all to service_role)

- **ledger_accounts** — id, owner_id, `name`, `type` check in
  (`checking|savings|credit_card|cash`) default checking, `opening_balance_cents
  bigint not null default 0`, `opening_date date not null`, `closed bool default
  false`, `last_reconciled_at timestamptz`, timestamps. (One checking account in
  practice; the type enum leaves room.)
- **ledger_categories** — id, owner_id, `name`, `grp` (group heading), `sort
  int`, `hidden bool default false`, `deductible bool not null default true`,
  `is_equipment bool not null default false` (surface for §179/depreciation),
  created_at. *Deviation from the reference doc: no `is_owner_pay` flag —
  owner pay is a transaction `kind` with a null category, so an owner-pay
  category would be redundant.*
- **ledger_transactions** — id, owner_id, `account_id` fk→ledger_accounts
  (restrict), `date date`, `amount_cents bigint` (signed: + in, − out), `kind`
  check in (`income|expense|owner_pay|transfer`), `category_id`
  fk→ledger_categories (restrict, **nullable** — null = uncategorized; checked:
  owner_pay/transfer must be null), `show_id` fk→shows (set null, nullable),
  `payee text not null default ''`, `memo`, `cleared` check in
  (`uncleared|cleared|reconciled`) default uncleared, `import_id text` null,
  `transfer_transaction_id uuid` null (schema-ready for account-to-account
  pairing; no phase-1 UI), `source` check in (`manual|import`) default manual,
  timestamps. Sign-vs-kind checks: income ⇒ amount > 0; expense and owner_pay ⇒
  amount < 0. **Unique partial index on (owner_id, account_id, import_id) where
  import_id is not null** — the dedupe backstop.
- **ledger_reconciliations** — id, owner_id, account_id fk,
  `statement_balance_cents bigint`, `reconciled_on date`, created_at.

**Deferred from the reference doc (explicitly):** split transactions, multiple
accounts UI, transfer pairing UI, import-batch table (the unique import_id index
covers re-import safety without it).

## Pure libs (all `node --test`ed, no `@/`/JSX)

- **lib/ledgerCategories.ts** — `DEFAULT_CATEGORIES`: the seed S-Corp chart
  (grouped: Income; Operations — Equipment & Gear [is_equipment], Supplies,
  Software & Subscriptions, Phone, Internet; Travel — Airfare, Lodging, Meals,
  Ground Transport, Baggage, Parking & Tolls; Business — Insurance,
  Professional Fees, Bank Fees, Licenses & Dues, Advertising, Education,
  Home Office Reimbursement; plus non-deductible none — owner pay is a kind).
  Fully editable after seeding; Dan's CPA list can reshape it later.
- **lib/ofx.ts** — OFX/QFX parser for both OFX 1.x SGML (unclosed tags) and
   2.x XML: extracts `STMTTRN` rows → `{ fitid, date (YYYY-MM-DD from DTPOSTED),
  amountCents (TRNAMT × 100, rounded), name, memo }`, plus the statement's
  `LEDGERBAL` when present. `name` is the first `NAME` leaf found anywhere in
  the `STMTTRN` block, including one nested inside a `PAYEE` aggregate — not
  a `NAME`-or-`PAYEE` alternation; a bank that sends a bare `PAYEE` leaf with
  no nested `NAME` yields an empty name. Tolerant of banks' quirks; tested
  against representative fixtures.
- **lib/ledgerImport.ts** — the YNAB-style matcher. For each parsed row, with
  the account's existing transactions in hand: `duplicate` (import_id already
  present) | `match` (an existing **manual** transaction, same account, same
  amount, date within ±10 days, not already import-linked → adopts the
  import_id and becomes cleared) | `new` (insert as source=import, cleared).
  `import_id = "OFX:" + fitid`; rows with no usable FITID fall back to
  `"GEN:" + amountCents + ":" + date + ":" + occurrence`. Kind inference for
  new rows: amount > 0 ⇒ income, else expense; category left null
  (uncategorized) for Dan to assign.
- **lib/ledgerBalance.ts** — balance math: working balance = opening + sum(all);
  cleared balance = opening + sum(cleared, reconciled). Used by the register
  header and reconcile.

## Server actions — `app/money/actions.ts` (owner-scoped like the rest of the app)

`createLedgerAccount` (rename/close deferred until a UI needs it — the
`updateLedgerAccount` action was removed as dead code in hardening),
`ensureDefaultCategories` (seeds DEFAULT_CATEGORIES once, when the owner has
none), `saveCategory` (add/rename/hide/deductible/equipment),
`addLedgerTransaction`,
`updateLedgerTransaction`, `deleteLedgerTransaction` (both **refuse
`cleared='reconciled'` rows** — reconciliation locks history),
`setTransactionCleared`, `importOfx(accountId, fileText)` (server-side parse +
match inside the action; returns `{ imported, matched, duplicates, skipped,
statementBalanceCents, autoCategorized }`),
`reconcileAccount(accountId, statementBalanceCents, reconciledOn,
createAdjustment)` — compares the cleared balance (rows dated ≤ reconciledOn
only) to the statement; a mismatch returns a structured `{ mismatch }` variant
and the UI offers a **balance-adjustment transaction** (payee "Balance
Adjustment", uncategorized, left merely cleared so a mistake stays correctable);
the apply itself is ONE atomic call to the `reconcile_ledger_account` RPC
(migration 0029): lock cleared→reconciled, adjustment, reconciliation record,
account stamp.

## UI

- **AppShell NAV** gains `Money` (`/money`). Mobile hamburger absorbs the fifth
  item; desktop bar fits.
- **`/money`** — the register: first-run card to create the checking account
  (name, opening balance, opening date); then the account header (working +
  cleared balance, last reconciled), **add-transaction row** (date, payee,
  amount, kind, category Select, optional show Select, memo), the transaction
  list newest-first (date · payee · category — inline category Select for
  uncategorized rows · show tag · amount · cleared toggle · delete), an
  **uncategorized count**, an **Import** control (file input → `importOfx` →
  summary line), and a **Reconcile** flow (enter statement balance → match or
  offer adjustment → lock).
- **`/money/categories`** — the chart of accounts editor: grouped list,
  add/rename/hide, equipment flag visible.
- Show Select options come from recent shows (name + date), so tagging a
  transaction to a show is one pick. Category/show tagging is always optional —
  the uncategorized queue is the workflow, not a blocker.

## Invariants

- **Money is Dan's view only** — nothing in /money reaches any client-facing
  surface (invoices, PDFs, public links, emails).
- **Reconciled rows are locked** (server-enforced, not just UI).
- **Re-importing the same file is a no-op** (unique import_id per account).
- Integer cents everywhere; dates are plain `YYYY-MM-DD`.
- Categories are suggestions for the CPA, not tax computation.

## Testing

Pure-lib suites for: DEFAULT_CATEGORIES shape (groups present, all deductible
flags sane), OFX parsing (1.x SGML + 2.x XML fixtures, date/amount edge cases,
missing FITID fallback), import matching (duplicate / manual-match ±10d /
new; occurrence counter for identical rows), balance math. Server actions and
UI verified on the dev sandbox (gates: tsc/build/test; walkthrough with a
fixture OFX file).

## Ship gate (unchanged rule)

Dev only until Dan says ship: then migrate prod 0027 + 0028 + 0029, in order, BEFORE deploying code.
