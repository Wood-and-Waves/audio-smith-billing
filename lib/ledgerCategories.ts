// The seed chart of accounts for an S-Corp audio business. A STARTING POINT,
// not doctrine: every row is editable/hideable in /money/categories, and
// Dan's CPA's own chart reshapes it when he gets it. Income categories are
// not deductions, so they carry deductible: false. Owner pay is a
// transaction KIND, but — unlike a transfer — it DOES carry a category
// (migration 0038 relaxed the old nocat rule; 0040 backfilled it onto every
// existing owner_pay row): OWNER_PAY_CATEGORY_NAME below is that category,
// the budget's largest line.
//
// No '@/' imports and no JSX — exercised by node --test.

/**
 * The one category an owner_pay transaction carries, when it carries one at
 * all — named to match migration 0039's insert and 0040's backfill exactly,
 * so a name-based lookup (lib/ynabRegister.ts's mapYnabRow, MoneyRegister's
 * add/edit forms defaulting the picker) resolves to the real row instead of
 * silently matching nothing.
 */
export const OWNER_PAY_CATEGORY_NAME = 'Owner Investment, Pay, and Personal Expenses'

export type CategorySeed = {
  name: string
  grp: string
  sort: number
  deductible: boolean
  is_equipment: boolean
  budget_role: 'spending' | 'income'
}

const c = (
  name: string, grp: string, sort: number,
  deductible = true, is_equipment = false,
  budget_role: 'spending' | 'income' = 'spending',
): CategorySeed => ({ name, grp, sort, deductible, is_equipment, budget_role })

// This list is a copy of Dan's own 2026 YNAB categories (0039 converged the
// two; 0041 restored the rest of his chart beyond 2026 activity, minus four
// categories he keeps hidden in YNAB with zero 2026 transactions — Apple
// Music, Waves, YNAB, Mexico — omitted on his direction), so the budget
// screen can be checked row-for-row against YNAB.
export const DEFAULT_CATEGORIES: CategorySeed[] = [
  // Dan's own chart, lifted from the business YNAB budget he ran before this
  // module existed (ynab-reflect export, 2026-08-19) — his words, his groups.
  // Income is tracked per client via the PAYEE field, so two income
  // categories suffice here.
  //
  // The GROUPS are banded so they read down a P&L the way an accountant
  // expects — earnings, running costs, professional fees, tax, and the
  // owner's own money last — and because the budget orders its groups by the
  // lowest sort among their members, the two screens agree only if this
  // numbering is the single source of the order (2026-09-10).
  //
  // "Taxes" defaults NON-deductible on purpose:
  // federal estimates are not a business deduction, and overstating
  // deductions is the one direction this tool must never fail — his CPA can
  // flip it if his state taxes belong there.
  c('Show Income', 'Income', 0, false, false, 'income'),
  c('Other Income', 'Income', 1, false, false, 'income'),
  c('Insurance', 'Bills', 10),
  c('Workers Comp', 'Bills', 11),
  c('Spotify', 'Bills', 12),
  c('Software', 'Bills', 13),
  c('Mileage Reimbursement', 'Travel and Meals', 20),
  c('Meals and Entertainment', 'Travel and Meals', 21),
  c('Gig Expenses', 'Travel and Meals', 22),
  c('Transportation', 'Travel and Meals', 23),
  c('Flights', 'Travel and Meals', 24),
  c('Hotels', 'Travel and Meals', 25),
  // Airport security, which is travel — it sat under Bills until 2026-09-10.
  c('Clear', 'Travel and Meals', 26),
  // NOT equipment. The flag exists to surface purchases needing a
  // depreciation or 179 decision, and his audio buying does not qualify:
  // 37 of 39 charges under $500 in 2026, the largest $577, against a de
  // minimis threshold usually ten times that. Computers keeps the flag.
  c('Audio Tools', 'Equipment and Supplies', 30),
  c('Office Expenses', 'Equipment and Supplies', 31),
  c('Computers', 'Equipment and Supplies', 32, true, true),
  c('Education', 'Equipment and Supplies', 33),
  c('Misc Business Expenses', 'Equipment and Supplies', 34),
  // Paying someone to do the books is professional services, not a tax.
  c('Tax Prep', 'Professional Services', 40),
  c('State License Fee', 'Taxes and Licenses', 50),
  c('Taxes', 'Taxes and Licenses', 51, false),
  // Profit he is KEEPING. It should never carry a transaction — it was called
  // "Retained Earnings" until three bank fees were filed against it and
  // printed on the P&L as spent savings. A name that describes what it holds
  // is the cheapest guard available.
  c('Cash Reserve', 'Taxes and Licenses', 52),
  c('Temporary Transfer', 'Owner Transactions', 60, false),
  c('Loan to Wood and Waves', 'Owner Transactions', 61, false),
  c('Charitable Giving', 'Owner Transactions', 62, false),
  c(OWNER_PAY_CATEGORY_NAME, 'Owner Transactions', 63, false),
  c('Money Due Wood and Waves', 'Owner Transactions', 64, false),
]

/**
 * owner_id + the seed list -> the exact row shape ensureDefaultCategories
 * inserts. The one place that shape is built, so a future edit that drops a
 * column (budget_role, say) breaks this function's own test in under a
 * second, instead of only showing up as Ready to Assign quietly disagreeing
 * with YNAB months later.
 */
export function seedCategoryRows(ownerId: string): Array<{
  owner_id: string
  name: string
  grp: string
  sort: number
  deductible: boolean
  is_equipment: boolean
  budget_role: 'spending' | 'income'
}> {
  return DEFAULT_CATEGORIES.map((cat) => ({
    owner_id: ownerId,
    name: cat.name,
    grp: cat.grp,
    sort: cat.sort,
    deductible: cat.deductible,
    is_equipment: cat.is_equipment,
    budget_role: cat.budget_role,
  }))
}
