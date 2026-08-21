# Invoice / expense auto-bridge — design

*Phase 3 of the bookkeeping module
(`docs/superpowers/specs/2026-08-18-bookkeeping-module-reference.md`). The
ledger spine and the payoff phases are live; this is the seam between the
billing half of the app and the Money half.*

## The problem

Today the two halves don't know about each other. Dan invoices Clinique for
$2,400 in the billing half; five weeks later a $2,400 ACH lands in Chase and
arrives in the register as an uncategorized deposit with a bank descriptor for
a payee. The same money is recorded twice by two systems that never speak, and
the second recording carries none of the first one's meaning — no client, no
show, no invoice number. Expenses are worse: a receipt captured at the show
sits in `expenses` with its photo, while the matching card charge sits in the
ledger with neither.

The bridge closes that seam without double-booking a cent.

## Decisions (Dan, 2026-08-21)

Four questions were put to Dan directly; his answers are the spine of this
design.

**1. The bank deposit creates the income, not the invoice.** Nothing posts to
the register until money actually lands. Marking an invoice paid does not write
a ledger row, and sending one certainly does not.

*Why not accrual:* the ledger balance must equal the bank balance — that is the
whole premise of reconcile — and Dan's CPA files the 1120-S on cash basis.
Posting on send would put money in the register that isn't in the bank.

*Why not "Mark Paid writes a manual row":* it works (the existing adopt-on-
import matcher would absorb it), but it makes Mark Paid a chore Dan has to
remember, and the adopt window is ±10 days against a pay lag of thirty-plus.
A missed window means two rows for one payment.

*Bonus:* the deposit's own date becomes the payment date, which is where
`invoices.paid_at` comes from — a column that does not exist today, and that
the cash-flow forecast's per-client pay-lag learning silently assumed.

**2. Expenses link to their bank charges; nothing is copied.** The expense
record stays the billing truth, the bank row stays the money truth, and a link
joins them. Because no amount is ever copied, 1→N falls out for free.

*Dan's real case:* one $40.25 Uber Eats show expense posted at Chase as a
$33.25 order plus a $7.00 tip. A copy-into-the-ledger design produces three
rows and a manual cleanup; a link design produces two link rows and a matcher
that can say "these two sum to your expense."

**3. Nothing applies without a click.** Proposed matches collect in a review
queue at `/money/matches`; the import itself is untouched. The OFX import's
dedupe-and-adopt logic was hard won (a silent GEN double-import and a 1000-row
truncation were both caught in review) and this design does not reopen it. The
queue also has no time pressure — it can be cleared later, from the couch.

**4. The tax set-aside stays out.** Accepting an income match does not fund the
Taxes envelope. Two reasons: the set-aside rate is still unanswered CPA
homework, and a deposit is *gross revenue* while the set-aside was designed
against *per-show profit* — so any figure computed here would be the wrong one.
It belongs with the per-show profit work, where the right base number exists.

## Data model

One additive migration (0032). No existing column changes; no existing code
path changes shape.

### `invoices.paid_at date`

Nullable. The date money landed, distinct from `sent_at`.

- Accepting an income match stamps it from the **bank row's own date** — the
  authoritative answer, since that is when the money actually landed.
- `setInvoiceStatus(id, 'paid')` stamps **today**, so the column never lies
  about an invoice Dan marks paid by hand. No date picker: keeping
  `MarkPaidButton` a single click is worth more than a date that the deposit
  match will correct anyway.
- Setting any other status, and unlinking, both clear it.

`setInvoiceStatus` refuses to touch `sent_at` on purpose — a re-stamp would
move the real send date and the reminder clock. `paid_at` is the opposite
case: it is *only* meaningful when written, so both paths that know money
arrived write it, and the more authoritative one (the bank) wins.

### `ledger_transaction_invoices`

```
id             uuid pk
owner_id       uuid not null → auth.users
transaction_id uuid not null → ledger_transactions on delete cascade
invoice_id     uuid not null → invoices on delete cascade
created_at     timestamptz not null default now()
unique (transaction_id, invoice_id)
```

### `ledger_transaction_expenses`

```
id             uuid pk
owner_id       uuid not null → auth.users
transaction_id uuid not null → ledger_transactions on delete cascade
expense_id     uuid not null → expenses on delete cascade
created_at     timestamptz not null default now()
unique (transaction_id, expense_id)
```

### `ledger_match_dismissals`

