# Settling an invoice paid for the wrong amount — design

Dan, 2026-08-25: *"Invoice #385 was paid. But they messed up the amount when
they entered it in and the check is $10 short. I am not going to worry about
getting the $10, but I need a way to correct for this in the program."*

Approved same day. His four decisions:

1. **From the invoice**, not the Matches queue — he is looking at #385
   wondering why it still says unpaid.
2. **Always show the gap, one confirm.** No thresholds: any difference is
   stated plainly and one click settles it.
3. **Handle overpayment too**, by the same mechanism.
4. **The invoice is the only place it shows.** No report line, no yearly
   total.

## The accounting, first

On cash basis (which his CPA should confirm) the books need NO correction:
income is what landed, the ledger already records the true deposit, and the
$10 was never income. There is nothing to write off and nothing that reaches
the year-end figures. What is missing is purely a bookkeeping affordance —
a way to say *this invoice is settled* when the deposit does not match to
the penny. That is the whole scope.

## Why this needs no schema change

`ledger_transaction_invoices` already records which deposit paid which
invoice, so "how much actually arrived" is the linked deposit's own amount.
The shortfall is DERIVED, never stored — one source of truth that cannot
drift from the links.

Two existing facts make the derivation simple:

- `acceptIncomeMatch` refuses to link an invoice that already has a link
  ("a link means paid in full, and an invoice cannot be paid in full
  twice"), so an invoice carries **at most one** link.
- A deposit may cover up to 3 invoices, but the matcher only ever proposes
  such a combo when the totals sum EXACTLY. So a combo link contributes
  exactly this invoice's own total.

## Architecture

### `lib/invoicePayment.ts` (new, pure)

```ts
/** One invoice's link, as little of it as the math needs. */
export type SettlementLink = {
  /** The linked deposit's own amount, positive cents. */
  amountCents: number
  /** How many invoices that deposit covers (1..3). */
  invoiceCount: number
}

export type Settlement = {
  paidCents: number
  /** paid − total. Negative = short, positive = over, 0 = exact. */
  deltaCents: number
  state: 'unpaid' | 'exact' | 'short' | 'over'
}

export function settlementFor(totalCents: number, link: SettlementLink | null): Settlement
```

Rules, all of them:

- `link === null` → `{ paidCents: 0, deltaCents: -totalCents, state: 'unpaid' }`.
- `invoiceCount === 1` → `paidCents = link.amountCents`; delta is the
  difference; state is short/over/exact by its sign.
- `invoiceCount > 1` (a combo) → `paidCents = totalCents`, delta 0, state
  `'exact'`. The combo is exact by construction; attributing the whole
  deposit to one of its invoices would invent a huge phantom overpayment.

### The invoice page (`app/invoices/[id]/page.tsx`)

Its existing link query selects only `ledger_transactions(date)` with
`.limit(1)`. It widens to `ledger_transactions(id, date, amount_cents)` and
also reads that transaction's own link count (a second small query, run only
when a link exists) so `settlementFor` has its `invoiceCount`.

Where the page already renders `Bank deposit · <date>`, it gains the
settlement when the state is short or over:
`Bank deposit · Aug 21 · Paid $590.00 · $10.00 short`. An exact settlement
renders exactly as it does today — no new noise on the normal case.

### "Link a payment" (new, `components/LinkPaymentPanel.tsx`)

Rendered when the invoice has **no link** and its status is `sent` or
`paid`. Including `paid` is deliberate and useful: the invoices Dan
hand-marked paid during the 2026-08-21 cleanup carry a `paid_at` of that
day rather than a real payment date, and this lets him attach the true
deposit after the fact. `draft` and `void` never show it.

The page supplies the candidates: the 40 most recent `kind = 'income'`
deposits with `amount_cents > 0`, minus any already linked to an invoice or
an expense (fetched as ids from both link tables and filtered in memory —
the same fetch-then-filter idiom the rest of `/money` uses, since PostgREST
has no clean NOT IN subquery). Each row shows date, payee and amount.

Picking one reveals the comparison and a single confirm:

- exact → `Settle #385 — $600.00`
- short → `$10.00 short of $600.00. Settle #385 anyway?`
- over  → `$10.00 over $600.00. Settle #385 anyway?`

Confirm calls the EXISTING `acceptIncomeMatch({ transactionId, invoiceIds:
[invoiceId] })` — no new server action. That action already validates the
row is a real deposit, refuses a double link, requires the invoice be sent
or paid, writes the link, and sets `status: 'paid'` with `paid_at` = the
deposit's own date. It deliberately never compared amounts, which is
precisely what makes this work.

### Getting back out

Already exists, unchanged: unlinking the transaction in the register
restores the invoice to `sent`. A mis-picked deposit is one unlink away, so
the confirm needs no undo of its own.

## Testing

`lib/invoicePayment.ts` is where the logic is proven (`node --test`):
unpaid; exact; short by $10; over by $10; a combo link (invoiceCount 3)
reading exact rather than a phantom overpayment; a $0 total guarded; and
that `deltaCents` sign is the ONLY thing distinguishing short from over.
Plus the usual gates and a browser walkthrough against a sandbox invoice
settled $10 short, then unlinked to prove the way back.

## Out of scope (deliberate)

- **True partial payments** — "they paid half, more is coming" — stays on
  the BACKLOG. This feature means *settled, done*; conflating the two would
  make "paid" ambiguous.
- Mismatched COMBOS. The invoice page only ever sends one invoice, and the
  Matches queue keeps proposing exact matches only.
- Any report, yearly total, or CPA-export line (his decision 4).
- The dormant `paid_cents` plumbing in `lib/status.ts` stays dormant:
  `displayStatus` returns early for a stored `paid` status, so waking it
  would change nothing here.
