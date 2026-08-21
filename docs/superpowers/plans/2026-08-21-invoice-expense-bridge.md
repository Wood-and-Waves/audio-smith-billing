# Invoice / Expense Auto-Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seam between the billing half and the Money half: after an OFX import, propose matches between bank rows and open invoices / show expenses in a review queue at `/money/matches`; accepting links them (marking invoices paid with the deposit's real date, show-tagging bank rows, surfacing receipts) — nothing applies without a click.

**Architecture:** One additive migration (0032: `invoices.paid_at` + three link/suppression tables). A pure matcher lib (`lib/ledgerMatch.ts`) that proposes and never writes, mirroring `planImport`'s analyze-only shape. Server actions in `app/money/actions.ts` apply/dismiss/unlink. A `/money/matches` queue page + count badge on `/money`. Register rows and the invoice detail page surface the links read-only.

**Tech Stack:** Next.js 16 App Router server components + server actions, Supabase (Postgres + RLS), node --test pure-lib tests, Tailwind v4 CSS-first.

**Design doc:** `docs/superpowers/specs/2026-08-21-invoice-expense-bridge-design.md` (committed b8374e7). Dan's four decisions: deposit-first income, link-only expenses (no copied amounts), review queue with nothing auto-applied, no tax set-aside this wave.

## Global Constraints

- Money is integer cents everywhere; `parseUSD('')` returns 0 — but this wave never parses user-typed amounts, so no new guard sites.
- Pure logic in `lib/ledgerMatch.ts`: no `@/` imports, no JSX, relative `.ts` imports only, tested in `scripts/test/ledgerMatch.test.ts` under `npm test`.
- Server actions stay untested; their brains live in the pure lib.
- Migrations ADDITIVE ONLY; migration file is `scripts/sql/migrations/0032_bridge_links.sql`; never edit an applied migration.
- **SHIP ORDER: migrate prod FIRST, then merge/push.**
- Every Supabase read that could exceed 1000 rows pages with `.range()` in stable `created_at,id` order.
- Owner-scoping: RLS + explicit `.eq('owner_id', …)` + `belongsToCaller`-style FK checks on BOTH sides of every link write (FK checks bypass RLS).
- **Links never reach a client-facing surface**: no link data, ledger ids, or bank descriptors in invoice PDFs, `/i/[token]`, `public_invoice`, `public_invoice_backup`, `buildBackupSnapshot`, or emails. This wave touches none of those files; the final review must confirm that stays true.
- A link means paid in full — partial payments out of scope. Accept path refuses an over-sum on expense links.
- Reconciled rows: linking/unlinking joins categorization + receipts as the third audit-metadata carve-out; everything else on a reconciled row stays locked.
- Matcher rules (pinned in spec): income candidates are unlinked invoices with status sent OR paid, exact amount vs `total_cents`, deposit dated ≥ `sent_at`; sums of 2–3 same-client invoices; payee similarity ranks but never creates a match. Expense candidates: exact amount within ±10 days of `spent_on`; groups of ≤3 same-leading-token payee charges within ±3 days of each other summing exactly, group span inside the ±10-day window. Ambiguity (two identical-value targets) → propose both, pre-select neither.
- Accepting income: link rows; each invoice → status 'paid', `paid_at` = bank row's date; fill blank payee with client name (never overwrite); `show_id` only when the invoice covers exactly one show; `category_id` untouched. Accepting expense: link rows; `show_id` from the expense; receipt surfaces on the bank row; `category_id` untouched. Unlink: delete links; invoice back to 'sent' with `paid_at` cleared unless another transaction still links it; `show_id`/`payee` stay.
- `setInvoiceStatus(id,'paid')` stamps `paid_at` = today; any other status clears it. `sent_at` untouched (existing rule).
- UI copy minimal (Dan: "There are too many instructions"); the evidence line ("$33.25 + $7.00 = $40.25") is the explanation. Use existing idioms: eyebrow headers, list-row border idiom, `useTransition` + `router.refresh()` + `{error}`.

## Model tiering (Dan's standing directive)

- Task 1 (migration) + Task 2 (types/test scaffolds): cheapest tier — plan text contains the complete code.
- Tasks 3–4 (matcher internals + tests): mid-tier (logic).
- Tasks 5–8 (actions, queue UI, register/invoice surfacing): mid-tier.
- Final whole-branch review: top model (money code).

---

## Context

