// Pins lib/budgetMoves.ts's three decisions — the first hand-write paths
// onto the live budget (typing a figure into Assigned, moving money between
// categories, and undo/redo). Same doctrine as categoryOwnership.test.ts
// and incomeRoleGuard.test.ts: the server actions that call these are
// deliberately untested; this is where the actual branching gets pinned.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignmentDiff, validBudgetMonth, redoTarget, isNewerUndone } from '../../lib/budgetMoves.ts'

// ---------------------------------------------------------------------------
// assignmentDiff — typing a figure writes the DIFFERENCE, never the figure.
// The plan's own numbers: current $500, typed $700 -> RTA->category $200;
// typed $300 -> category->RTA $200; typed $500 -> no write.

test('typing a higher figure moves the difference FROM Ready to Assign TO the category', () => {
  // current $500, typed $700 -> RTA->category $200 (the plan's own example)
  assert.deepEqual(
    assignmentDiff('cat-1', 50_000, 70_000),
    { fromCategoryId: null, toCategoryId: 'cat-1', amountCents: 20_000 },
  )
})

test('typing a lower figure moves the difference FROM the category BACK TO Ready to Assign', () => {
  // current $500, typed $300 -> category->RTA $200
  assert.deepEqual(
    assignmentDiff('cat-1', 50_000, 30_000),
    { fromCategoryId: 'cat-1', toCategoryId: null, amountCents: 20_000 },
  )
})

test('typing the same figure writes nothing', () => {
  // current $500, typed $500 -> null, no move at all
  assert.equal(assignmentDiff('cat-1', 50_000, 50_000), null)
})

test('typing zero against an already-zero category writes nothing', () => {
  // The zero/zero corner: diff is 0, same as any other equal case, but
  // worth pinning on its own since 0 is also the value a blank input parses
  // to (lib/money's parseUSD) — this must not be mistaken for "clear it".
  assert.equal(assignmentDiff('cat-1', 0, 0), null)
})

test('typing zero against a funded category moves everything back to Ready to Assign', () => {
  assert.deepEqual(
    assignmentDiff('cat-1', 50_000, 0),
    { fromCategoryId: 'cat-1', toCategoryId: null, amountCents: 50_000 },
  )
})

test('a negative typed value moves the difference out of the category, same as any other decrease', () => {
  // The final phase-two review (2026-08-24) amended the plan's original
  // "reject negatives" line: moving carried money out of a category
  // legitimately drives that month's Assigned negative, and re-entering
  // that figure (or editing it further) has to be a legal diff — see this
  // function's own doc comment, and docs/BACKLOG.md's phase-two entry, for
  // the amendment note. current $500, typed -$1 -> diff is -$501 ->
  // category->RTA move of $501, leaving the category at -$1 assigned.
  assert.deepEqual(
    assignmentDiff('cat-1', 50_000, -100),
    { fromCategoryId: 'cat-1', toCategoryId: null, amountCents: 50_100 },
  )
})

test('a negative typed value against a zero current still resolves a legal diff', () => {
  assert.deepEqual(
    assignmentDiff('cat-1', 0, -100),
    { fromCategoryId: 'cat-1', toCategoryId: null, amountCents: 100 },
  )
})

test('typing back an unchanged negative figure writes nothing — Enter on it must not error', () => {
  // The concrete bug the review caught: open the editor on a category whose
  // Assigned already reads negative (money carried out of it), touch
  // nothing, press Enter. Before this fix that round-tripped through the
  // old `typedCents < 0` refusal and errored on a genuine no-op.
  assert.equal(assignmentDiff('cat-1', -5_000, -5_000), null)
})

test('amountCents is strictly positive by construction, in both directions', () => {
  // Not "the DB constraint will catch it" — the function itself must never
  // be able to produce zero or negative cents on a non-null result, because
  // 0038's own check (amount_cents > 0) is the last line of defense, not
  // the first.
  const up = assignmentDiff('cat-1', 0, 1)
  const down = assignmentDiff('cat-1', 1, 0)
  assert.ok(up && up.amountCents > 0)
  assert.ok(down && down.amountCents > 0)
})

