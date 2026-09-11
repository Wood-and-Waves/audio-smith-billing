-- 0053 — payroll: the tax rules, the paycheck register, and what was remitted
--
-- Dan's business is an S-corp and he has never run payroll: every dollar he
-- has taken out is an owner_pay DRAW. Draws are not deductible; wages are.
-- From 2027 he intends a salary with the remainder as distributions, which
-- creates obligations the app has never had to know about — monthly federal
-- and Illinois deposits, quarterly returns and Illinois unemployment, annual
-- FUTA. His words: "I want to pay what I'm due so I don't ever get behind."
--
-- THREE TABLES, and the reason for each:
--
-- payroll_tax_years — the rates and wage bases, per year, EDITABLE. They are
--   data and not constants because the figures that matter are not knowable
--   in advance: SSA announces the next Social Security wage base in October,
--   and the Illinois unemployment rate is specific to Dan's own IDES account
--   and arrives in a letter. Only 2026 is seeded; 2027 does not exist yet at
--   the time of writing. lib/payrollRules.ts returns null for a year with no
--   row and never falls back to the nearest one, so a missing year is loud
--   rather than quietly a year stale.
--
-- payroll_runs — one row per paycheck, holding the figures ACTUALLY used.
--   `source` says whether the app computed them or a human typed them in,
--   because who computes withholding is still unsettled (if his accountant
--   uses a payroll service, her numbers are the truth and the app's own
--   arithmetic is only a cross-check). The record is the source of truth
--   either way, which is what keeps that open question from blocking this.
--
-- payroll_tax_payments — what was remitted, against which obligation and
--   which period. A zero-cent row is the "filed" marker for a return, which
--   carries a deadline but no money.
--
-- NO NEW TRANSACTION KIND. Payroll is kind = 'expense'. owner_pay is a draw
-- and lib/ledgerReports.ts deliberately excludes it from expenses, so filing
-- a paycheck as owner_pay would overstate profit by the whole salary. A new
-- kind would instead touch the 0027 check, the 0042 splits check, deriveKind,
-- all four ledgerReports functions, ledgerMatch, forecast, ynabRegister and
-- five separate union types — for nothing this needs.
--
-- ADDITIVE ONLY, per the 0020 rule.

-- ---------------------------------------------------------------------------
-- The tax rules, one row per year.
-- ---------------------------------------------------------------------------

create table payroll_tax_years (
  id                            uuid primary key default gen_random_uuid(),
  owner_id                      uuid not null references auth.users(id) on delete cascade,

  year                          int not null check (year between 2000 and 2100),

  -- Rates are basis points, matching lib/money.ts's taxOn: 6.2% -> 620.
  -- Social Security is charged at the same rate to employee and employer.
  ss_rate_bp                    int not null check (ss_rate_bp >= 0),
  ss_wage_base_cents            bigint not null check (ss_wage_base_cents >= 0),

  -- Medicare has no wage base, which is why there is no column for one.
  medicare_rate_bp              int not null check (medicare_rate_bp >= 0),

  -- Additional Medicare is EMPLOYEE ONLY — there is no employer match.
  addl_medicare_rate_bp         int not null check (addl_medicare_rate_bp >= 0),
  addl_medicare_threshold_cents bigint not null check (addl_medicare_threshold_cents >= 0),

  -- FUTA after the state credit (6.0% gross less up to 5.4%). Employer only.
  futa_rate_bp                  int not null check (futa_rate_bp >= 0),
  futa_wage_base_cents          bigint not null check (futa_wage_base_cents >= 0),

  il_income_rate_bp             int not null check (il_income_rate_bp >= 0),
  -- Annual value of one IL-W-4 basic allowance.
  il_allowance_cents            bigint not null check (il_allowance_cents >= 0),

  -- Illinois unemployment. Employer only, and SPECIFIC TO THE ACCOUNT: the
  -- seeded rate below is a new-employer placeholder, not Dan's.
  il_suta_rate_bp               int not null check (il_suta_rate_bp >= 0),
  il_suta_wage_base_cents       bigint not null check (il_suta_wage_base_cents >= 0),

  -- Printed on screen verbatim. This is the field that makes a wrong figure
  -- findable by the one person who can recognise it.
  note                          text not null default '',

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  unique (owner_id, year)
);

-- ---------------------------------------------------------------------------
-- The paycheck register.
-- ---------------------------------------------------------------------------