Today the two halves don't speak: a $2,400 Clinique ACH arrives as an uncategorized deposit with a bank descriptor, while the invoice it pays sits in `/invoices` unaware; a receipt captured at the show sits in `expenses` while its card charge sits in the ledger with neither receipt nor show. Dan's real cases pin the hard parts: Streamline pays two invoices with one check (→ link tables, not columns), and one $40.25 Uber Eats expense posted as $33.25 + $7.00 (→ 1 expense to N bank rows). `invoices.paid_at` does not exist today; creating it is what makes the forecast's per-client pay-lag learning possible later.

## File Structure

- Create: `scripts/sql/migrations/0032_bridge_links.sql` — paid_at + 3 tables
- Create: `lib/ledgerMatch.ts` — pure matcher (types, normalization, income/expense candidate generation, confidence)
- Create: `scripts/test/ledgerMatch.test.ts`
- Modify: `app/money/actions.ts` — fetch helpers + `acceptIncomeMatch`, `acceptExpenseMatch`, `dismissMatch`, `unlinkTransaction`
- Modify: `app/invoices/actions.ts` — `setInvoiceStatus` stamps/clears `paid_at`
- Create: `app/money/matches/page.tsx` + `components/MatchQueue.tsx` — the review queue
- Modify: `app/money/page.tsx` — Matches link + count badge
- Modify: `components/MoneyRegister.tsx` — linked-row display + Unlink in edit mode
- Modify: `app/invoices/[id]/page.tsx` — "Paid <date>" line with deposit info
- Modify: `docs/BACKLOG.md`, `CLAUDE.md` — post-ship truth updates (final task)

## Reuse (found in exploration — do not reinvent)

- `normalizePayee(payee)` from `lib/payeeMemory.ts:19` — case-insensitive, whitespace-collapsed. Import relatively: `import { normalizePayee } from './payeeMemory.ts'`.
- `lib/receiptDuplicates.ts` is the structural precedent for a propose-never-decide matcher (its header: a guess "is only ever FLAGGED — named, unticked, and his to overrule").
- `findMatch` in `lib/ledgerImport.ts:85-106` is the style model for candidate scoring: cheap disqualifying guards first, named boolean locals, explicit deterministic tie-break.
- Private `daysApart` per lib is the convention (`lib/ledgerImport.ts:41-50`); `lib/dates.ts` has `addDays`/`isPlainDate` but no diff helper.
- `formatUSD` from `lib/money.ts:57` for any displayed amount.
- Test idiom: flat `test('lowercase sentence — consequence', ...)`, `node:assert/strict`, factory fixtures with `Partial<T>` overrides, integer cents as bare literals, dates as `'2026-…'` strings. No `describe()` anywhere.
- Plan-type shape: disjoint outcome buckets in one object, inline anonymous element types, internal refs via indexed access (`ImportPlan['matches']` idiom).

---

## Task 1: Migration 0032 — paid_at + link/suppression tables

**Files:**
- Create: `scripts/sql/migrations/0032_bridge_links.sql`

**Interfaces:**
- Produces: `invoices.paid_at date`; tables `ledger_transaction_invoices`, `ledger_transaction_expenses`, `ledger_match_dismissals` — exact shapes below; every later task queries these.

**Tier:** cheapest (complete code below; transcription + verification).

- [ ] **Step 1: Write the migration file** — exact contents:

```sql
-- 0032 — the invoice/expense bridge: links between bank rows and the
-- billing half, plus the date money actually landed.
--
-- invoices.paid_at is distinct from sent_at. It is stamped only by the two
-- paths that know money arrived: accepting a deposit match (the bank row's
-- own date — authoritative) and setInvoiceStatus(id,'paid') (today — a
-- guess the deposit match corrects later). Any other status clears it.
alter table invoices add column paid_at date;

-- Link TABLES, not columns on ledger_transactions: Streamline pays two
-- invoices with one check (N invoices per deposit), and one $40.25 Uber
-- Eats expense posted at Chase as $33.25 + $7.00 (N bank rows per
-- expense). No amount column on purpose: the invoice knows its total and
-- the bank row knows its own, so a link only asserts "these belong
-- together" — a link means paid in full. Partial payments, if they ever
-- happen, are a future nullable amount_cents (null = in full).
create table ledger_transaction_invoices (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references ledger_transactions(id) on delete cascade,
  invoice_id     uuid not null references invoices(id) on delete cascade,
  created_at     timestamptz not null default now(),
  unique (transaction_id, invoice_id)
);
create index lti_invoice_idx on ledger_transaction_invoices (invoice_id);

create table ledger_transaction_expenses (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references ledger_transactions(id) on delete cascade,
  expense_id     uuid not null references expenses(id) on delete cascade,
  created_at     timestamptz not null default now(),
  unique (transaction_id, expense_id)
);
create index lte_expense_idx on ledger_transaction_expenses (expense_id);

-- Proposals are recomputed fresh on every visit — the matcher is pure and
-- holds no state — so without this suppression list a rejected guess would
-- return after every import. Discriminated (invoice XOR expense) because a
-- dismissal names one target; dismissing a sum proposal writes one row per
-- target, and any dismissed pair suppresses the whole group.
create table ledger_match_dismissals (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references ledger_transactions(id) on delete cascade,
  invoice_id     uuid references invoices(id) on delete cascade,
  expense_id     uuid references expenses(id) on delete cascade,
  created_at     timestamptz not null default now(),
  check (num_nonnulls(invoice_id, expense_id) = 1),
  unique (transaction_id, invoice_id),
  unique (transaction_id, expense_id)
);

-- Standard owner-scoped RLS (the 0030 idiom).
do $$
declare t text;
begin
  foreach t in array array[
    'ledger_transaction_invoices',
    'ledger_transaction_expenses',
    'ledger_match_dismissals'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t || '_owner_all', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
```

