-- 0042 — split transactions and pending imports (Wave C, Task 1)
--
-- Design: docs/superpowers/specs/2026-08-24-splits-and-pending-design.md.
-- Two of Dan's eleven walkthrough findings, deferred until Waves A and B
-- landed: a bank row whose pieces belong to different categories (the
-- defining example is the 3/5 Online Realtime Transfer — YNAB splits it
-- into Owner Pay plus a $400 Temporary Transfer, the last accepted variance
-- between the two books), and an OFX import that should be a reviewable
-- queue instead of instantly moving the budget. ADDITIVE ONLY, per the 0020
-- rule.
--
-- SPLITS. New table, one row per leg. The parent transaction stays one row
-- — date, payee, total, cleared, import_id, receipt, invoice/expense links
-- all untouched — but while it has legs its own category_id is forced
-- null: a split parent has no single category, and the register renders
-- "Split (N)" instead. Legs cross KINDS on purpose (the $400 case is one
-- owner_pay leg plus one expense leg), so kind lives on the leg, written by
-- the caller through the SAME deriveKind rule the register already uses —
-- no second derivation path in the database.
--
-- Integrity is a trigger, not application convention: whenever a
-- transaction has any legs, it must have at least two, every leg's sign
-- must match the parent's amount_cents sign, and the legs must sum exactly
-- to the parent's amount. Postgres constraint triggers must be FOR EACH
-- ROW — there is no portable FOR EACH STATEMENT constraint trigger with
-- transition tables that covers INSERT, UPDATE, and DELETE alike — so this
-- fires once per row touched and re-checks the WHOLE leg set of that row's
-- transaction(s), DEFERRED to commit. A multi-row replace (the RPC's
-- delete-then-insert) re-validates the same transaction several times over
-- on the way there; that is harmless; every check re-reads the
-- transaction's true row set, so by commit time each firing agrees, and the
-- LAST word — the state actually at commit — is what gets enforced. This
-- is the honest shape for a per-row trigger, not a shortcut.
--
-- Legs are replaced through ONE RPC, replace_transaction_splits, so a
-- delete-then-insert is atomic (the allocate_invoice_number/
-- reconcile_ledger_account precedent) — a crash mid-replace cannot leave a
-- transaction with half its old legs and half its new ones. The RPC checks
-- ownership and jsonb shape only; balance/sign/count is the deferred
-- trigger's job, checked once, at commit, regardless of which path wrote
-- the rows.
--
-- PENDING. ledger_transactions.entered_at, nullable: null means pending.
-- Backfilled to created_at for every row that exists today (all hand-
-- entered so far, so "entered at creation" is exactly right); going
-- forward only the OFX importer inserts null. Pending rows count in the
-- working and cleared balances (Dan's chosen semantics — the register
-- matches Chase) but stay out of everything category-shaped until entered.
-- Reject deletes the pending row; without a tombstone, next month's import
-- would resurrect it — ledger_import_rejections exists for exactly that,
-- consulted by the import planner's dedupe.

-- ---------------------------------------------------------------------------
-- Split legs
-- ---------------------------------------------------------------------------
create table ledger_transaction_splits (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references ledger_transactions(id) on delete cascade,
  -- Null = uncategorized, same as the parent's own column; kind then comes
  -- from direction alone (expense/income), same rule as the parent.
  category_id    uuid references ledger_categories(id) on delete restrict,
  -- Signed, same sign as the parent. The deferred trigger below enforces
  -- sum(legs) = parent.amount_cents and >= 2 legs whenever any leg exists.
  amount_cents   bigint not null,
  -- Never 'transfer' — a transfer moves money between Dan's own accounts
  -- and is not split.
  kind           text not null check (kind in ('income','expense','owner_pay')),
  note           text,
  created_at     timestamptz not null default now()
);

comment on table ledger_transaction_splits is
  'One row per split leg. A transaction with zero legs is unsplit (the '
  'ordinary case). Whenever a transaction has any legs, the deferred '
  'constraint trigger ledger_transaction_splits_integrity requires at '
  'least two, every sign matching the parent, and the sum exact — enforced '
  'at commit regardless of write path. Written only by '
  'replace_transaction_splits(); the table still carries full owner-scoped '
  'RLS below because a direct write is still a legal path the trigger must '
  'also protect.';

create index ledger_txn_splits_owner_idx
  on ledger_transaction_splits (owner_id);
