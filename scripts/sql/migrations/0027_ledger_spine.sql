-- 0027 — the ledger spine behind the Money section (bookkeeping phase 1)
--
-- One business checking account, every transaction categorized for taxes and
-- optionally tagged to a show. Dan's view only: nothing here ever reaches an
-- invoice, a PDF, or a client. Design: docs/superpowers/specs/
-- 2026-08-18-ledger-spine-design.md. ADDITIVE ONLY, per the 0020 rule.

create table ledger_accounts (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references auth.users(id) on delete cascade,
  name                  text not null check (length(btrim(name)) > 0),
  -- checking today; the enum leaves room for the card/savings the reference
  -- design anticipates without another migration.
  type                  text not null default 'checking'
                        check (type in ('checking','savings','credit_card','cash')),
  opening_balance_cents bigint not null default 0,
  opening_date          date not null,
  closed                boolean not null default false,
  last_reconciled_at    timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table ledger_categories (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  name         text not null check (length(btrim(name)) > 0),
  -- The group heading the editor renders under ("Income", "Travel", …).
  grp          text not null check (length(btrim(grp)) > 0),
  sort         int  not null default 0,
  hidden       boolean not null default false,
  -- false on income categories: income is not a deduction. Drives the future
  -- CPA year-end export, never a tax computation.
  deductible   boolean not null default true,
  -- Surfaces big purchases for the CPA's depreciation/§179 call.
  is_equipment boolean not null default false,
  created_at   timestamptz not null default now()
);

create table ledger_transactions (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references auth.users(id) on delete cascade,
  account_id              uuid not null references ledger_accounts(id) on delete restrict,
  date                    date not null,
  -- Signed integer cents: + in, − out. The kind/sign checks below keep the
  -- two from ever disagreeing.
  amount_cents            bigint not null,
  kind                    text not null
                          check (kind in ('income','expense','owner_pay','transfer')),
  -- Null = uncategorized (the workflow queue, not an error). Owner pay and
  -- transfers NEVER carry a category: paying yourself is not a deduction.
  category_id             uuid references ledger_categories(id) on delete restrict,
  show_id                 uuid references shows(id) on delete set null,
  payee                   text not null default '',
  memo                    text,
  cleared                 text not null default 'uncleared'
                          check (cleared in ('uncleared','cleared','reconciled')),
  -- 'OFX:<fitid>' or 'GEN:<amount>:<date>:<n>' — the dedupe key. Null on
  -- manual rows until an import adopts them.
  import_id               text,
  -- Schema-ready for account-to-account pairing; no phase-1 UI writes it.
  transfer_transaction_id uuid,
  source                  text not null default 'manual'
                          check (source in ('manual','import')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint lt_income_positive  check (kind <> 'income' or amount_cents > 0),
  constraint lt_outflow_negative check (kind not in ('expense','owner_pay') or amount_cents < 0),
  constraint lt_nocat_for_owner_or_transfer
    check (kind not in ('owner_pay','transfer') or category_id is null)
);

-- Re-importing the same bank file must be a no-op: one import_id per account.
create unique index ledger_txn_import_uniq
  on ledger_transactions (owner_id, account_id, import_id)
  where import_id is not null;

create index ledger_txn_account_date_idx
  on ledger_transactions (account_id, date desc, created_at desc);

create table ledger_reconciliations (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references auth.users(id) on delete cascade,
  account_id              uuid not null references ledger_accounts(id) on delete restrict,
  statement_balance_cents bigint not null,
  reconciled_on           date not null,
  created_at              timestamptz not null default now()
);

-- RLS + grants, the 0003/0013 pattern, one loop for all four tables.
do $$
declare t text;
begin
  foreach t in array array['ledger_accounts','ledger_categories','ledger_transactions','ledger_reconciliations']
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