(The `unique (transaction_id, …)` constraints double as the transaction-side indexes — leading column — so only the far-side indexes are created explicitly.)

- [ ] **Step 2: Apply to DEV**: `npm run db:migrate` — expect 0032 applied, checksum recorded.
- [ ] **Step 3: Verify shape**: one-off SQL via `npm run db:sql` selecting from `information_schema.columns` for `invoices.paid_at` and the three tables; expect all present.
- [ ] **Step 4: Commit** — `git add scripts/sql/migrations/0032_bridge_links.sql && git commit -m "0032: paid_at + bridge link tables"`.
- [ ] **PROD NOTE:** prod application happens at ship time (Task 9), FIRST, before merge.

---

## Task 2: `lib/ledgerMatch.ts` — types + income matching (TDD)

**Files:**
- Create: `lib/ledgerMatch.ts`
- Create: `scripts/test/ledgerMatch.test.ts`

**Tier:** mid (logic; exact types and pinned rules below, implementation from prose).

**Interfaces (exact — later tasks consume these verbatim):**

```ts
// Inputs are DB-shaped (snake_case) like ExistingTxn in ledgerImport.ts.
export type BankRow = {
  id: string
  date: string                 // YYYY-MM-DD
  amount_cents: number         // signed: + deposit, − charge
  payee: string
  kind: 'income' | 'expense' | 'owner_pay' | 'transfer'
  linked: boolean              // already has ANY link row (either table)
}

export type CandidateInvoice = {
  id: string
  number: number
  client_id: string
  client_name: string
  total_cents: number
  sent_at: string | null       // ISO timestamptz; compare on its YYYY-MM-DD prefix
  status: 'sent' | 'paid'      // paid-but-unlinked stays a candidate (spec)
  linked: boolean              // already linked to any transaction
}

export type CandidateExpense = {
  id: string
  show_id: string
  amount_cents: number         // positive (expenses table checks > 0)
  spent_on: string             // YYYY-MM-DD
  where_spent: string
  linked: boolean
}

export type Dismissal = {
  transaction_id: string
  invoice_id: string | null
  expense_id: string | null
}

export type IncomeProposal = {
  transactionId: string
  invoiceIds: string[]         // 1–3, ascending sent_at then id (deterministic)
  confidence: 'high' | 'low'   // high = pre-selected by accept-all; low = never
}

export type ExpenseProposal = {
  transactionIds: string[]     // 1–3, ascending date then id (deterministic)
  expenseId: string
  confidence: 'high' | 'low'
}

export type MatchProposals = { income: IncomeProposal[]; expense: ExpenseProposal[] }

export function proposeMatches(input: {
  rows: BankRow[]
  invoices: CandidateInvoice[]
  expenses: CandidateExpense[]
  dismissed: Dismissal[]
}): MatchProposals
```

**Pinned income rules (implement exactly):**
- Eligible rows: `!linked`, `amount_cents > 0`, kind `income` — plus kind `expense` is impossible for positive amounts (DB check), but guard on sign not kind; exclude `transfer`.
- Eligible invoices: `!linked`, status `sent` or `paid`, `sent_at !== null`.
- **Exact single:** `row.amount_cents === invoice.total_cents` and `row.date >= sent_at.slice(0, 10)`.
- **Exact sum:** only for rows with NO exact-single proposal. Combinations of 2 or 3 eligible invoices of the SAME `client_id`, all with `sent_at.slice(0,10) <= row.date`, whose totals sum to `row.amount_cents` exactly. Cap: if more than 3 sum combinations exist for one row, propose none (illegible; Dan can link by hand later — log nothing, this is a matcher not an auditor).
- **Suppression:** a proposal is dropped when ANY of its (transaction, invoice) pairs appears in `dismissed`.
- **Confidence:** `high` iff (a) single-invoice proposal, (b) payee similarity holds — the normalized row payee and normalized `client_name` share ≥1 token of length ≥ 3 (`normalizePayee` from `./payeeMemory.ts`, split on spaces), and (c) no other proposal names the same transaction AND no other proposal names the same invoice (ambiguity → both stay `low`, pre-select neither). Sums are always `low`.
- Determinism: proposals sorted by transaction date asc, then transaction id; a row can appear in multiple proposals (ambiguity is surfaced, never resolved by the matcher — accept path re-checks server-side).