create index ledger_txn_splits_transaction_idx
  on ledger_transaction_splits (transaction_id);

-- ---------------------------------------------------------------------------
-- Import rejection tombstones
-- ---------------------------------------------------------------------------
create table ledger_import_rejections (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references ledger_accounts(id) on delete restrict,
  import_id  text not null check (length(btrim(import_id)) > 0),
  created_at timestamptz not null default now(),

  constraint ledger_import_rejections_uniq unique (owner_id, account_id, import_id)
);

comment on table ledger_import_rejections is
  'A tombstone per rejected pending import row: Reject deletes the '
  'transaction AFTER writing this (that order — a crash between the two '
  'must leave the tombstone, never the resurrection). The import planner '
  '(lib/ledgerImport.ts) treats a tombstoned import_id as already existing, '
  'so re-importing the same statement never resurrects a row Dan rejected.';

-- ---------------------------------------------------------------------------
-- Pending axis
-- ---------------------------------------------------------------------------
alter table ledger_transactions add column entered_at timestamptz;

update ledger_transactions set entered_at = created_at;

comment on column ledger_transactions.entered_at is
  'Null = pending — the one axis the register''s Pending section reads. '
  'Every row that existed before migration 0042 was backfilled to its own '
  'created_at (all hand-entered, so that is exactly right). Hand-entry '
  'paths set this at insert; ONLY the OFX importer inserts null. Pending '
  'rows count in the working AND cleared balances (Dan''s chosen '
  'semantics) but are excluded from every category-shaped consumer: '
  'budget activity and the income/RTA bucket, P&L, spend-by-category, '
  'monthly reports, the CPA export, the forecast''s ledger reads, and '
  'scripts/parity/ynab-live.mjs. Never read directly by those consumers — '
  'go through the one explode/filter helper (lib/ledgerSplits.ts, Task 2).';

