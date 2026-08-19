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
}

const c = (
  name: string, grp: string, sort: number,
  deductible = true, is_equipment = false,
): CategorySeed => ({ name, grp, sort, deductible, is_equipment })

export const DEFAULT_CATEGORIES: CategorySeed[] = [
  c('Show Income', 'Income', 0, false),
  c('Other Income', 'Income', 1, false),
  c('Equipment & Gear', 'Operations', 10, true, true),
  c('Supplies', 'Operations', 11),
  c('Software & Subscriptions', 'Operations', 12),
  c('Phone', 'Operations', 13),
  c('Internet', 'Operations', 14),
  c('Airfare', 'Travel', 20),
  c('Lodging', 'Travel', 21),
  c('Meals', 'Travel', 22),
  c('Ground Transport', 'Travel', 23),
  c('Baggage', 'Travel', 24),
  c('Parking & Tolls', 'Travel', 25),
  c('Insurance', 'Business', 30),
  c('Professional Fees', 'Business', 31),
  c('Bank Fees', 'Business', 32),
  c('Licenses & Dues', 'Business', 33),
  c('Advertising', 'Business', 34),
  c('Education', 'Business', 35),
  c('Home Office Reimbursement', 'Business', 36),
]
