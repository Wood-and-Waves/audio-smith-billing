-- 0039 — the category list converges on Dan's YNAB budget
--
-- The budget screen only proves anything if its rows line up with the rows he
-- checks it against, so the chart becomes a copy of the 2026 categories his YNAB
-- actually uses. Nothing is deleted: Bank Fees and Lodging are hidden, keeping
-- their history and their place on any past transaction.
--
-- Subscriptions splits into Spotify and Clear, which is a split his own payees
-- resolve unambiguously. Owner pay gets the category 0038 just made legal, marked
-- non-deductible so the accountant export is unchanged.

-- Income categories are inflows, not budget rows.
update ledger_categories set budget_role = 'income' where grp = 'Income';

-- The Taxes group becomes Savings, matching YNAB.
update ledger_categories set grp = 'Savings' where grp = 'Taxes';

-- Retire, don't delete.
update ledger_categories set hidden = true where name in ('Bank Fees', 'Lodging');

-- New categories, one row per owner who has any categories at all. deductible
-- and is_equipment mirror lib/ledgerCategories.ts.
insert into ledger_categories (owner_id, name, grp, sort, deductible, is_equipment, budget_role)
select o.owner_id, v.name, v.grp, v.sort, v.deductible, v.is_equipment, 'spending'
  from (select distinct owner_id from ledger_categories) o
 cross join (values
   ('Spotify',                                      'Bills',              12, true,  false),
   ('Clear',                                        'Bills',              13, true,  false),
   ('Owner Investment, Pay, and Personal Expenses', 'Owner Transactions', 40, false, false),
   ('State License Fee',                            'Savings',            51, true,  false),
   ('Retained Earnings',                            'Savings',            53, true,  false)
 ) as v(name, grp, sort, deductible, is_equipment)
 on conflict (owner_id, name) do nothing;

-- Re-sort the survivors so the screen's group order matches YNAB's.
update ledger_categories set sort = 10 where name = 'Insurance';
update ledger_categories set sort = 11 where name = 'Workers Comp';
update ledger_categories set sort = 14 where name = 'Software';
update ledger_categories set sort = 20 where name = 'Mileage Reimbursement';
update ledger_categories set sort = 21 where name = 'Meals and Entertainment';
update ledger_categories set sort = 22 where name = 'Gig Expenses';
update ledger_categories set sort = 23 where name = 'Transportation';
update ledger_categories set sort = 24 where name = 'Flights';
update ledger_categories set sort = 30 where name = 'Audio Tools';
update ledger_categories set sort = 31 where name = 'Misc Business Expenses';
update ledger_categories set sort = 50 where name = 'Tax Prep';
update ledger_categories set sort = 52 where name = 'Taxes';

-- Subscriptions' transactions move to their real names, by payee. Anything that
-- is neither Spotify nor Clear stays on Subscriptions, which is then hidden only
-- if nothing is left pointing at it.
update ledger_transactions t
   set category_id = (select c.id from ledger_categories c
                       where c.owner_id = t.owner_id and c.name = 'Spotify')
 where t.category_id in (select id from ledger_categories where name = 'Subscriptions')
   and t.payee ilike '%spotify%';

update ledger_transactions t
   set category_id = (select c.id from ledger_categories c
                       where c.owner_id = t.owner_id and c.name = 'Clear')
 where t.category_id in (select id from ledger_categories where name = 'Subscriptions')
   and t.payee ilike '%clear%';

update ledger_categories c set hidden = true
 where c.name = 'Subscriptions'
   and not exists (select 1 from ledger_transactions t where t.category_id = c.id);
