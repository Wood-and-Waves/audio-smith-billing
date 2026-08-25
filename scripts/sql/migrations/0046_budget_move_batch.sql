-- 0046 — a batch id on budget moves, for one-tap batch undo
--
-- Auto-assign (design: docs/superpowers/specs/2026-08-25-auto-assign-design.md)
-- writes one move per underfunded category in a single multi-row insert.
-- Dan's decision: Undo reverses the whole batch as a unit. This column is
-- how undo/redo know the unit: null on every existing and hand-made move
-- (they keep flipping singly), one shared fresh uuid across an auto-assign
-- batch. Moves are still never deleted (0038's doctrine) — a batch undo is
-- one UPDATE setting undone_at across the batch.

alter table ledger_budget_moves add column batch_id uuid;

comment on column ledger_budget_moves.batch_id is
  'Null for a hand-made move. Auto-assign stamps one shared uuid across '
  'its whole batch (one multi-row insert); undoLastMove/redoLastMove flip '
  'every move sharing the head move''s batch_id in one UPDATE, which is '
  'what makes Undo reverse the batch as a unit.';