-- ---------------------------------------------------------------------------
-- Leg integrity: deferred constraint trigger on the legs table
-- ---------------------------------------------------------------------------
-- security definer + a pinned search_path (0007's discipline): this needs
-- to see a transaction's TRUE leg set regardless of which role's RLS view
-- fired it — a direct authenticated write is a legal path here, same as
-- every other ledger table, and the integrity check must not be foolable
-- by whatever rows RLS happens to hide from that role.
create or replace function ledger_transaction_splits_check() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected      uuid[];
  txn_id        uuid;
  parent_amount bigint;
  leg_count     int;
  leg_sum       bigint;
  bad_sign      int;
begin
  -- OLD is unassigned on INSERT, NEW is unassigned on DELETE — TG_OP picks
  -- which side(s) actually exist. An UPDATE that reparents a leg to a
  -- different transaction_id (not a path the RPC takes, but a legal one
  -- for a direct write under this table's own RLS grants) must re-check
  -- BOTH transactions: the one that gained a leg and the one that lost it.
  if tg_op = 'DELETE' then
    affected := array[old.transaction_id];
  elsif tg_op = 'INSERT' then
    affected := array[new.transaction_id];
  elsif new.transaction_id is distinct from old.transaction_id then
    affected := array[new.transaction_id, old.transaction_id];
  else
    affected := array[new.transaction_id];
  end if;

  foreach txn_id in array affected loop
    select amount_cents into parent_amount
      from ledger_transactions where id = txn_id;

    -- Parent gone (cascade delete) — nothing left to validate.
    if parent_amount is null then
      continue;
    end if;

    select count(*), coalesce(sum(amount_cents), 0)
      into leg_count, leg_sum
      from ledger_transaction_splits
     where transaction_id = txn_id;

    if leg_count = 0 then
      continue; -- unsplit: always fine
    end if;

    if leg_count = 1 then
      raise exception 'Transaction % has 1 split leg — a split needs at least 2.', txn_id;
    end if;

    if leg_sum <> parent_amount then
      raise exception 'Transaction % split legs sum to % cents, the transaction is % cents.',
        txn_id, leg_sum, parent_amount;
    end if;

    select count(*) into bad_sign
      from ledger_transaction_splits
     where transaction_id = txn_id
       and sign(amount_cents) <> sign(parent_amount);

    if bad_sign > 0 then
      raise exception 'Transaction % has a split leg whose sign does not match the transaction (% cents).',
        txn_id, parent_amount;
    end if;
  end loop;

  return null; -- ignored: this is an AFTER trigger
end $$;

create constraint trigger ledger_transaction_splits_integrity
  after insert or update or delete on ledger_transaction_splits
  deferrable initially deferred
  for each row execute function ledger_transaction_splits_check();

-- ---------------------------------------------------------------------------
-- A split parent's amount cannot be edited directly
-- ---------------------------------------------------------------------------
-- Plain (not deferred) trigger: it must refuse the statement immediately,
-- not wait for commit. The WHEN clause keeps the exists-check off every
-- OTHER transaction update (cleared changes, categorization, receipts,
-- memo edits, reconcile) — only an amount_cents change pays for the lookup.
create or replace function ledger_transactions_refuse_amount_edit_with_legs() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from ledger_transaction_splits where transaction_id = old.id
  ) then
    raise exception 'Transaction % has split legs — edit the split, not the total.', old.id;
  end if;
  return new;
end $$;

create trigger ledger_transactions_refuse_amount_edit_with_legs
  before update on ledger_transactions
  for each row
  when (new.amount_cents is distinct from old.amount_cents)
  execute function ledger_transactions_refuse_amount_edit_with_legs();

-- ---------------------------------------------------------------------------
-- replace_transaction_splits — the ONE place legs are ever written
-- ---------------------------------------------------------------------------
-- Delete-then-insert in a single security definer call, same discipline as
-- allocate_invoice_number (0002) and reconcile_ledger_account (0029): a
-- read-then-write pair from application code could crash between the two
-- and leave a transaction on a stale, unbalanced leg set; a function makes
-- it atomic by construction.
--
-- Ownership is verified here FIRST, explicitly — RLS does not protect a
-- security definer function's body, since it runs as the function's owner
-- — before any write is attempted. Past that, this body checks nothing
-- about the legs' balance, sign, or count: the deferred constraint trigger
-- above does that at commit, on every write path, so re-deriving it here
-- would be a second copy of the same rule to keep in step.
--
-- p_legs is a jsonb ARRAY, one object per leg:
--   {"category_id": <uuid or null>, "amount_cents": <int>,
--    "kind": "income"|"expense"|"owner_pay", "note": <text or null>}
-- kind is written through the caller's OWN deriveKind(category, direction)
-- call (lib/ledgerRules.ts) — this function trusts it, the same way it
-- trusts amount_cents; the table's own check constraint is the backstop
-- for a malformed kind, same as for every other malformed field.
--
-- A null or empty p_legs unsplits: zero legs is always a valid leg set.
-- While legs exist after the replace, the parent's category_id is forced
-- to null (a split parent has no single category). On unsplit, category_id
-- is left exactly as it was — already null from the prior split — for the
-- register to re-categorize; this function only ever CLEARS it, never
-- restores a value, so calling it on an already-unsplit transaction with
-- an empty array is a true no-op.
create or replace function public.replace_transaction_splits(
  p_transaction_id uuid,
  p_legs jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id  uuid;
  v_leg_count int;
begin
  select owner_id into v_owner_id
    from ledger_transactions
   where id = p_transaction_id
     and owner_id = auth.uid();

  if v_owner_id is null then
    raise exception 'Transaction % not found, or not owned by the caller.', p_transaction_id;
  end if;

  if p_legs is not null and jsonb_typeof(p_legs) <> 'array' then
    raise exception 'p_legs must be a jsonb array.';
  end if;

  delete from ledger_transaction_splits
   where transaction_id = p_transaction_id
     and owner_id = v_owner_id;

  insert into ledger_transaction_splits
    (owner_id, transaction_id, category_id, amount_cents, kind, note)
  select
    v_owner_id,
    p_transaction_id,
    (leg->>'category_id')::uuid,
    (leg->>'amount_cents')::bigint,
    leg->>'kind',
    leg->>'note'
  from jsonb_array_elements(coalesce(p_legs, '[]'::jsonb)) as leg;

  get diagnostics v_leg_count = row_count;

  -- Only clears category_id when legs now exist; an unsplit (v_leg_count
  -- = 0) matches zero rows here and leaves category_id untouched.
  update ledger_transactions
     set category_id = null
   where id = p_transaction_id
     and v_leg_count > 0;
end $$;

revoke all on function public.replace_transaction_splits(uuid, jsonb) from public;
grant execute on function public.replace_transaction_splits(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS + grants, the 0003/0013/0038 pattern, one loop for both new tables
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ledger_transaction_splits','ledger_import_rejections']
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