test('a negative current assigned figure (a pathological state, not a valid one) still resolves a total diff', () => {
  // currentAssignedCents is read server-side from a sum of moves, never
  // supplied raw by a caller — it should never actually be negative — but
  // the function takes it as a plain integer with no guard, so it must
  // still behave rather than produce a negative amountCents if it somehow
  // is.
  assert.deepEqual(
    assignmentDiff('cat-1', -5_000, 0),
    { fromCategoryId: null, toCategoryId: 'cat-1', amountCents: 5_000 },
  )
})

// ---------------------------------------------------------------------------
// validBudgetMonth — refuses, never corrects. A write to an out-of-range
// month is a bug or a stale tab, not a navigation intent (unlike the page's
// own clamp in app/money/budget/page.tsx, which IS navigation).

test('a month inside the range resolves to the first-of-month date string', () => {
  assert.equal(validBudgetMonth('2026-06', '2026-08', '2026-01', 24), '2026-06-01')
})

test('the first allowed month itself is in range (inclusive lower bound)', () => {
  assert.equal(validBudgetMonth('2026-01', '2026-08', '2026-01', 24), '2026-01-01')
})

test('the exact ceiling month (today + maxAhead) is in range (inclusive upper bound)', () => {
  // today 2026-08 + 24 months = 2028-08
  assert.equal(validBudgetMonth('2028-08', '2026-08', '2026-01', 24), '2028-08-01')
})

test('one month before the first allowed month is refused, not clamped up to it', () => {
  assert.equal(validBudgetMonth('2025-12', '2026-08', '2026-01', 24), null)
})

test('one month past the ceiling is refused, not clamped down to it', () => {
  assert.equal(validBudgetMonth('2028-09', '2026-08', '2026-01', 24), null)
})

test('a well-formed but wildly out-of-range month (the ?m=9999-12 case) is refused', () => {
  assert.equal(validBudgetMonth('9999-12', '2026-08', '2026-01', 24), null)
})

test('month 00 is shape-invalid even though it matches \\d{4}-\\d{2}', () => {
  assert.equal(validBudgetMonth('2026-00', '2026-08', '2026-01', 24), null)
})

test('month 13 is shape-invalid', () => {
  assert.equal(validBudgetMonth('2026-13', '2026-08', '2026-01', 24), null)
})

test('a single-digit month, a slash date, and an empty string are all shape-invalid', () => {
  for (const bad of ['2026-1', '2026/01', '', '2026-01-01', 'this month']) {
    assert.equal(validBudgetMonth(bad, '2026-08', '2026-01', 24), null, bad)
  }
})

test('every month 01 through 12 shape-checks as valid when otherwise in range', () => {
  for (let m = 1; m <= 12; m++) {
    const ym = `2026-${String(m).padStart(2, '0')}`
    assert.equal(validBudgetMonth(ym, '2026-08', '2026-01', 24), `${ym}-01`, ym)
  }
})

// ---------------------------------------------------------------------------
// redoTarget — the (created_at, id) tuple comparison that decides whether
// redo is legal. 'superseded' is the standard editor rule: a new move made
// after an undo kills redo, exactly like Cmd-Z then a fresh edit in any
// text editor.

test('nothing undone at all -> nothing to redo, regardless of what is active', () => {
  assert.equal(
    redoTarget({
      newestActive: { created_at: '2026-08-20T10:00:00Z', id: 'move-a' },
      newestUndone: null,
    }),
    'nothing',
  )
})

test('nothing active at all, something undone -> redo is clean', () => {
  // The very first move ever made was undone, and nothing has happened
  // since — there is no "newer active move" to compare against.
  assert.equal(
    redoTarget({
      newestActive: null,
      newestUndone: { created_at: '2026-08-20T10:00:00Z', id: 'move-a' },
    }),
    'ok',
  )
})

test('the newest undone move is genuinely the newest thing that happened -> ok', () => {
  // Classic case: move A, move B, undo (marks B). newestActive is A
  // (older), newestUndone is B (newer) -> redo is legal.
  assert.equal(
    redoTarget({
      newestActive: { created_at: '2026-08-20T09:00:00Z', id: 'move-a' },
      newestUndone: { created_at: '2026-08-20T10:00:00Z', id: 'move-b' },
    }),
    'ok',
  )
})

test('an active move newer than the newest undone move -> superseded', () => {
  // Move A, move B, undo (marks B), then move C is made fresh. newestActive
  // is now C, created after B -> redoing B would resurrect a move that sits
  // BEFORE C in history, which is not what "redo" means once new work has
  // happened. This is the case Task 4's walkthrough exercises by hand:
  // undo, make a new move, confirm redo dies.
  assert.equal(
    redoTarget({
      newestActive: { created_at: '2026-08-20T11:00:00Z', id: 'move-c' },
      newestUndone: { created_at: '2026-08-20T10:00:00Z', id: 'move-b' },
    }),
    'superseded',
  )
})

