> **Postscript (2026-08-19):** the module is BUILT AND LIVE in production
> (migrations 0027–0031).
> **Postscript 2 (2026-08-21):** the register described below was REBUILT
> YNAB-style (running balance, outflow/inflow, receipt + cleared columns,
> phone date groups) — see docs/superpowers/plans/2026-08-21-register.md.
> The transaction model's "receipt link" intent is now REAL (0031:
> receipt_path/receipt_original on ledger_transactions). Still NEVER built
> from this model: matched_transaction_id (schema has transfer_transaction_id
> only), split/subtransactions, and the import-batch table — the auto-bridge
> plan should treat those as open design, not existing schema.. Three notes where reality diverged from this design:
> (1) a full YNAB Rule-1 **envelope layer was built** (/money/budget — immutable
> move ledger, Available-to-allocate) even though this doc lists the
> goals/targets engine as skipped; the tax jar is the Taxes envelope.
> (2) File import is **OFX/QFX only** — CSV was dropped (Dan's bank offers OFX,
> which carries real transaction ids). (3) The category seed is **Dan's own
> YNAB chart** (Bills/Expenses/Purchases/Taxes groups), not the invented S-Corp
> set below; income is tracked per client via the payee. Current conventions
> live in CLAUDE.md; the deferred list in docs/BACKLOG.md.
> **Postscript 3 (2026-08-21):** phase 3 (the invoice/expense bridge) is
> BUILT — migration 0032, with LINK TABLES (`ledger_transaction_invoices`,
> `ledger_transaction_expenses`) instead of the `matched_transaction_id`
> column sketched below, because Dan's real cases are N↔N (Streamline pays
> two invoices with one check; one Uber Eats expense posts as order + tip).
> Design: `2026-08-21-invoice-expense-bridge-design.md`. The tax-set-aside
> feed and the `from_invoice`/`from_expense` sources stayed unbuilt on
> purpose — nothing is ever copied into the ledger; links join, and the
> bank row stays the only money record.

# Bookkeeping module — design reference

*Promoted from the 2026-08-17/18 planning sessions. This is the durable record of
what the bookkeeping ("budgeting") module is, every decision made with Dan, and
the YNAB research that grounds it. The module itself is built in phases; the
first two slices (my-cost expenses, per-show profit/take-home) ship ahead of it.*

## What it is

*Business* bookkeeping for Smith Audio — an **LLC filing as an S-Corp** —
optimized to **maximize deductions** and hand a **clean year-end package to
Dan's CPA** (who files the 1120-S). It is NOT a tax engine and NOT personal
budgeting (Dan keeps YNAB for personal). The win is *completeness of capture*:
never miss a deduction.

