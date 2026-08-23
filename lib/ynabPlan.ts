// YNAB "Plan" CSV export -> budget rows.
//
// The sibling of lib/ynabRegister.ts: that one reads transactions, this one reads
// what was budgeted. Both share parseCsvRows so the two importers can never drift
// on CSV mechanics.
//
// Pure: no database, no clock. scripts/import/ynab-plan.mjs resolves category
// NAMES to ids and does the writing. This module only says what the file says.
//
// No '@/' imports and no JSX — exercised by node --test.

import { parseCsvRows } from './ynabRegister.ts'

export type YnabPlanRow = {
  /** 'YYYY-MM'. */
  month: string
  grp: string
  category: string
  assignedCents: number
  activityCents: number
  availableCents: number
}

const EXPECTED_HEADER = [
  'Month', 'Category Group/Category', 'Category Group', 'Category',
  'Assigned', 'Activity', 'Available',
]

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

/** 'Aug 2026' -> '2026-08'. */
function toMonth(raw: string, lineNo: number): string {
  const [name, year] = raw.trim().split(/\s+/)
  const mm = MONTHS[name]
  if (!mm || !/^\d{4}$/.test(year ?? '')) {
    throw new Error(`line ${lineNo}: cannot read "${raw}" as a month`)
  }
  return `${year}-${mm}`
}

/**
 * '$1,234.56' / '-$45.99' / '$0.00' -> integer cents. YNAB puts the minus BEFORE
 * the dollar sign and uses thousands separators, so a naive parseFloat would
 * silently truncate $6,682.19 to $6.
 */
function toCents(raw: string, lineNo: number, field: string): number {
  const cleaned = raw.trim().replace(/[$,]/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`line ${lineNo}: cannot read "${raw}" as ${field}`)
  }
  return Math.round(Number(cleaned) * 100)
}

export function parseYnabPlan(csv: string): YnabPlanRow[] {
  const rows = parseCsvRows(csv)
  if (rows.length === 0) return []

  const header = rows[0].map((h) => h.trim())
  const matches = header.length === EXPECTED_HEADER.length
    && EXPECTED_HEADER.every((h, i) => header[i] === h)
  if (!matches) {
    throw new Error(
      `unexpected header: got ${header.join(', ')} — expected ${EXPECTED_HEADER.join(', ')}`,
    )
  }

  const out: YnabPlanRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const lineNo = i + 1
    if (r.length !== EXPECTED_HEADER.length) {
      throw new Error(`line ${lineNo}: expected ${EXPECTED_HEADER.length} fields, got ${r.length}`)
    }
    out.push({
      month: toMonth(r[0], lineNo),
      grp: r[2].trim(),
      category: r[3].trim(),
      assignedCents: toCents(r[4], lineNo, 'Assigned'),
      activityCents: toCents(r[5], lineNo, 'Activity'),
      availableCents: toCents(r[6], lineNo, 'Available'),
    })
  }
  return out
}
