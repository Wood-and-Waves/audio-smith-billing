# Split transactions & pending imports — design

**Status:** approved by Dan, 2026-08-24 (design conversation + his YNAB
split-editor screenshot on file).
**Wave C** of his eleven walkthrough findings (items 10 and 11) — the two
"a transaction the model can't represent" gaps, deferred until Waves A and B
landed. Both are now in.

## Why

- **Splits:** Dan has real bank rows whose pieces belong to different
  categories — the defining example is the 3/5 Online Realtime Transfer,
  which YNAB splits into Owner Pay plus $400 Temporary Transfer. Without
  splits those rows cannot reconcile, and that $400 is the last accepted
  variance between the two books. The example also settles the hardest
  design question: legs cross KINDS (owner_pay + expense), so per-leg kind
  is a day-one requirement — and Wave B's `deriveKind` makes it free: a leg
  needs only a category and an amount; kind derives per leg through the
  same rule the register uses.
- **Pending:** "Pending transactions should not impact budget unless I add
  them" (his words, with YNAB's Enter Now flow as the reference). His
  chosen balance semantics, option 1 of two offered: **pending counts in
  the working and cleared balances** (the register matches Chase) **and in
  nothing category-shaped** — budget, P&L, reports, forecast, parity — until
  entered. "There should be a clear delineation between pending and
  cleared."

## Splits — model

New table, additive:

```sql
create table ledger_transaction_splits (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references ledger_transactions(id) on delete cascade,
  category_id    uuid references ledger_categories(id) on delete restrict,
  -- Signed, same sign as the parent; a trigger enforces sum(legs) =
  -- parent.amount_cents and >= 2 legs whenever any leg exists.
  amount_cents   bigint not null,
  -- Stored like the parent's own kind, written through deriveKind(category,
  -- direction) per leg — the $400 case is one owner_pay leg + one expense leg.
  kind           text not null check (kind in ('income','expense','owner_pay')),
  note           text,
  created_at     timestamptz not null default now()
);
```

- **The parent stays one row** — date, payee, total, cleared, `import_id`,
  receipt, invoice/expense links all untouched. A split parent's own
  `category_id` becomes null and its category cell renders
  "Split (N categories)" (YNAB: "Split (Multiple Categories)…").
- **Integrity is a trigger, not convention:** whenever a transaction has
  any legs — at least two, same sign as the parent, amounts summing exactly
  to the parent's. Editing the parent's amount with legs present is refused
  until the legs are re-balanced (edit the split, not the total).
- **Consumers:** only category-readers explode legs — budget activity
  (`buildBudget`'s txn assembly), P&L, spend-by-category, the CPA export.
  Balances, reconcile math, import dedupe, and the register's running
  balance never look at legs. Payee memory **skips split parents** — a
  split's payee maps to multiple categories by definition.
- Per-leg payee (YNAB has it) is deliberately OUT — the parent's payee is
  the bank's identity. Per-leg `note` is in.

## Splits — register UI (Dan's screenshot, adapted)

In the edit row, the category picker gains a pinned **Split…** row (the
`pinnedOptions` mechanism, again). Choosing it expands **leg rows inline
beneath the edit row, on the same live column template**: each leg = a
CategoryPicker in the category column, a note field in the memo column, and
outflow/inflow boxes in theirs; a − removes a leg, "＋ Add another split"
appends one; an **Amount remaining** row runs live in the amount columns;
Save is disabled until the remainder is exactly zero. Cancel collapses with
nothing written. An existing split row re-opens the same editor seeded with
its legs; deleting all legs un-splits. Phone: the same editor in the stacked
idiom.

## Pending — model

- `ledger_transactions.entered_at timestamptz` — **null = pending**. The
  migration backfills `entered_at = created_at` for every existing row;
  hand-entered rows are entered at insert; **the OFX importer inserts
  `entered_at` null**.
- **Balance semantics (Dan's option 1):** pending rows count in working AND
  cleared balances. They are excluded from: `buildBudget`'s transactions
  (both activity and the income/RTA bucket), P&L, spend-by-category,
  monthly reports, the forecast's ledger reads, the CPA export, and
  `npm run parity`'s app side.
- **Enter Now** sets `entered_at`. **Enter All** for the queue. **Reject**
  deletes the row and writes a tombstone —
  `ledger_import_rejections (owner_id, account_id, import_id)` — which the
  import's dedupe consults, or next month's file resurrects everything
  rejected. (The tombstone is the invisible requirement; without it Reject
  is a one-month illusion.)
- Categorizing while pending is allowed and expected — payee memory already
  pre-fills on import; Enter Now is usually the only tap. Splitting while
  pending is allowed; the split editor's Save doubles as **Approve** when
  the row is pending (his screenshot's own button).
- **Reconcile refuses while pending rows exist at or before the statement
  date**: they are in the cleared balance but unapproved — locking them
  would be dishonest, excluding them would break the statement math. The
  message says what to do: enter or reject them first.

## Register UI — pending

A **Pending section pinned above the dated list** (his YNAB screenshot's
"Pending Transactions" group): its own header with a count, rows muted with
a PENDING chip, per-row Enter Now, an Enter All in the section header.
Phone gets the same section (the phone view's existing "Pending" group —
which is actually uncleared — renames to avoid the collision: the new
section owns the word "Pending"; the uncleared group becomes "Uncleared").

## Out of scope, named

Per-leg payees; splitting hand-entered rows at CREATE time (create then
edit-split — one step removed, rarely needed); splits on invoice-linked
expense rows beyond what the links already do (links attach to the parent);
pending for hand-entered rows (they are entered by definition); any change
to `lib/budget.ts`'s formulas (the txn ASSEMBLY changes — explode legs,
drop pending — the arithmetic does not).

## What this unlocks on day one

Dan splits the 3/5 row properly — the last accepted variance dies, and
`npm run parity` should read exactly zero with no asterisks beyond the
Novo penny. His next statement import lands as a reviewable queue instead
of instantly moving the budget.

## Testing

Pure-lib TDD for the leg/pending decisions (sum/sign/count validation,
consumer explosion, the reconcile refusal predicate); trigger proven by
writing the violating states directly; browser walkthrough of the $400
split end to end including parity; import rehearsed on dev with a real OFX
against the tombstone path.
