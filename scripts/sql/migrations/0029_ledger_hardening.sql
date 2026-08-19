-- 0029 — ledger hardening before the Money section ships
--
-- Four unrelated-but-small pieces, all additive (per the 0020 rule):
-- an atomic reconcile, the missing updated_at triggers, the index the paged
-- readers actually use, and a corrected column comment.

-- (1) Reconcile as ONE transaction. The action used to make four sequential
-- writes (lock, adjustment, record, stamp); a failure between them left rows
-- locked with no reconciliation record and no in-app way back. A function is
-- atomic by construction — the same reason allocate_invoice_number (0002)
-- exists. INVOKER rights, deliberately: RLS applies inside, so every row it
-- can touch is the caller's own. The caller (app/money/actions.ts) verifies
-- account ownership and computes the diff BEFORE calling; the function only
-- applies an already-decided reconcile.
--
-- Order matters: lock first, THEN insert the adjustment as merely 'cleared' —
-- a mistaken adjustment stays correctable until the NEXT reconcile locks it.
create function public.reconcile_ledger_account(
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
    (owner_id, account_id, date, amount_cents, kind, payee, cleared, source)
  select auth.uid(), p_account, p_reconciled_on, p_adjustment_cents,
         case when p_adjustment_cents > 0 then 'income' else 'expense' end,
         'Balance Adjustment', 'cleared', 'manual'
   where p_adjustment_cents <> 0;

  insert into ledger_reconciliations
    (owner_id, account_id, statement_balance_cents, reconciled_on)
  values (auth.uid(), p_account, p_statement_cents, p_reconciled_on);

  update ledger_accounts
     set last_reconciled_at = now(), updated_at = now()
   where id = p_account;
$fn$;

revoke all on function public.reconcile_ledger_account(uuid, bigint, date, bigint) from public;
grant execute on function public.reconcile_ledger_account(uuid, bigint, date, bigint) to authenticated;

-- (2) updated_at was declared on both tables in 0027 but nothing ever set it.
-- Same trigger function 0001 uses everywhere else.
create trigger ledger_accounts_updated_at
  before update on ledger_accounts
  for each row execute function set_updated_at();
create trigger ledger_transactions_updated_at
  before update on ledger_transactions
  for each row execute function set_updated_at();

-- (3) Every paged reader orders by (created_at, id) within an account; the
-- 0027 index orders by date and cannot serve that. Harmless at today's row
-- counts, correct at any count.
create index ledger_txn_account_created_idx
  on ledger_transactions (account_id, created_at, id);

-- (4) 0027's comment on ledger_categories.deductible predates the reports
-- page: the flag now drives a LIVE "Deductible expenses" figure, not only a
-- future export. The applied 0027 file is immutable (checksummed), so the
-- correction lands here, on the database's own comment.
comment on column ledger_categories.deductible is
  'Counts toward the Deductible expenses figure on /money/reports and the future CPA export. Income categories carry false. Editable per category — Dan''s/CPA''s call, never a tax computation.';