```
id             uuid pk
owner_id       uuid not null → auth.users
transaction_id uuid not null → ledger_transactions on delete cascade
invoice_id     uuid          → invoices on delete cascade
expense_id     uuid          → expenses on delete cascade
created_at     timestamptz not null default now()
check (num_nonnulls(invoice_id, expense_id) = 1)
unique (transaction_id, invoice_id)
unique (transaction_id, expense_id)
```

Proposals are computed fresh on every visit — the matcher is pure and holds no
state — so without this table a rejected guess returns after every import.
This is a **suppression list**, not a relationship, which is why the
discriminated shape is honest here where it would not be for the links.
Dismissing a sum proposal writes one row per target, and any dismissed pair
suppresses the whole group.

All three tables get the standard owner-scoped RLS policy (`owner_id =
auth.uid()` for all, anon revoked) and an index on `transaction_id` plus one
on the far side.

**Why link tables and not columns on `ledger_transactions`.** A column was the
first design and Dan killed it with one fact: Streamline sometimes pays two
invoices with one check. A single `invoice_id` cannot represent that. Link
tables carry both directions natively — N invoices per deposit, N bank rows per
expense.

**Why no `amount_cents` on the links.** The invoice already knows its total and
the bank row already knows its own, so a link only has to assert *these belong
together*. Consequently **partial payments are out of scope**: a link means
paid in full. If a client ever short-pays, a nullable `amount_cents` (null =
in full) is a clean additive follow-up.

## The matcher

Pure logic in `lib/ledgerMatch.ts`, following the `ledgerImport.ts` /
`ledgerRules.ts` model: no `@/` imports, no JSX, relative `.ts` imports,
tested under `npm test`. It takes plain arrays in and returns proposals out.
It **never writes** — proposal generation and application are separate, the
way `planImport` is separate from applying an import.

### Income candidates

For each ledger row that is an unlinked positive amount:

An invoice is a **candidate** when it has no linked transaction and its status
is `sent` **or** `paid`. Including `paid` is deliberate: an invoice Dan marked
paid by hand still has a deposit arriving, and that deposit still needs its
client, its show and its true date. Accepting the match corrects `paid_at`
from today's guess to the bank's date.

1. **Exact single** — amount equals one candidate invoice's `total_cents`,
   dated on or after that invoice's `sent_at`.
2. **Exact sum** — amount equals the sum of two or three candidate invoices
   belonging to the **same client**, all sent on or before the deposit date.
   (Streamline.) Capped at three to keep the combinatorics honest and the
   proposals legible.
3. Payee text similarity to the client name **raises confidence but never
   creates a match**. Bank descriptors are unreliable; the amount is the
   evidence. Similarity is normalized token overlap (lowercased,
   punctuation stripped) — loose is safe, because it only ranks.

### Expense candidates

For each ledger row that is an unlinked negative amount:

1. **Exact single** — absolute amount equals an unlinked `expenses.amount_cents`
   whose `spent_on` is within ±10 days of the bank date. (±10 matches the
   window the adopt-a-manual-twin matcher already uses.)
2. **Exact sum** — this row plus other unlinked charges sum to one expense's
   amount. (Uber Eats + tip.) Grouping is load-bearing here rather than
   merely ranking, so it is pinned: charges group when their normalized
   payees share a leading token (`uber eats` / `uber eats tip`) and their
   dates fall within **±3 days** of each other, with the group's span still
   inside the expense's ±10-day window. Groups cap at three rows.

Non-reimbursable (`billable = false`) expenses are matched exactly like
billable ones. Dan's own per-diem meals are still deductible business spending
— the completeness-of-capture goal is the whole point. They simply never reach
an invoice, which the existing `expenseLines` filter already guarantees.

### Confidence

Since nothing auto-applies, confidence only orders the queue and decides what
an "accept all" pre-selects. Exact single amount plus a payee that resembles
the counterparty is high; a sum match, or an amount match with an unrelated
payee, is lower and never pre-selected.

### Ambiguity

If a deposit matches two different invoices of identical value, the queue shows
both and pre-selects neither. The matcher never guesses between equals.

## Applying a match

Server actions in `app/money/actions.ts`, owner-scoped and `belongsToCaller`-
checked on **both** sides of every link (Postgres FK checks bypass RLS — the
established trap in this codebase).

**Accepting an income match:**

- Insert the link row(s).
- Set each linked invoice to `status='paid'`, `paid_at` = the bank row's date.
- Fill `payee` with the client name **if it is blank** — never overwrite text
  Dan typed.
- Set `show_id` **only when the invoice covers exactly one show**, otherwise
  leave it null.