- [ ] **Step 1:** Write failing tests for income matching (names + intent; bodies follow the `ledgerImport.test.ts` factory idiom — `const row = (over: Partial<BankRow> = {}): BankRow => ({...})` etc.):
  - `an exact-amount deposit on or after the send date proposes the invoice`
  - `a deposit dated before sent_at proposes nothing — money cannot land before the ask`
  - `an invoice already marked paid by hand is still proposed — the deposit still needs its date`
  - `a linked invoice is never proposed again`
  - `a linked bank row is never proposed again`
  - `two same-client invoices summing to one deposit propose together — the Streamline case` (two invoices, one deposit of the sum)
  - `sum proposals never mix clients`
  - `a sum is not proposed when an exact single exists for the row`
  - `two identical-value invoices both propose at low confidence — the matcher never guesses between equals`
  - `payee similarity raises confidence but never creates a match` (similar payee + wrong amount → nothing; similar payee + right amount → high; dissimilar payee + right amount → low)
  - `a dismissed pair suppresses its proposal`
  - `transfers and owner-pay-shaped rows never match` (kind 'transfer' positive row → nothing)
- [ ] **Step 2:** Run `npm test` — expect the new tests FAIL (module not found / function missing).
- [ ] **Step 3:** Implement types + `proposeMatches` income half (helpers: private `daysApart` copied from `lib/ledgerImport.ts:44-50` style; private `tokensOf`, `shareToken`). Style: prose header comment arguing the design (propose-never-decide, cite receiptDuplicates.ts), cheap guards first, named boolean locals.
- [ ] **Step 4:** `npm test` — all pass.
- [ ] **Step 5:** Commit: `feat: ledgerMatch — income proposals`.

---

## Task 3: `lib/ledgerMatch.ts` — expense matching (TDD)

**Files:**
- Modify: `lib/ledgerMatch.ts`
- Modify: `scripts/test/ledgerMatch.test.ts`

**Tier:** mid.

