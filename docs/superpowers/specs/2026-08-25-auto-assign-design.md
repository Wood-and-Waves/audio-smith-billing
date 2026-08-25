# Auto-Assign (Underfunded) — design

Dan approved 2026-08-25, after three decisions made by him directly:

1. **Underfunded only.** No "Assigned Last Month", no averages, no reset
   flavors. The one button funds every target's `neededCents` this month.
2. **Assign it all anyway.** When Ready to Assign cannot cover the total,
   every category is still fully funded and RTA goes negative (red) — the
   YNAB quick-budget behavior he chose over stop-at-zero or refuse.
3. **One tap undoes the batch.** A small additive migration gives moves a
   `batch_id`; Undo on a batch head reverses the whole batch as a unit.

## What ships

**The button.** "Auto-assign $X" renders in the budget page's summary panel
beside the Underfunded line, only when `underfundedCents > 0`. One tap, no
confirmation (batch undo is the safety). Pending state "Assigning…", then
refresh. The figure on the button is display only — the server never
trusts it.

**The write.** One server action, `autoAssignUnderfunded(month)`:

- Validates `month` through `validBudgetMonth` exactly like the other move
  actions. `month` is the ONLY caller-supplied input.
- Recomputes the month server-side: the same fetches + `buildBudget`
  assembly the page uses (extracted to a shared module so there is one
  copy). The plan of moves comes from the server's own rows — category ids
  never cross the client boundary, so there is no caller-supplied id to
  walk for ownership; the fetches are owner-scoped already.
- The plan: every row with `neededCents > 0`, funded by exactly
  `neededCents`, from Ready to Assign (`from_category_id null`). Both
  target kinds — a monthly target's top-up and a by-date target's monthly
  share — exactly what the summary's Underfunded figure already sums.
- Hidden categories with targets still fund: hidden is presentation, the
  money is real (lib/budget.ts doctrine). Income-role categories cannot
  appear (targets are only settable on assignable categories).
- All moves land in ONE multi-row insert (single statement — atomic, no
  RPC needed), sharing a freshly minted `batch_id` and `note:
  'Auto-assign'`. (Shipped correction, final review 2026-08-25: the note
  is durable in the DATABASE; the Recent Moves list does not render it —
  batch rows show as ordinary moves there, and the batch is named by the
  Undo tooltip while it is head. Rendering the note is a BACKLOG nicety.)
- Empty plan (nothing underfunded by the server's own count — a stale
  button) returns `{ ok: true, wrote: false }`, the WriteResult idiom.

**Batch undo/redo.** `ledger_budget_moves.batch_id uuid` (migration 0046,
additive, nullable — every existing and hand-made move is simply
batchless):

- `undoLastMove`: when the newest active move carries a `batch_id`, the
  update flips every still-active move with that batch id in one UPDATE
  (shared `undone_at` timestamp). Batchless moves flip singly, as today.
- `redoLastMove`: mirror — when the newest undone move carries a
  `batch_id`, clear `undone_at` across the batch in one UPDATE.
  `redoTarget` (lib/budgetMoves.ts) is untouched: it still judges the
  single newest-undone row against the newest-active row; only the WIDTH
  of the flip changes. A batch's rows share one `created_at` (one insert
  statement), so the tuple comparison treats the batch as one moment,
  which is exactly the semantics wanted.
- The Undo button's informed label reads the batch:
  "Undo auto-assign (12 categories, $612.00)". Single moves keep their
  existing per-move label.
- The accepted phase-two TOCTOU stance carries over unchanged (Dan is the
  only writer; a wrong flip is visible in Recent Moves and one click
  fixes it).

**Whole-month rule.** The button reflects and funds the whole month's
underfunded total regardless of the active filter chip — same law as every
other figure in the summary panel.

## Out of scope (deliberate)

- Per-category quick-fund on a row (the month button covers Dan's use).
- Other auto-assign flavors (decision 1).
- Any change to lib/budget.ts's validated arithmetic — the action only
  READS `neededCents` off `buildBudget`'s output.

## Dependency

With zero targets entered the button never appears. Dan enters his 17
targets by hand once this is live (prod `ledger_category_targets` = 0 rows
as of 2026-08-25).