- Leave `category_id` alone. Income is tracked per client via the payee in
  Dan's chart; inventing an income category here would fight that.

> **The multi-show wrinkle.** An invoice can bill several shows
> (`billShows`), but a ledger row has one `show_id`. Rather than pick one or
> add a second show-tag mechanism, **per-show revenue reads from the invoice,
> not from ledger show tags.** The tag is a convenience for the single-show
> case only. This is the same anti-double-count rule the expense side needs.

**Accepting an expense match:**

- Insert the link row(s).
- Set `show_id` from the expense (always exactly one — `expenses.show_id` is
  `not null`).
- Surface the expense's receipt on the bank row in the register.
- **Leave `category_id` alone.** Expense categories are four fixed billing
  labels (meals/rides/baggage/other); ledger categories are Dan's YNAB chart.
  They are different vocabularies, and guessing a mapping is inventing one
  nobody asked for. Deferred until the CPA answers homework question 1 and all
  three charts can be reconciled at once — tracked in `docs/BACKLOG.md`.

**Unlinking** (the undo):

- Delete the link row(s).
- Return each affected invoice to `status='sent'` with `paid_at` cleared —
  unless another transaction still links to it.
- **Leave `show_id` and `payee` as they are.** Once written they are Dan's
  data, and edit mode already clears them. Reverting them risks wiping a hand
  edit made after the accept.

### Reconciled rows: a third carve-out

Reconciled ledger rows are locked server-side except for two carve-outs, both
audit metadata that moves no money: categorization and receipts. **Linking
joins them.** A link moves no money and changes no amount; without the carve-
out, a match against a reconciled bank row would be unacceptable forever —
and by the time Dan reconciles a month, its deposits are exactly the ones he'd
want to attach to invoices. Unlinking is allowed on reconciled rows for the
same reason. `paid_at` and invoice status live on the invoice, not the ledger,
so nothing about reconcile's own integrity is touched.

## Screens

**`/money/matches`** — the queue. Grouped income first, then expenses. Each
proposal is one card: the bank row on one side, the invoice(s) or expense on
the other, the evidence stated plainly ("$33.25 + $7.00 = $40.25"), and
Accept / Dismiss. Dismiss is per-proposal and remembered, so a rejected guess
does not come back after every import. Accept-all takes the high-confidence
set only.

**`/money`** — a count badge linking to the queue when proposals are waiting.

**The register** — a linked row shows its invoice number or its show, and the
expense's receipt appears in the existing receipt column. Unlink lives in the
row's edit mode, next to delete.

**Invoice detail** — a paid invoice shows the deposit that paid it, dated.

UI copy stays minimal per house rule; the evidence line is the explanation.

## Guards

- Owner-scoped RLS on both link tables, plus explicit `.eq('owner_id', …)` and
  `belongsToCaller` on both sides of every insert.
- Unique `(transaction_id, invoice_id)` and `(transaction_id, expense_id)`
  prevent double-linking.
- An invoice already linked to a different transaction is not offered as a
  candidate; the accept path re-checks server-side.
- Linked bank rows for one expense must not exceed the expense amount — the
  accept path refuses an over-sum.
- **Links never reach a client-facing surface.** Invoice PDFs, `/i/[token]`,
  `public_invoice`, `public_invoice_backup`, `buildBackupSnapshot` and the
  emails carry no link data, no ledger ids, and no bank descriptors. This
  joins the chokepoint list in CLAUDE.md.
- Any query summing or listing links pages with `.range()` — the 1000-row
  silent cap applies here as everywhere.

## Testing

Pure-lib tests in `scripts/test/ledgerMatch.test.ts`: exact single income;
Streamline's two-invoice sum; an invoice already marked paid by hand still
proposed; the Uber Eats 1→N expense sum; the ±3-day grouping and ±10-day
window boundaries; a group whose payees share no leading token not grouped;
identical-value ambiguity proposing both and pre-selecting neither;
already-linked rows and invoices never re-proposed; dismissed proposals not
returning; non-reimbursable expenses matched; payee similarity raising rank
but never creating a match.

Server actions stay untested by convention — their brains live in
`ledgerMatch.ts`.

## Out of scope

Tax set-aside funding. Partial payments. Expense→ledger category mapping.
Anything that applies without a click. A preview step for the OFX import.
`matched_transaction_id`, splits, and the import-batch table from the original
module reference remain unbuilt and unneeded here.

## Ship

Migration 0032 to prod **first**, then merge — the non-negotiable order.