create table payroll_runs (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references auth.users(id) on delete cascade,

  pay_date                date not null,
  period_start            date not null,
  period_end              date not null,

  gross_cents             bigint not null check (gross_cents >= 0),

  -- Withheld from the employee.
  fed_withholding_cents   bigint not null default 0 check (fed_withholding_cents >= 0),
  ss_employee_cents       bigint not null default 0 check (ss_employee_cents >= 0),
  medicare_employee_cents bigint not null default 0 check (medicare_employee_cents >= 0),
  addl_medicare_cents     bigint not null default 0 check (addl_medicare_cents >= 0),
  il_withholding_cents    bigint not null default 0 check (il_withholding_cents >= 0),

  -- Paid by the employer on top of gross.
  ss_employer_cents       bigint not null default 0 check (ss_employer_cents >= 0),
  medicare_employer_cents bigint not null default 0 check (medicare_employer_cents >= 0),
  futa_cents              bigint not null default 0 check (futa_cents >= 0),
  il_suta_cents           bigint not null default 0 check (il_suta_cents >= 0),

  net_cents               bigint not null check (net_cents >= 0),

  -- 'computed' = this app's arithmetic. 'entered' = a human's figures, from a
  -- payroll service or the accountant. Which one is in use is still an open
  -- question, and the register is the truth under either answer.
  source                  text not null check (source in ('computed', 'entered')),
  -- Which payroll_tax_years row produced a computed run. Null when entered.
  rules_year              int,

  -- The imported bank rows this paycheck turned out to be. The app does NOT
  -- create these: they arrive in the Chase OFX import, and creating them here
  -- would duplicate. They are linked after the fact, which is also why both
  -- are nullable — a run is recorded before the bank shows it.
  net_transaction_id      uuid references ledger_transactions(id) on delete set null,
  tax_transaction_id      uuid references ledger_transactions(id) on delete set null,

  memo                    text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint pr_period_ordered check (period_start <= period_end),

  -- The arithmetic that has to hold for the P&L to come out right: gross is
  -- what lands in Officer Wages, and it is net plus everything withheld.
  constraint pr_net_is_gross_less_withholding check (
    net_cents = gross_cents
      - fed_withholding_cents
      - ss_employee_cents
      - medicare_employee_cents
      - addl_medicare_cents
      - il_withholding_cents
  ),

  -- One paycheck per pay date. Dan is the only employee and is paid monthly,
  -- so a second row on the same date is a double entry — which would double
  -- every obligation it feeds, in the direction that matters most.
  unique (owner_id, pay_date)
);

create index payroll_runs_owner_pay_date_idx on payroll_runs (owner_id, pay_date desc);

-- ---------------------------------------------------------------------------
-- What was remitted, and what was filed.
-- ---------------------------------------------------------------------------

create table payroll_tax_payments (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,

  -- Matches ObligationCode in lib/payrollObligations.ts exactly.
  obligation     text not null check (obligation in (
                   '941-deposit', '941-return', '940',
                   'il-941-deposit', 'il-941-return', 'il-ui'
                 )),

  -- Dates rather than a quarter number, because the periods genuinely differ:
  -- deposits are monthly, returns and Illinois unemployment quarterly, FUTA
  -- annual. A payment is matched to its obligation on code PLUS period, so a
  -- payment against the wrong month never silently closes the right one.
  period_start   date not null,
  period_end     date not null,

  -- Zero is meaningful: it is the "I filed this" marker for a return, which
  -- has a deadline but no money attached.
  amount_cents   bigint not null check (amount_cents >= 0),
  paid_on        date not null,
  confirmation   text,

  transaction_id uuid references ledger_transactions(id) on delete set null,
  created_at     timestamptz not null default now(),

  constraint ptp_period_ordered check (period_start <= period_end)
);

create index payroll_tax_payments_owner_obligation_idx
  on payroll_tax_payments (owner_id, obligation, period_start);

-- ---------------------------------------------------------------------------
-- Seed 2026's rules for the existing owner. 2027 is deliberately absent.
-- ---------------------------------------------------------------------------

insert into payroll_tax_years (
  owner_id, year, ss_rate_bp, ss_wage_base_cents, medicare_rate_bp,
  addl_medicare_rate_bp, addl_medicare_threshold_cents, futa_rate_bp,
  futa_wage_base_cents, il_income_rate_bp, il_allowance_cents,
  il_suta_rate_bp, il_suta_wage_base_cents, note
)
select o.owner_id, 2026, 620, 18450000, 145,
       90, 20000000, 60,
       700000, 495, 285000,
       395, 1391600,
       'Seeded 2026-09-10 and NOT yet verified. Check with your accountant '
       || 'before the first real run: the Social Security wage base, the '
       || 'Illinois allowance amount, the Illinois unemployment wage base, '
       || 'and above all your own IDES unemployment rate (the 3.95% here is '
       || 'a new-employer placeholder, not yours).'
  from (select distinct owner_id from ledger_categories) o
 on conflict (owner_id, year) do nothing;

-- ---------------------------------------------------------------------------
-- The two categories a paycheck lands in.
--
-- Officer Wages ends up totalling GROSS, not net: the payday row carries net
-- pay, and the deposit row's employee-withholding leg carries the rest. That
-- is what belongs on a P&L. Employer Payroll Taxes carries the company's own
-- share. Both are deductible — unlike a draw.
--
-- Band 45 puts Payroll between Professional Services (40) and Taxes and
-- Licenses (50). The bands are the contract between the budget screen and the
-- reports screen (lib/ledgerCategories.ts), and 45 was free.
--
-- Inserted here AND added to the seed list in lib/ledgerCategories.ts: the
-- seed only runs when the categories table is EMPTY, so an existing owner
-- needs the insert and a fresh install needs the seed. Prod diverged from the
-- seed for three days once already by doing only one of the two.
-- ---------------------------------------------------------------------------

insert into ledger_categories (owner_id, name, grp, sort, deductible, is_equipment, budget_role)
select o.owner_id, v.name, v.grp, v.sort, v.deductible, v.is_equipment, 'spending'
  from (select distinct owner_id from ledger_categories) o
 cross join (values
   ('Officer Wages',          'Payroll', 45, true, false),
   ('Employer Payroll Taxes', 'Payroll', 46, true, false)
 ) as v(name, grp, sort, deductible, is_equipment)
 on conflict (owner_id, name) do nothing;

-- ---------------------------------------------------------------------------
-- RLS, the same shape every ledger table uses.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['payroll_tax_years', 'payroll_runs', 'payroll_tax_payments']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      || 'using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t || '_owner_all', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
