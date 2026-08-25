-- 0044 — reconcile's adjustment row must be entered, not pending
--
-- Found while wiring Wave C Task 3 (server actions for splits/pending):
-- migration 0042 added ledger_transactions.entered_at (null = pending) and
-- established one rule for it — every hand-entry write path sets it at
-- insert, and ONLY the OFX importer inserts null. reconcile_ledger_account
-- (0029, immutable, already applied) inserts the balance-adjustment row
-- through a fixed column list that predates entered_at entirely. After
-- 0042, that INSERT falls back to the column's default (null) — so a
-- reconcile adjustment would silently land PENDING in the very same
-- statement that locks it to 'reconciled'. That is a state the app never
-- otherwise produces: lib/ledgerSplits.ts's explodeForCategories (Task 2)
-- drops every pending row from budget activity and the income/RTA bucket,
-- so the adjustment would vanish from the budget while still counting in
-- balances (Dan's own semantics for pending) and sitting permanently
-- unreachable through Enter Now — nothing ever surfaces a reconciled row in
-- the Pending section's queue.
--
-- The adjustment is Dan's own reconcile action completing synchronously,
-- not an import — exactly the "hand-entered rows are entered at insert"
-- rule 0042's own column comment states. Fixed here, not in 0029: it is
-- already applied and checksummed, and this directory's own rule is that a
-- mistake in an applied migration is fixed by writing the next one, never
-- by editing the old file (see README.md).
--
-- Same pass also closes the anon-EXECUTE gap 0043 already fixed for
-- replace_transaction_splits, on this function too: `create function`
-- grants EXECUTE to PUBLIC by default and Supabase's own defaults separately
-- hand it to anon, so `revoke ... from public` alone (0029's own grant)
-- never touched anon — confirmed still live on dev via
-- information_schema.routine_privileges before this migration. No
-- API-reachable role gains anything from the miss (the function runs
-- INVOKER, under RLS, and every write inside is owner-scoped — an anon call
-- has no `auth.uid()` and every row it could touch is refused by RLS or the
-- `owner_id not null` constraint), so this is the same convention fix 0043
-- was, not a security fix.
create or replace function public.reconcile_ledger_account(
  p_account uuid,
  p_statement_cents bigint,
  p_reconciled_on date,
  p_adjustment_cents bigint
) returns void
language sql
volatile
as $fn$
  update ledger_transactions
     set cleared = 'reconciled', updated_at = now()
   where account_id = p_account
     and cleared = 'cleared'
     and date <= p_reconciled_on;

  insert into ledger_transactions
    (owner_id, account_id, date, amount_cents, kind, payee, cleared, source, entered_at)
  select auth.uid(), p_account, p_reconciled_on, p_adjustment_cents,
         case when p_adjustment_cents > 0 then 'income' else 'expense' end,
         'Balance Adjustment', 'cleared', 'manual', now()
   where p_adjustment_cents <> 0;

  insert into ledger_reconciliations
    (owner_id, account_id, statement_balance_cents, reconciled_on)
  values (auth.uid(), p_account, p_statement_cents, p_reconciled_on);

  update ledger_accounts
     set last_reconciled_at = now(), updated_at = now()
   where id = p_account;
$fn$;

revoke all on function public.reconcile_ledger_account(uuid, bigint, date, bigint) from public, anon;
grant execute on function public.reconcile_ledger_account(uuid, bigint, date, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Folded in from Task 1's review before this file was ever applied (an
-- unapplied migration is the one kind that may still be edited):
--
-- (1) entered_at gains DEFAULT now(). 0042 shipped the column with no
-- default, which is fail-DANGEROUS: any insert path that forgets the column
-- silently lands pending — and reconcile_ledger_account proved that class of
-- miss real on the first grep. With the default, forgetting is safe (the row
-- is entered), and the ONE path that wants pending — the OFX importer —
-- passes entered_at: null explicitly, which always beats a default.

alter table ledger_transactions alter column entered_at set default now();

-- (2) Split legs must belong to their parent's owner, at the DATABASE.
-- The legs table's RLS checks only the leg row's own owner_id, and
-- replace_transaction_splits verifies the transaction but not each leg's
-- category — while the table's grants make direct PostgREST writes a
-- first-class path. This trigger closes both doors: a leg's owner must be
-- the parent transaction's owner, and a categorised leg's category must
-- belong to that same owner. Same never-trust-a-caller-supplied-id doctrine
-- as categoryOwnedByCaller, enforced where it cannot be bypassed.

create or replace function ledger_transaction_splits_ownership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_txn_owner uuid;
  v_cat_owner uuid;
begin
  select owner_id into v_txn_owner from ledger_transactions where id = new.transaction_id;
  if v_txn_owner is null or v_txn_owner <> new.owner_id then
    raise exception 'split leg owner does not match its transaction''s owner';
  end if;
  if new.category_id is not null then
    select owner_id into v_cat_owner from ledger_categories where id = new.category_id;
    if v_cat_owner is null or v_cat_owner <> new.owner_id then
      raise exception 'split leg category does not belong to the leg''s owner';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ledger_transaction_splits_ownership on ledger_transaction_splits;
create trigger ledger_transaction_splits_ownership
  before insert or update on ledger_transaction_splits
  for each row execute function ledger_transaction_splits_ownership();

