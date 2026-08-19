-- 0028 — a DB backstop for category seeding
--
-- ensureDefaultCategories is read-then-write idempotent, which is fine until
-- two first loads race (a Next prefetch against the real navigation is
-- enough): both read zero categories and both seed, leaving every category
-- twice. The unique index makes the second writer fail instead, and the seed
-- action ignores duplicate errors. ADDITIVE ONLY, per the 0020 rule.
create unique index ledger_categories_owner_name_uniq
  on ledger_categories (owner_id, name);
