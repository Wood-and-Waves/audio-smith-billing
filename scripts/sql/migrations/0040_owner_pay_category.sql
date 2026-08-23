-- 0040 — owner pay gets its category, and retired categories get out of the way
--
-- Two gaps 0039 left, both caught in review.
--
-- First, owner pay. 0038 made it legal for an owner_pay row to carry a category
-- and 0039 created the category, but nothing ever put the two together — so the
-- budget's largest row would have shown a real assignment against zero activity.
-- The whole point of this screen is that it reconciles against YNAB, and this is
-- the line that would have failed first.
--
-- Second, sort collisions. 0039 re-sorted the surviving categories and left the
-- retired ones on their old numbers, so Software tied with Bank Fees, Flights
-- with Lodging, and Clear with Subscriptions. The categories page orders by
-- (grp, sort) with no tie-break, which makes a tie render in whatever order
-- Postgres feels like that day. Retired rows move to 900+, where nothing active
-- can reach them.

update ledger_transactions t
   set category_id = (select c.id from ledger_categories c
                       where c.owner_id = t.owner_id
                         and c.name = 'Owner Investment, Pay, and Personal Expenses')
 where t.kind = 'owner_pay'
   and t.category_id is null
   and exists (select 1 from ledger_categories c
                where c.owner_id = t.owner_id
                  and c.name = 'Owner Investment, Pay, and Personal Expenses');

-- Unconditional, not gated on `hidden`: an owner whose Subscriptions row still
-- holds transactions keeps it visible, and it must still not tie with Clear.
-- Sorting last inside its group is the right place for a category being retired.
update ledger_categories set sort = 900 where name = 'Subscriptions';
update ledger_categories set sort = 901 where name = 'Bank Fees';
update ledger_categories set sort = 902 where name = 'Lodging';
