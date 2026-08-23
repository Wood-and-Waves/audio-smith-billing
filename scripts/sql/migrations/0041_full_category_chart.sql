-- 0041 — the rest of Dan's YNAB chart
--
-- 0039 scoped the category list to whatever had 2026 activity in Dan's
-- export. He assigns to more of his YNAB chart than that, so this migration
-- restores the rest, in YNAB's own order, so his in-app categorising stops
-- hitting walls — and so the $400 punch-list item (Temporary Transfer)
-- becomes possible.
--
-- Lodging is renamed rather than duplicated: it is hidden with zero
-- transactions and it IS Hotels under the app's old name, so renaming keeps
-- one identity instead of splitting it in two. The three money-movement
-- categories (Temporary Transfer, Loan to Wood and Waves, Money Due Wood and
-- Waves) and Charitable Giving default non-deductible per the chart's
-- standing doctrine — overstating deductions is the one direction this tool
-- must never fail, and the CPA flips what belongs to him. Computers is
-- equipment for the §179/depreciation surfacing, same as Audio Tools.
--
-- Not restored, on Dan's direction: YNAB's four hidden categories (Apple
-- Music, Waves, YNAB, Mexico). Verified against his register export: zero
-- 2026 transactions in any of them. This omission is deliberate, not an
-- oversight — don't read its absence here as one later.

update ledger_categories set name = 'Hotels', hidden = false, sort = 25
 where name = 'Lodging';

update ledger_categories set sort = 34 where name = 'Misc Business Expenses';
update ledger_categories set sort = 43
 where name = 'Owner Investment, Pay, and Personal Expenses';

insert into ledger_categories (owner_id, name, grp, sort, deductible, is_equipment, hidden, budget_role)
select o.owner_id, v.name, v.grp, v.sort, v.deductible, v.is_equipment, v.hidden, 'spending'
  from (select distinct owner_id from ledger_categories) o
 cross join (values
   ('Office Expenses',          'Purchases',          31, true,  false, false),
   ('Computers',                'Purchases',          32, true,  true,  false),
   ('Education',                'Purchases',          33, true,  false, false),
   ('Temporary Transfer',       'Owner Transactions', 40, false, false, false),
   ('Loan to Wood and Waves',   'Owner Transactions', 41, false, false, false),
   ('Charitable Giving',        'Owner Transactions', 42, false, false, false),
   ('Money Due Wood and Waves', 'Owner Transactions', 44, false, false, false)
 ) as v(name, grp, sort, deductible, is_equipment, hidden)
 on conflict (owner_id, name) do nothing;
