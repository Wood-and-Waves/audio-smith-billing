// The Profit and Loss, as a PDF.
//
// Dan's accountant "likes the style of quickbooks printouts" (2026-09-09), so
// this follows their conventions rather than the app's invoice letterhead: the
// business name, the report title and the period CENTRED at the top, no logo,
// accounts down the left with amounts right-aligned, subtotals for each
// section, and Net Income under a rule.
//
// Owner pay and the deductible total sit BELOW the statement as memo lines.
//
// The spacing is tight ON PURPOSE. A full year of his categories comes to just
// over one page at looser settings, which orphaned these two memo lines onto a
// second page by themselves — measured: 18.4pt of room left where the block
// needed 54. Row padding, the period gap and the memo margin were each trimmed
// until a full year fits, verified by rendering the real 2026 statement and
// counting pages. A year with several more categories will legitimately need a
// second page; that is a longer statement, not this bug.
// Draws are equity, not an expense — a real P&L omits them entirely — but the
// accountant wants the figure, so it is present without being counted.
//
// Like lib/invoicePdf.ts, this imports NO PDF library: the caller injects
// Document/Page/Text/View. That is what lets node --test exercise it. And no
// JSX — Node strips types but does not transform JSX.

import { createElement as h } from 'react'
import { formatUSD } from './money.ts'
import { formatDateFull } from './dates.ts'

export type PdfParts = { Document: any; Page: any; Text: any; View: any; Image: any }

export type PlDocumentData = {
  businessName: string
  from: string
  to: string
  income: { name: string; amountCents: number }[]
  // Activity with no category assigned. spendByCategory/incomeByCategory
  // (lib/ledgerReports.ts) deliberately keep this OUT of `income`/
  // `expenseGroups`, but plSummary folds it INTO totalIncomeCents/
  // totalExpensesCents — so without a line for it here, the statement's
  // listed rows stop summing to its own printed totals the moment any
  // activity is uncategorized. Rendered only when nonzero; see
  // buildProfitLossPdf.
  uncategorizedIncomeCents: number
  totalIncomeCents: number
  expenseGroups: { group: string; rows: { name: string; amountCents: number }[]; subtotalCents: number }[]
  // Expense-side counterpart of uncategorizedIncomeCents, above.
  uncategorizedExpenseCents: number
  totalExpensesCents: number
  netCents: number
  ownerPayCents: number
  deductibleCents: number
}

const INK = '#121212'
const LINE = '#cbd5e1'
const MUTED = '#737373'

const S = {
  page: { paddingTop: 48, paddingBottom: 48, paddingHorizontal: 56, fontSize: 10, color: INK },
  centre: { textAlign: 'center' as const },
  business: { fontSize: 15, fontWeight: 700, textAlign: 'center' as const },
  title: { fontSize: 12, textAlign: 'center' as const, marginTop: 4 },
  period: { fontSize: 10, textAlign: 'center' as const, marginTop: 2, color: MUTED, marginBottom: 16 },
  section: { fontSize: 10, fontWeight: 700, marginTop: 14, marginBottom: 4 },
  row: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, paddingVertical: 1.5 },
  account: { paddingLeft: 14 },
  group: { paddingLeft: 7, fontWeight: 700, marginTop: 6 },
  subtotal: {
    flexDirection: 'row' as const, justifyContent: 'space-between' as const,
    borderTopWidth: 1, borderTopColor: LINE, marginTop: 4, paddingTop: 3, fontWeight: 700,
  },
  // A per-group subtotal (e.g. "Total Bills"). Same subtotal rule as
  // Total Income/Total Expenses, but indented to match S.group's heading
  // indent, so it reads as belonging to — and subordinate to — its group,
  // never mistaken for the grand "Total Expenses" below.
  groupSubtotal: {
    flexDirection: 'row' as const, justifyContent: 'space-between' as const,
    borderTopWidth: 1, borderTopColor: LINE, marginTop: 3, paddingTop: 2,
    paddingLeft: 7, fontWeight: 700,
  },
  net: {
    flexDirection: 'row' as const, justifyContent: 'space-between' as const,
    borderTopWidth: 1, borderTopColor: INK, marginTop: 10, paddingTop: 5,
    fontSize: 11, fontWeight: 700,
  },
  memo: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, marginTop: 3, color: MUTED },
  memoBlock: { marginTop: 14 },
}

export function buildProfitLossPdf(parts: PdfParts, data: PlDocumentData) {
  const { Document, Page, Text, View } = parts
  const line = (label: string, cents: number, style: any, key: string) =>
    h(View, { key, style }, h(Text, null, label), h(Text, null, formatUSD(cents)))

  const body: unknown[] = []

  body.push(h(Text, { key: 'biz', style: S.business }, data.businessName))
  body.push(h(Text, { key: 'title', style: S.title }, 'Profit and Loss'))
  body.push(h(Text, { key: 'period', style: S.period },
    `${formatDateFull(data.from)} – ${formatDateFull(data.to)}`))

  body.push(h(Text, { key: 'inc-h', style: S.section }, 'Income'))
  data.income.forEach((r, i) =>
    body.push(line(r.name, r.amountCents, { ...S.row, ...S.account }, `inc-${i}`)))
  // Omitted when zero: a statement should not carry a $0.00 row for
  // something that did not happen, and the common case is zero.
  if (data.uncategorizedIncomeCents !== 0) {
    body.push(line('Uncategorized', data.uncategorizedIncomeCents, { ...S.row, ...S.account }, 'inc-uncat'))
  }
  body.push(line('Total Income', data.totalIncomeCents, S.subtotal, 'inc-total'))

  body.push(h(Text, { key: 'exp-h', style: S.section }, 'Expenses'))
  data.expenseGroups.forEach((g, gi) => {
    body.push(h(Text, { key: `grp-${gi}`, style: S.group }, g.group))
    g.rows.forEach((r, i) =>
      body.push(line(r.name, r.amountCents, { ...S.row, ...S.account }, `exp-${gi}-${i}`)))
    body.push(line(`Total ${g.group}`, g.subtotalCents, S.groupSubtotal, `exp-${gi}-subtotal`))
  })
  if (data.uncategorizedExpenseCents !== 0) {
    body.push(line('Uncategorized', data.uncategorizedExpenseCents, { ...S.row, ...S.account }, 'exp-uncat'))
  }
  body.push(line('Total Expenses', data.totalExpensesCents, S.subtotal, 'exp-total'))

  body.push(line('Net Income', data.netCents, S.net, 'net'))

  body.push(h(View, { key: 'memos', style: S.memoBlock },
    line('Owner pay', data.ownerPayCents, S.memo, 'memo-owner'),
    line('Deductible expenses in this period', data.deductibleCents, S.memo, 'memo-ded')))

  return h(Document, null, h(Page, { size: 'LETTER', style: S.page }, ...(body as never[])))
}

export function plFilename(from: string, to: string): string {
  return `smith-audio-profit-and-loss-${from}-to-${to}.pdf`
}