**Pinned expense rules (implement exactly):**
- Eligible rows: `!linked`, `amount_cents < 0`, kind `expense`.
- Eligible expenses: `!linked`. (Non-reimbursable/billable=false expenses are NOT excluded — the caller simply doesn't filter them out; nothing in the lib knows about billable.)
- **Exact single:** `-row.amount_cents === expense.amount_cents` and `|daysApart(row.date, expense.spent_on)| <= 10`.
- **Exact sum (the Uber Eats case):** only for expenses with NO exact-single proposal. Groups of 2–3 eligible rows where: all payees share the same LEADING token (first token of `normalizePayee(payee)`, length ≥ 3); every pair of row dates is ≤ 3 days apart; every row is within ±10 days of `spent_on`; `-sum(amount_cents) === expense.amount_cents` exactly. More than 3 valid groups for one expense → propose none.
- **Suppression:** dropped when ANY (transaction, expense) pair is dismissed.
- **Confidence:** `high` iff single-row proposal with payee↔where_spent token overlap (same ≥3-length shared-token rule against `normalizePayee(where_spent)`) and no ambiguity (no other proposal names the same row or the same expense). Sums always `low`.

- [ ] **Step 1:** Failing tests:
  - `a charge matching an expense within ten days proposes it`
  - `eleven days out proposes nothing — the boundary pair` (10 days matches / 11 does not)
  - `the Uber Eats case — order plus tip sum to one expense` ($-3325 and $-700 rows, one $4025 expense, payees 'UBER EATS' / 'UBER EATS TIP')
  - `rows with different leading tokens never group`
  - `rows four days apart never group — pairwise span is the rule`
  - `a group is not proposed when a single row matches exactly`
  - `two identical-value expenses both propose at low confidence`
  - `a dismissed pair suppresses the whole group`
  - `a linked expense is never proposed again`
- [ ] **Step 2:** `npm test` — new tests fail.
- [ ] **Step 3:** Implement the expense half.
- [ ] **Step 4:** `npm test` — all pass. Cold tsc: `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit` — clean.
- [ ] **Step 5:** Commit: `feat: ledgerMatch — expense proposals (1→N groups)`.

---

## Task 4: `setInvoiceStatus` stamps and clears `paid_at`

**Files:**
- Modify: `app/invoices/actions.ts` (setInvoiceStatus, ~line 267)

**Tier:** cheapest (exact change below).

**Interfaces:**
- Consumes: `invoices.paid_at` (Task 1), `todayInChicago` from `lib/dates.ts:32`.

- [ ] **Step 1:** In `setInvoiceStatus`, replace `const patch: Record<string, unknown> = { status }` with:

```ts
  // paid_at is the date money landed — a fact, not a status. Marking paid by
  // hand stamps today (a guess the deposit match later corrects to the bank's
  // own date); any other status clears it. sent_at stays untouched per the
  // comment above.
  const patch: Record<string, unknown> = {
    status,
    paid_at: status === 'paid' ? todayInChicago() : null,
  }
```

  Add `todayInChicago` to the existing `lib/dates` import.

- [ ] **Step 2:** Directly above the update, add the leaving-paid guard (a linked invoice's paid-ness belongs to its deposit; unlink is the undo):

```ts
  // An invoice paid by a linked bank deposit can't be un-paid from here —
  // the link would dangle. Unlinking the deposit (register edit mode) is the
  // undo, and it restores 'sent' itself.
  if (status !== 'paid') {
    const { data: links } = await supabase
      .from('ledger_transaction_invoices').select('id').eq('invoice_id', id).limit(1)
    if (links && links.length > 0) {
      return { error: 'A bank deposit is linked to this invoice. Unlink it in the register first.' }
    }
  }
```

- [ ] **Step 3:** Gates: `npm test` (no new tests — action brains are two lines; convention keeps actions untested), cold tsc, `npm run build`.
- [ ] **Step 4:** Commit: `feat: paid_at stamped by Mark Paid, cleared on any other status`.

---

## Task 5: Money actions — accept, dismiss, unlink

**Files:**
- Modify: `app/money/actions.ts`

**Tier:** mid (multi-table money writes; the semantics below are binding).

**Interfaces:**
- Consumes: Task 1 tables; `LedgerKind` from `lib/ledgerRules.ts`.
- Produces (exact signatures — Tasks 6–7 call these):

```ts
export async function acceptIncomeMatch(input: {
  transactionId: string; invoiceIds: string[]
}): Promise<Fail | { ok: true }>

export async function acceptExpenseMatch(input: {
  expenseId: string; transactionIds: string[]
}): Promise<Fail | { ok: true }>

export async function dismissMatch(
  pairs: { transactionId: string; invoiceId?: string; expenseId?: string }[],
): Promise<Fail | { ok: true }>

export async function unlinkTransaction(txnId: string): Promise<Fail | { ok: true }>
```

**Binding semantics — `acceptIncomeMatch`** (a server action is a public POST endpoint; re-verify everything the matcher believed):
1. Auth; `invoiceIds` length 1–3, no duplicates.
2. Fetch the txn (`id, date, amount_cents, kind, payee, show_id` — RLS scopes it; `maybeSingle`, missing → error). Require `kind === 'income'` and `amount_cents > 0`. Require NO existing rows for it in EITHER link table.
3. Fetch the invoices `.in('id', invoiceIds)` with `id, number, status, total_cents, client_id, clients(name)`. All must exist; each `status` in `('sent','paid')`; none may appear in `ledger_transaction_invoices` already. Multi-invoice: all the same `client_id`.
4. `sum(total_cents) === txn.amount_cents` exactly, else error.
5. Insert link rows (`owner_id: user.id`).
6. Update the invoices: `status: 'paid', paid_at: txn.date` (`.in('id', …).select('id')`; count mismatch → error).
7. Show tag: only when `invoiceIds.length === 1` AND `txn.show_id === null` — query `.from('shows').select('id').eq('invoice_id', invoiceId)`; set `show_id` only when EXACTLY one row (the fail-safe from `app/shows/[id]/page.tsx:152-168`: unknown never resolves to sole coverage).
8. Payee: only when `txn.payee.trim() === ''`, set it to the client name — never overwrite what Dan typed.
9. `revalidatePath('/money')`, `'/invoices'`, and `` `/invoices/${id}` `` for each invoice. (New /money sub-pages are force-dynamic — the module convention stays "actions revalidate `/money` only" plus the billing paths this action actually mutates.)
10. NO cleared-state check anywhere in this task's actions: linking is the third audit-metadata carve-out (categorization, receipts, now links) — reconciled rows link and unlink freely; nothing here moves money.

**`acceptExpenseMatch`:**
1. Auth; `transactionIds` length 1–3, no duplicates.
2. Fetch the expense (`id, show_id, amount_cents`); must exist and have no `ledger_transaction_expenses` rows.
3. Fetch the txns `.in('id', …)`; all must exist, each `kind === 'expense'` and `amount_cents < 0`, none linked in either table.
4. `-sum(amount_cents) === expense.amount_cents` exactly — this equality IS the over-sum refusal.
5. Insert link rows; update each txn `show_id = expense.show_id` (the expense's show is authoritative — `expenses.show_id` is not null).
6. Do NOT touch the txn's receipt columns — the receipt surfaces via display-time join (Task 7). Copying paths would let `removeLedgerReceipt` delete the expense's file.
7. `revalidatePath('/money')`.

**`dismissMatch`:** auth; 1–3 pairs, each exactly one of `invoiceId`/`expenseId`; verify every referenced txn/invoice/expense exists via RLS-scoped selects (FK checks bypass RLS); upsert into `ledger_match_dismissals` with `ignoreDuplicates: true` (`onConflict: 'transaction_id,invoice_id'` for invoice pairs, `'transaction_id,expense_id'` for expense pairs — two upsert calls); `revalidatePath('/money')`.

**`unlinkTransaction`:** auth; fetch the txn's rows from both link tables (neither → error `'Nothing is linked to this transaction.'`); delete them. **Expense groups dissolve whole:** for each expense that was linked via this txn, delete that expense's remaining link rows too — otherwise a $40.25 expense stays "linked" to a lone $7.00 tip, breaking the fully-covered invariant. Then for each formerly-linked invoice, if NO other transaction still links it, update to `status: 'sent', paid_at: null`. `show_id` and `payee` stay on every affected row — once written they're Dan's data (edit mode clears them). Works on reconciled rows (carve-out). Revalidate `/money`, `/invoices`, each `/invoices/${id}`.

- [ ] **Step 1:** Implement all four actions, following `attachLedgerReceipt`'s shape (`app/money/actions.ts:619-651`): `createClient` → auth guard → RLS-scoped reads → explicit guards → writes with `owner_id` on inserts → single revalidate block. Doc comments argue each guard the way the file already does.
- [ ] **Step 2:** Gates: `npm test`, cold tsc, `npm run build`.
- [ ] **Step 3:** Commit: `feat: bridge actions — accept, dismiss, unlink`.

---

## Task 6: `/money/matches` — the review queue

**Files:**
- Create: `app/money/matches/page.tsx`
- Create: `components/MatchQueue.tsx`

**Tier:** mid.

**Interfaces:**
- Consumes: `proposeMatches` + its types (Task 2/3); Task 5 actions; `formatUSD` (`lib/money.ts:57`), `formatDateShort` (`lib/dates.ts:22`).
- Produces: display types the page builds and `MatchQueue` receives:

```ts
export type IncomeCard = {
  txn: { id: string; date: string; amountCents: number; payee: string }
  invoices: { id: string; number: number; clientName: string; totalCents: number; status: 'sent' | 'paid' }[]
  confidence: 'high' | 'low'
}
export type ExpenseCard = {
  txns: { id: string; date: string; amountCents: number; payee: string }[]
  expense: { id: string; amountCents: number; spentOn: string; whereSpent: string; showName: string }
  confidence: 'high' | 'low'
}
```

**Page** (server component, `export const dynamic = 'force-dynamic'`, wraps in `<AppShell current="money">`, copies `/money/budget/page.tsx`'s structure and `LoadError` idiom):
1. Load: the single open account (`app/money/page.tsx:104` idiom); ALL ledger txns (copy the `fetchAllLedgerTransactions` paging shape inline — select `id, date, amount_cents, kind, payee`); ALL rows of both link tables and `ledger_match_dismissals` (paged, same `.range()` idiom — these grow unbounded); candidate invoices (`.in('status', ['sent','paid'])`, select `id, number, client_id, total_cents, sent_at, status, clients(name)`, paged); all expenses (`id, show_id, amount_cents, spent_on, where_spent, shows(name)`, paged).
2. Build `BankRow[]` (`linked` = id present in either link table), `CandidateInvoice[]` (`linked` from the invoice-side link set), `CandidateExpense[]`, `Dismissal[]`; call `proposeMatches`; map proposals to `IncomeCard[]`/`ExpenseCard[]` via lookup maps.
3. Render `<MatchQueue income={…} expense={…} />`.
4. NOTE for Dan (put in the final report, not the UI): the first visit will propose matches from the 2026 YNAB backfill history — deposits that paid this year's invoices. That is a feature (it back-links the year and backfills `paid_at`), not a bug.

**MatchQueue** (`'use client'`): eyebrow-headed sections "Deposits" then "Charges"; one card per proposal using the list-row idiom (`border-b border-line py-4 pl-3 -ml-3 pr-3`): bank side (date · payee · tabular amount) — target side (`#391 · Clinique · $2,400.00` / `Uber Eats · CLINIQUE · 8/12/26`); for sums, an evidence line exactly like `“$33.25 + $7.00 = $40.25”` built with `formatUSD`; per-card **Accept** (accent button idiom) and **Dismiss** (muted underline idiom). Accept-all button at top only when ≥2 `high` cards exist, accepting sequentially and stopping on first error. `useTransition` + `router.refresh()` + inline `{error}` per card. Empty state: `<p className="text-sm text-muted">Nothing waiting.</p>`. Accept for income calls `acceptIncomeMatch({ transactionId: txn.id, invoiceIds })`; dismiss calls `dismissMatch(invoices.map(i => ({ transactionId: txn.id, invoiceId: i.id })))`; expense cards mirror with `transactionIds`/`expenseId`.

- [ ] **Step 1:** Build page + component per above.
- [ ] **Step 2:** Gates: `npm test`, cold tsc, `npm run build`.
- [ ] **Step 3:** Browser check on dev (sandbox): visit `/money/matches`, confirm render + empty state.
- [ ] **Step 4:** Commit: `feat: /money/matches review queue`.

---

## Task 7: Register + `/money` surfacing

**Files:**
- Modify: `app/money/page.tsx`
- Modify: `components/MoneyRegister.tsx`

**Tier:** mid.

**Interfaces:**
- Consumes: Task 5's `unlinkTransaction`; link tables; `proposeMatches` for the badge count.
- Produces: `LedgerTxnRow` (exported from `components/MoneyRegister.tsx:30`) gains exactly:

```ts
  invoiceNumbers: number[]          // linked invoices ([] = none)
  expenseLinked: boolean            // has expense-link rows
  linkedReceiptPath: string | null  // a linked expense's receipt, display-time join
```

**Page changes:**
1. Fetch both link tables (paged; invoice links with `invoices(number)` embed) and expenses' receipt paths for linked expense ids; extend the row mapping to fill the three new fields (first linked expense with a `receipt_path` wins for `linkedReceiptPath`).
2. Badge: also fetch dismissals + candidate invoices + expenses (Task 6's selects), run `proposeMatches` over the already-loaded txns, `matchCount = income.length + expense.length`. Add to `headerActions` BEFORE the Budget link, copying the link idiom at `app/money/page.tsx:255-277`:

```tsx
            <Link
              href="/money/matches"
              className="text-xs text-muted hover:text-ink transition-colors"
            >
              Matches{matchCount > 0 && <span className="ml-1 font-semibold text-accent">{matchCount}</span>}
            </Link>
```

**Register changes:**
1. Invoice chip in the payee cell, both layouts, directly after the existing `showName` chip (`components/MoneyRegister.tsx:1162-1170` desktop, `:1275-1280` phone), same chip classes: `{t.invoiceNumbers.length > 0 && (<span className="…same chip classes…">#{t.invoiceNumbers.join(' + #')}</span>)}`.
2. `ReceiptControl` (`:210-249`): the view branch triggers on `row.receipt_path || row.linkedReceiptPath` (own receipt wins); `openReceipt` (`:870-883`) signs whichever it used via the already-imported `signedReceiptUrls`. The attach branch is unchanged and only offered when the row has neither.
3. Unlink: a neutral-variant button (`text-xs text-muted hover:text-ink underline disabled:opacity-40`, label `Unlink`) visible when `t.invoiceNumbers.length > 0 || t.expenseLinked`, calling `unlinkTransaction(t.id)`. Placement mirrors the receipt actions EXACTLY: in `renderEditRow`'s actions block (`:1083-1117`) for editable rows, and inline on the display row with `e.stopPropagation()` for non-editable (reconciled/transfer) rows the way Remove receipt already surfaces there (`:1199-1206`) — reconciled rows must be unlinkable (carve-out).

- [ ] **Step 1:** Page fetches + row mapping + badge.
- [ ] **Step 2:** Register chip, receipt fallback, Unlink.
- [ ] **Step 3:** Gates: `npm test`, cold tsc, `npm run build`.
- [ ] **Step 4:** Commit: `feat: register shows links; Matches badge`.

---

## Task 8: Invoice detail — paid date + deposit line

**Files:**
- Modify: `app/invoices/[id]/page.tsx`

**Tier:** cheapest (exact edits below).

- [ ] **Step 1:** Add `paid_at` to the invoice select (`:26-37`) and to the hand-written cast type (`:67-90`): `paid_at: string | null`.
- [ ] **Step 2:** Add a fourth query to the existing `Promise.all` (`:25-54`) fetching the paying deposit:

```ts
      supabase
        .from('ledger_transaction_invoices')
        .select('ledger_transactions(date, payee)')
        .eq('invoice_id', id),
```

- [ ] **Step 3:** In the status line ternary (`:274-283`), add the paid branch ahead of the fallthrough:

```tsx
        : s === 'paid' && inv.paid_at
          ? `Paid ${formatDateShort(inv.paid_at)}`
          : STATUS_META[s].label
```

  and beneath that `<p>`, inside the same right-aligned div:

```tsx
  {deposit && (
    <p className="text-xs text-muted mt-1">
      Bank deposit · {formatDateShort(deposit.date)}
    </p>
  )}
```

  where `deposit` is the first row's embedded transaction (or null). Add `formatDateShort` to the `lib/dates` import if absent.
- [ ] **Step 4:** Gates: cold tsc, `npm run build`. Commit: `feat: invoice shows paid date and its deposit`.

---

## Task 9: Docs, final review, ship

**Files:**
- Modify: `CLAUDE.md`, `docs/BACKLOG.md`
- Modify (postscript only): `docs/superpowers/specs/2026-08-18-bookkeeping-module-reference.md`

**Tier:** controller-direct (docs), then the top model for the whole-branch review (money code — Dan's standing directive).

- [ ] **Step 1 — docs:** CLAUDE.md: money map header → 0027–0032; add the bridge to current state (links are audit metadata — the third reconciled carve-out; receipt display-time join rule; `paid_at` written only by deposit-accept and Mark Paid). BACKLOG: remove the bridge from "remaining phases"; add a note that the pre-existing, still-unused `payments` table (0001) was deliberately left untouched — it is the natural home for a future partial-payments wave; the forecast item's `paid_at` dependency is now satisfied. Reference spec: one-line postscript — phase 3 built (0032), link tables instead of the sketched `matched_transaction_id`.
- [ ] **Step 2 — final review:** whole-branch adversarial review on the most capable model (`review-package MERGE_BASE HEAD`), lens: the Global Constraints above, especially over-sum refusal, unlink status restoration, RLS/ownership on both sides of every link write, the no-copy receipt rule, and that no client-facing surface gained link data. ONE fix subagent for the complete findings list.
- [ ] **Step 3 — end-to-end verification on dev (browser pane, sandbox data):**
  1. Create + send an invoice for a sandbox show (or reuse one in `sent`).
  2. Register: add a manual income row matching its total, dated after send.
  3. `/money/matches`: the proposal appears; Accept → invoice shows Paid + date + deposit line; register row shows the `#N` chip and (single-show invoice) the show chip.
  4. Unlink from the register → invoice back to `sent`, `paid_at` gone, chip gone.
  5. Expense side: add two register charges (`UBER EATS` −$33.25, `UBER EATS TIP` −$7.00) beside a $40.25 sandbox show expense with a receipt → the sum proposal appears with its evidence line; Accept → both rows show the show chip and the receipt icon (view opens the expense's receipt); Unlink either row → the whole group dissolves (BOTH rows lose their link — verify the receipt icon and Unlink disappear from the other row too).
  6. Dismiss a proposal → gone; reload → still gone.
  7. Mark a different sent invoice paid by hand → `paid_at` = today; matching deposit still proposed; accept corrects the date.
- [ ] **Step 4 — SHIP (order is non-negotiable):**
  1. `npm run db:migrate -- --prod` (0032; read the project-ref banner).
  2. Merge to main, push (Vercel deploys).
  3. Prod smoke: open `/money/matches` on billing.theaudiosmith.com — expect historical backfill proposals (the 2026 deposits meeting their invoices); tell Dan accept-all is safe for `high` cards and that this back-links his year.

---

## Execution notes

- Work on a feature branch (e.g. `bridge`) — never directly on main.
- SDD per house process: fresh implementer per task (tiers above), task review each, ledger updates in `.superpowers/sdd/progress.md`, opus final review only.
- The OFX import path (`lib/ledgerImport.ts`, `importOfx`) is NOT touched anywhere in this plan — post-import discovery happens via the `/money` badge on refresh.
- `payments` (0001) stays untouched and unused this wave — deliberate, recorded in Task 9's BACKLOG note.

## Verification

Covered by Task 9 Step 3 (browser walkthrough on dev sandbox) and Step 4.3 (prod smoke). Automated: `npm test` (new `ledgerMatch` suite), cold `npx tsc --noEmit`, `npm run build` — all green before every commit that touches code.