test('a tie on created_at breaks toward the id, superseded direction', () => {
  // Two rows landing in the same instant (or a clock with coarse
  // resolution) are not actually simultaneous in the database — the same
  // (created_at desc, id desc) tie-break the register's own ORDER BY uses
  // (lbm_owner_created_idx, migration 0038) decides which one is "newer".
  // Here the active row's id sorts after the undone row's id, so it counts
  // as the newer one.
  assert.equal(
    redoTarget({
      newestActive: { created_at: '2026-08-20T10:00:00Z', id: 'zzzz' },
      newestUndone: { created_at: '2026-08-20T10:00:00Z', id: 'aaaa' },
    }),
    'superseded',
  )
})

test('a tie on created_at breaks toward the id, ok direction', () => {
  // Same instant, but this time the active row's id sorts BEFORE the
  // undone row's id -> the undone move still counts as the newer one, so
  // redo stays legal. Pinned as its own case (not just the mirror of the
  // test above) because a bug that hardcodes "ties always supersede" would
  // pass the previous test and fail only this one.
  assert.equal(
    redoTarget({
      newestActive: { created_at: '2026-08-20T10:00:00Z', id: 'aaaa' },
      newestUndone: { created_at: '2026-08-20T10:00:00Z', id: 'zzzz' },
    }),
    'ok',
  )
})

test('nothing active and nothing undone -> nothing to redo', () => {
  assert.equal(redoTarget({ newestActive: null, newestUndone: null }), 'nothing')
})

test('assignmentDiff refuses NaN and fractional cents — Number.isInteger is what actually catches these, not a sign check', () => {
  assert.equal(assignmentDiff('c', 50_000, NaN), null)
  assert.equal(assignmentDiff('c', NaN, 50_000), null)
  assert.equal(assignmentDiff('c', 50_000, 100.5), null)
})

// ---------------------------------------------------------------------------
// isNewerUndone — the redo-candidate comparator (`undone_at` first, then the
// same `(created_at, id)` tie-break `isNewer` uses). The final phase-two
// review (2026-08-24) caught that picking the redo candidate by `isNewer`'s
// own `created_at`-first order breaks inside the backfill, where every
// imported move shares one `created_at`.

test('a later undone_at wins regardless of created_at or id', () => {
  // The exact bug: two moves imported in the same backfill transaction
  // share one created_at. Row A (undone first) has an id that sorts AFTER
  // row B's (undone later) — created_at/id order alone would wrongly pick
  // A as the redo candidate; isNewerUndone picks B, the one actually undone
  // most recently.
  const a = { undone_at: '2026-08-20T09:00:00Z', created_at: '2026-01-01T00:00:00Z', id: 'zzzz' }
  const b = { undone_at: '2026-08-20T10:00:00Z', created_at: '2026-01-01T00:00:00Z', id: 'aaaa' }
  assert.equal(isNewerUndone(b, a), true)
  assert.equal(isNewerUndone(a, b), false)
})

test('a tie on undone_at falls back to created_at, then id — same order isNewer uses', () => {
  const a = { undone_at: '2026-08-20T10:00:00Z', created_at: '2026-08-20T09:00:00Z', id: 'move-a' }
  const b = { undone_at: '2026-08-20T10:00:00Z', created_at: '2026-08-20T10:00:00Z', id: 'move-b' }
  assert.equal(isNewerUndone(b, a), true)
  assert.equal(isNewerUndone(a, b), false)
})

test('distinct-timestamp hand moves resolve identically under either order', () => {
  // For every hand-entered move (each with its own real created_at, never
  // shared with another row), undone_at desc and created_at desc agree —
  // the fix changes the answer only where the backfill made them disagree.
  const older = { undone_at: '2026-08-20T09:00:00Z', created_at: '2026-08-19T00:00:00Z', id: 'move-a' }
  const newer = { undone_at: '2026-08-20T10:00:00Z', created_at: '2026-08-20T00:00:00Z', id: 'move-b' }
  assert.equal(isNewerUndone(newer, older), true)
  assert.equal(isNewerUndone(older, newer), false)
})
