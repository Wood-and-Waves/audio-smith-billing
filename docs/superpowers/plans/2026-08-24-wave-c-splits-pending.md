# Wave C — Splits & Pending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split transactions (cross-kind legs, per the $400 defining example)
and pending imports (Enter Now / Reject with tombstones), per the approved
spec `docs/superpowers/specs/2026-08-24-splits-and-pending-design.md` —
read it before any task; it is the contract, including Dan's balance
semantics and the register UI adapted from his YNAB screenshot.

**Ship authorization (Dan, 2026-08-24): full approval — merge and push to
main when the wave passes every gate and review.** Ship order stays law:
migrations 0042 AND 0043 to prod FIRST (0043 = the RPC's anon-EXECUTE revoke, the 0024 precedent), then merge/push, then smoke + `npm run parity`.

## Global Constraints

- Branch `splits-pending`. Migration `0042` ADDITIVE ONLY, immutable once
  applied; dev only until the ship step.
- **`lib/budget.ts` untouched.** The txn ASSEMBLY feeding it changes
  (explode legs, drop pending) — in the pages/scripts, via ONE shared pure
  helper, never by editing the arithmetic. Tripwire at the gate: the parity
  and validator checks.
- **Leg integrity lives in Postgres**: a deferrable constraint trigger —
  whenever a transaction has any legs: ≥2, each leg's sign matching the
  parent's, amounts summing exactly to the parent's `amount_cents`. Leg
  replacement is an RPC (`replace_transaction_splits`) so delete+insert is
  one transaction (the `allocate_invoice_number`/`reconcile` precedent);
  editing a split parent's amount is refused while legs exist.
- Per-leg `kind` written through `deriveKind(category, direction)` — the
  same rule, no second derivation path. Legs may be uncategorized
  (`category_id` null → kind from direction alone, expense/income).
- **Pending = `entered_at IS NULL`.** Counts in working AND cleared
  balances; excluded from budget activity AND the income/RTA bucket, P&L,
  spend-by-category, monthly reports, CPA export, forecast ledger reads,
  and `scripts/parity/ynab-live.mjs`. Migration backfills
  `entered_at = created_at` on every existing row; hand-entry paths set it;
  ONLY the OFX import inserts null.
- **Reject = tombstone first, then delete** (that order — a crash between
  the two must leave the tombstone, not the resurrection). Tombstones in
  `ledger_import_rejections (owner_id, account_id, import_id)`; the import
  planner treats tombstoned ids as existing.
- **Reconcile refuses while pending rows exist dated at or before the
  statement date** — message tells Dan to enter or reject them first.
- Payee memory skips split parents entirely (learning and applying).
  The same-payee sweep and `setTransactionCategory` refuse split parents
  (their category is their legs).
- Server actions: presence-only auth, ownership walks for caller-supplied
  ids (`categoryOwnedByCaller` idiom per leg), fail-closed guard reads,
  structured results, `revalidatePath('/money')`.
- Money integer cents; `lib/*.ts` pure; theme tokens; every unbounded read
  pages. Gates per commit: `npm test`, cold tsc, `npm run build`.

## Model tiering
T1 mid (migration + trigger + RPC). T2 mid (pure lib, TDD). T3 mid
(actions). T4 mid-high (register UI). T5 mid (consumers). T6 cheap (docs).
Final review top model.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/sql/migrations/0042_splits_and_pending.sql` | Legs table + trigger + RPC, rejections table, `entered_at` |
| `lib/ledgerSplits.ts` (new) | Pure: leg validation, txn→category-lines explosion (splits + pending filter), reconcile-refusal predicate |
| `scripts/test/ledgerSplits.test.ts` (new) | Pins it |
| `app/money/actions.ts` | `replaceSplits`, `unsplitTransaction`, `enterTransactions`, `rejectTransaction`; importer inserts pending + consults tombstones; split-parent refusals in `setTransactionCategory`/sweep/`updateLedgerTransaction` amount edit |
| `components/MoneyRegister.tsx` + `components/SplitEditor.tsx` (new) | Split display + inline leg editor; Pending section, Enter Now/All, Reject; phone "Uncleared" rename |
| `components/CategoryPicker.tsx` | pinned `Split…` row (edit-row call site only) |
| Budget/`/money` pages, `lib/ledgerReports.ts` consumers, forecast reads, `scripts/parity/ynab-live.mjs` | Explode legs + drop pending via the ONE helper |
| `CLAUDE.md`, `docs/BACKLOG.md` | Doctrine + closure |

---

## Task 1: Migration 0042

`ledger_transaction_splits` per the spec's DDL (+ RLS/grants per the 0038
pattern; indexes on `(owner_id)` and `(transaction_id)`).
`ledger_import_rejections (owner_id, account_id, import_id, created_at)`,
unique on `(owner_id, account_id, import_id)`, same RLS.
`alter table ledger_transactions add column entered_at timestamptz` +
backfill `update … set entered_at = created_at` + comment (null = pending,
the one axis the register's Pending section reads).
The deferrable constraint trigger (legs sum/count/sign vs parent; fires on
legs INSERT/UPDATE/DELETE and on parent amount UPDATE when legs exist —
refuse) and `replace_transaction_splits(p_transaction_id uuid, p_legs jsonb)
security definer` (ownership-checked inside via `auth.uid()`, `set
search_path = public, pg_temp`, revoke from public/anon, grant to
authenticated) doing delete-then-insert in one transaction.
- [ ] Apply to DEV; verify via information_schema + PROVE the trigger by
  writing violating states directly (1 leg; wrong sum; wrong sign; parent
  amount edit with legs) — each must refuse; a valid 2-leg replace via the
  RPC must succeed. Commit.

## Task 2: `lib/ledgerSplits.ts` (TDD)

```ts
export type SplitLegInput = { categoryId: string | null; amountCents: number; note?: string | null }
export function validateLegs(parentAmountCents: number, legs: SplitLegInput[]): string | null  // message or ok
export type CategoryLine = { month: string; categoryId: string | null; amountCents: number }
export type TxnForExplode = { month: string; categoryId: string | null; amountCents: number; enteredAt: string | null; legs?: { categoryId: string | null; amountCents: number }[] }
export function explodeForCategories(txns: TxnForExplode[]): CategoryLine[]
export function pendingBlocksReconcile(pending: { date: string }[], statementDate: string): boolean
```
- `validateLegs`: ≥2, integers, no zero legs, signs match parent, sum
  exact; mirrors the trigger so the UI refuses before Postgres does.
- `explodeForCategories`: drops pending rows entirely; a parent with legs
  yields its legs (parent's own line suppressed); otherwise the row itself.
  THIS is the one helper every consumer calls.
- [ ] TDD (sum off by one cent; sign mix; single leg; pending dropped from
  both activity and null-category income lines; split parent suppressed;
  unsplit passthrough byte-identical) → implement → gates → commit.

## Task 3: Actions + importer

- `replaceSplits(transactionId, legs)` — ownership of the txn (walk), each
  leg's category (walk, assignable), `validateLegs`, per-leg kind via
  `deriveKind` from the parent's direction, then the RPC. `unsplitTransaction`
  = RPC with empty legs (trigger allows zero legs).
- `enterTransactions(ids[])` (Enter Now = one id; Enter All = the queue) —
  ownership-scoped update setting `entered_at = now()` where null.
- `rejectTransaction(id)` — must be pending + imported; tombstone INSERT
  first, delete second; both ownership-walked.
- Importer: inserts `entered_at: null`; `fetchAllLedgerTransactions`-style
  existing-set gains tombstoned ids (fetch rejections, feed `planImport`'s
  existing list — read `lib/ledgerImport.ts:108` first; the CLEAN change is
  adding tombstone ids to the `existing` array it already dedupes against).
- Split-parent refusals: `setTransactionCategory` + sweep + the edit path's
  amount change (structured messages naming the split).
- Hand-entry paths (`addLedgerTransaction`, expense→ledger writes if any)
  set `entered_at`.
- [ ] Gates → commit. (Actions stay thin; decisions live in Task 2's lib.)

## Task 4: Register UI

- **SplitEditor** (new client component): rendered inline beneath the edit
  row on the SAME live `gridTemplate` — per leg: CategoryPicker (category
  column), note input (memo column), outflow/inflow boxes (theirs; sign
  fixed to the parent's direction — the opposite box disabled), − remove;
  "＋ Add another split"; a live **Amount remaining** line in the amount
  columns; Save disabled until remaining is exactly zero (`parseUSDMath`
  per box). Cancel collapses unchanged. Re-opening an existing split seeds
  its legs; removing all legs + Save = unsplit. **When the row is pending,
  the Save button reads Approve and also enters it** (Dan's screenshot).
- Category cell of a split parent renders `Split (N)`; its inline picker is
  replaced by an "Edit split" affordance opening the editor.
- The edit-row CategoryPicker gains pinned `Split…` (opens the editor with
  the current category as leg 1's seed); the inline/uncategorized picker
  does NOT get it.
- **Pending section** pinned above the dated list, own header + count +
  Enter All; rows muted with a PENDING chip; per-row Enter Now + Reject
  (Reject confirms inline — it deletes). Phone: same section; the existing
  uncleared group renames to "Uncleared".
- [ ] Browser-verify on dev (split the seeded TEST-show era data or a
  hand-made row; a pending import simulated by direct SQL `entered_at =
  null` on a test row — restore after): create/edit/unsplit a split incl.
  cross-kind; remainder math; Approve-on-pending; Enter Now/All; Reject +
  tombstone visible in the table; reconcile refusal message. Gates → commit.

## Task 5: Consumers

Through `explodeForCategories` ONLY: `app/money/budget/page.tsx`'s txn
assembly, `app/money/page.tsx`'s balance-map assembly, `lib/ledgerReports.ts`
call sites (P&L, spend-by-category, monthly — the lib may gain the helper
call or the pages pre-explode; keep ONE explosion site per read path),
forecast's ledger reads, `scripts/parity/ynab-live.mjs`. Working/cleared
balance paths and reconcile math explicitly NOT filtered by `entered_at`
(Dan's option 1) — add the reconcile REFUSAL (Task 2's predicate) to the
reconcile action instead. CPA export path: legs.
- [ ] Gates; re-run `npm run parity` against prod (unchanged data — must
  still read 25/25 + Novo line, proving the parity script's explosion is a
  no-op on unsplit data). Commit.

## Task 6: Docs

CLAUDE.md: splits doctrine (legs sum trigger, one explosion helper, payee
memory skips splits, pending axis + balance semantics, reconcile refusal).
BACKLOG: Wave C shipped; the $400 variance entry updated to "fixable in-app
— split the 3/5 row"; residuals. Commit.

## Task 7: Final review + ship (controller)

- [ ] Whole-branch review, top model: every Global Constraint; hardest at
  the trigger/RPC (can any path write unbalanced legs), the explosion
  helper's single-source rule, pending's exclusion completeness (grep every
  `from('ledger_transactions')` reader and classify), tombstone order, and
  the register's split/pending UI states.
- [ ] Fix wave if needed → re-review to READY.
- [ ] Controller walkthrough + parity.
- [ ] **Ship (pre-authorized):** 0042+0043 to PROD first → merge → push → smoke
  → `npm run parity` → report to Dan, including how to split the 3/5 row.

## Verification
Gates per commit; trigger proven by violation; parity before AND after
ship; the walkthrough's cross-kind split is the acceptance test.
