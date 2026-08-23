// The seed chart of accounts for an S-Corp audio business. A STARTING POINT,
// not doctrine: every row is editable/hideable in /money/categories, and
// Dan's CPA's own chart reshapes it when he gets it. Income categories are
// not deductions, so they carry deductible: false; owner pay is a
// transaction KIND (with a null category), so it has no category here.
//
// No '@/' imports and no JSX — exercised by node --test.

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
// two), so the budget screen can be checked row-for-row against YNAB.
export const DEFAULT_CATEGORIES: CategorySeed[] = [
  // Dan's own chart, lifted from the business YNAB budget he ran before this
  // module existed (ynab-reflect export, 2026-08-19) — his words, his groups.
  // Income is tracked per client via the PAYEE field, so two income
  // categories suffice here. "Taxes" defaults NON-deductible on purpose:
  // federal estimates are not a business deduction, and overstating
  // deductions is the one direction this tool must never fail — his CPA can
  // flip it if his state taxes belong there.
  c('Show Income', 'Income', 0, false, false, 'income'),
  c('Other Income', 'Income', 1, false, false, 'income'),
  c('Insurance', 'Bills', 10),
  c('Workers Comp', 'Bills', 11),
  c('Spotify', 'Bills', 12),
  c('Clear', 'Bills', 13),
  c('Software', 'Bills', 14),
  c('Mileage Reimbursement', 'Expenses', 20),
  c('Meals and Entertainment', 'Expenses', 21),
  c('Gig Expenses', 'Expenses', 22),
  c('Transportation', 'Expenses', 23),
  c('Flights', 'Expenses', 24),
  c('Audio Tools', 'Purchases', 30, true, true),
  c('Misc Business Expenses', 'Purchases', 31),
  c('Owner Investment, Pay, and Personal Expenses', 'Owner Transactions', 40, false),
  c('Tax Prep', 'Savings', 50),
  c('State License Fee', 'Savings', 51),
  c('Taxes', 'Savings', 52, false),
  c('Retained Earnings', 'Savings', 53),
]