**Day-one priority (Dan's ranking):** per-show profit (#1) → live business
dashboard (#2) → deduction completeness (#3). The MVP therefore leads with
per-show profitability, which mostly uses data the app already has.

## The money model

- **The hub is one business checking account.** All client payments in, all
  business expenses out, transfers out to Dan personally.
- **Every transaction is one of four things:** (1) income, (2) deductible
  expense, (3) **owner pay / distribution** — deliberately *excluded* from
  deductions (paying yourself is not a business cost; Dan transfers informally,
  the CPA splits salary vs. distribution at year end), or (4) a plain transfer.
- **Two dimensions per transaction:** a **tax category** (always) + an
  **optional show tag** (for per-show P&L). Overhead stays untagged.
- **Per-show P&L** handles both client types automatically: *per-diem* (fixed
  allowance in, own meals out → margin Dan keeps) and *reimbursement* (cost out,
  exact reimbursement in → nets to zero; the tagging proves nothing was
  forgotten).

## Data model (single-user; YNAB patterns without the multi-user machinery)

Money is integer cents everywhere (the app already does this; equivalent to
YNAB's milliunits discipline).

- **account** — business checking first (type supports card/savings/cash later):
  name, type, balance, cleared balance, last_reconciled_at, closed.
- **transaction** — date, account_id, amount (signed cents), kind
  (`income | expense | owner_pay | transfer`), category_id (null for
  owner_pay/transfer), show_id (optional), payee, memo, cleared
  (`uncleared | cleared | reconciled`), import_id (dedup), matched_transaction_id,
  receipt link (reuses existing receipt storage), source
  (`manual | import | from_invoice | from_expense`). Transfers link two rows.
- **split/subtransaction** — parent has null category; children carry
  amount + category + show.
- **category** — the editable S-Corp chart of accounts: name, group, hidden,
  order, flags `is_owner_pay` (never deductible), `is_equipment` (surface for
  depreciation/§179), `deductible`. Seeded with a sensible default set, fully
  editable — matched to the CPA's chart when Dan gets it.
- **tax set-aside config** — a rate Dan/his CPA sets; estimates only.
- **reconciliation** — one record per reconcile (account, statement balance,
  date); included transactions lock.
- **import batch** — file imports tracked; dedupe via import_id + fuzzy match
  (account + amount + date window).

Deliberately skipped vs YNAB: `server_knowledge` delta sync, OAuth/multi-tenant,
the full goals/targets engine (the tax jar is the one sinking fund that
matters), age-of-money.

## Capture

Manual entry **+** CSV/OFX file import **+** optional auto-connect later.
Manual entries match/dedupe against imports (YNAB's `import_id` + fuzzy match:
same account, same amount, date within a window). Built-in **reconcile**: enter
the real bank balance, match cleared, lock rows. Security-first: the manual +
import + reconcile core has zero third-party exposure; auto-connect is a later
optional layer, **SimpleFIN preferred over Plaid** for privacy. The app never
handles bank credentials itself.

## Deductions outside the bank feed

- **Mileage** — stays in MileIQ; the year-end package leaves a slot for its
  figure/report. Not rebuilt.
- **Home office** — CPA year-end computation; for an S-Corp usually an
  accountable-plan *reimbursement* from the business (which, unlike owner pay,
  IS deductible) — needs its own category, not a calculator.
- **Gear/equipment** — flagged so big purchases surface for depreciation/§179
  instead of drowning in "supplies."
- **Per-show take-home / tax jar** — each show's profit × a configurable
  set-aside rate → "set aside $X, take-home $Y," accumulating into a running tax
  jar so April is never a surprise. Estimates only; the rate comes from Dan/his
  CPA; never tax advice.

## The invoice / expense bridge (why it lives in this app)

- Paid invoice → income transaction (show-tagged), matched to the bank deposit
  on import so nothing is entered twice.
- Billed/reimbursed expense → show-tagged expense transaction matched to its
  bank charge; the reimbursement deposit is income (nets zero).
- My-cost expense (per-diem meals) → deductible show-tagged expense, never
  billed.
- Owner-pay transfer → owner_pay, excluded from deductions.

## Phased build path

1. **Ledger spine:** accounts, transactions, editable categories, manual entry +
   CSV/OFX import with dedupe, reconcile, show tagging.
2. **Payoff:** live dashboard (running P&L, per-show profit, YTD by category,
   uncategorized queue) + the year-end CPA export (totals, income, per-show
   profit, MileIQ/home-office slots, receipts — reuses the PDF + receipt
   archive).
3. **Integration:** the invoice/expense auto-bridge above.
4. **Optional:** SimpleFIN auto-connect.

Development happens in this codebase against the **dev Supabase project**
(`billing-audiosmith-dev`, seeded with 🧪 SANDBOX data); prod is migrated and
code merged only at explicit ship gates.

## Non-goals

Not a tax calculator/filer. Not personal budgeting. Not multi-user. No bank
credentials in-app.

## Questions for the CPA (Dan's homework; answers feed the build)

1. Chart of accounts — their preferred 1120-S expense-category list.
2. Year-end handoff — what they actually want (P&L? categorized totals? format?
   receipts or just numbers?).
3. Tax set-aside % — roughly what share of net profit to hold back.
4. Paying himself — plain transfers today: is that right for an S-Corp, or
   payroll salary + distributions, and how should each be recorded?
5. Home office — accountable-plan reimbursement? What records?
6. Mileage — does the business reimburse the MileIQ miles; do they want the report?
7. Meals — per-diem meals he buys vs. meals billed to clients: categorization?
8. Equipment — dollar threshold for depreciation/§179 vs. expensing.

## YNAB research (the foundation — essentials)

**Method:** zero-based/envelope budgeting as a live habit. Four Rules: give
every dollar a job (assign only money you have, until unassigned = $0); embrace
true expenses (sinking funds for lumpy bills); roll with the punches (move money
between categories mid-month, logged); age your money (spend money earned weeks
ago). Cash overspending = red/urgent; credit overspending = yellow/future debt.
Signature mechanic: a credit-card purchase both reduces the spending category
and moves that amount into the card's Payment category, so a green Payment
category means the card could be paid in full today.

**Product:** budget/tracking/loan accounts; category groups with
Assigned/Activity/Available columns and balances that carry forward; Targets
(refill-up-to vs. set-aside-another); payee rename rules + learned
categorization; split transactions; cleared/uncleared/reconciled with locking
reconciliation and balance adjustments; scheduled transactions; Direct Import
via Plaid/MX or file import (OFX/QFX preferred, CSV with rigid header
`Date,Payee,Category,Memo,Outflow,Inflow`); reports: income v expense, net
worth, age of money, spending breakdown/trends.

**Data model patterns worth copying** (from api.ynab.com/v1): integer milliunits
for money; transfers modeled as special payees with mirrored linked rows; splits
as child rows under a null-category parent; `import_id` dedup with fuzzy match
(same account + amount + date ±10 days); an immutable, groupable
"money movement" ledger instead of only mutating budgeted amounts;
`server_knowledge` delta sync (skipped here — single user).

**Best open reference:** Actual Budget — open-source, self-hostable, local-first
(SQLite + CRDT), entity model near-identical to YNAB plus rules and schedules.
Other comparables: EveryDollar (zero-based), Monarch (dashboard-first), Copilot,
Lunch Money (API-first), PocketSmith (forecasting), Quicken Simplifi.

Primary sources: ynab.com blog + support.ynab.com guides, api.ynab.com/v1 and
its OpenAPI spec, actualbudget.org/docs.
