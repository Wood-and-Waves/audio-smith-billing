// The cash flow forecast, as a PDF.
//
// Dan is taking this to his accountant beside the P&L (2026-09-10): the P&L
// says what the year DID, this says what the booked work is expected to do
// next, which is the half she needs to answer "have I set aside enough?".
//
// Same conventions as lib/profitLossPdf.ts because they sit side by side on a
// desk — business name, title and period centred, no logo, figures
// right-aligned under column heads. A month whose ending balance goes negative
// is marked, because that is the single thing a reader must not miss.
//
// The ASSUMPTIONS are printed, not hidden. A forecast without them is a number
// nobody can argue with, which is worse than useless in a meeting: every row
// here depends on his take-home figure, his overhead figure and his tax rate,
// and she may well want to change one.
//
// Like the P&L builder this imports NO pdf library. The primitives arrive as
// PdfParts so the whole thing runs under `node --test`.

import { createElement as h } from 'react'
import { formatUSD } from './money.ts'
import { formatDateFull, monthLabel } from './dates.ts'

export type PdfParts = { Document: any; Page: any; Text: any; View: any; Image: any }

export type CashflowMonth = {
  /** YYYY-MM */
  month: string
  incomeCents: number
  overheadCents: number
  taxCents: number
  drawCents: number
  endingBalanceCents: number
  /** False once the ending balance goes below zero. */
  covered: boolean
}

export type CashflowDocumentData = {
  businessName: string
  /** The day it was produced — a forecast is only true as of a date. */
  generatedOn: string
  /** Unreserved cash the walk starts from. */
  openingBalanceCents: number
  months: CashflowMonth[]
  /** Printed verbatim: "Monthly take-home", "$7,500.00". */
  assumptions: { label: string; value: string }[]
  /** Last month whose ending balance is still positive, or null. */
  coveredThrough: string | null
  /** Last month carrying booked work. Income after it is zero, not a forecast. */
  bookedThrough: string | null
  /** True when the balance never went negative inside the horizon. */
  beyondHorizon: boolean
}

const INK = '#121212'
const LINE = '#cbd5e1'
const MUTED = '#737373'
const SHORT = '#b91c1c'

// Six columns. Month reads left, every figure right, so the eye can run down
// the Ending balance column — the only one that answers the question.
const W = ['19%', '16%', '16%', '16%', '15%', '18%']

const S = {
  page: { paddingTop: 48, paddingBottom: 48, paddingHorizontal: 44, fontSize: 9.5, color: INK },
  business: { fontSize: 15, fontWeight: 700, textAlign: 'center' as const },
  title: { fontSize: 12, textAlign: 'center' as const, marginTop: 4 },
  period: { fontSize: 10, textAlign: 'center' as const, marginTop: 2, color: MUTED },
  asOf: { fontSize: 9, textAlign: 'center' as const, marginTop: 2, color: MUTED, marginBottom: 14 },

  assumptionsHead: { fontSize: 10, fontWeight: 700, marginBottom: 3 },
  assumption: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, color: MUTED },
  assumptionsBlock: { marginBottom: 14, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: LINE },

  head: {
    flexDirection: 'row' as const, borderBottomWidth: 1, borderBottomColor: INK,
    paddingBottom: 3, fontWeight: 700,
  },
  row: { flexDirection: 'row' as const, paddingVertical: 2 },
  opening: {
    flexDirection: 'row' as const, paddingVertical: 3, borderBottomWidth: 1,
    borderBottomColor: LINE, fontWeight: 700,
  },
  short: { color: SHORT },
  note: { marginTop: 14, fontSize: 9, color: MUTED },
}

export function cashflowFilename(from: string, to: string): string {
  return `smith-audio-cash-flow-${from}-to-${to}.pdf`
}

export function buildCashflowPdf(parts: PdfParts, data: CashflowDocumentData) {
  const { Document, Page, Text, View } = parts

  const cells = (values: string[], rowStyle: any, key: string, textStyle?: any) =>
    h(View, { key, style: rowStyle },
      ...values.map((v, i) => h(Text, {
        key: `${key}-${i}`,
        style: { width: W[i], textAlign: i === 0 ? 'left' : 'right', ...(textStyle ?? {}) },
      }, v)))

  const body: unknown[] = []
  const first = data.months[0]
  const last = data.months[data.months.length - 1]

  body.push(h(Text, { key: 'biz', style: S.business }, data.businessName))
  body.push(h(Text, { key: 'title', style: S.title }, 'Cash Flow Forecast'))
  body.push(h(Text, { key: 'period', style: S.period },
    first && last ? `${monthLabel(first.month)} – ${monthLabel(last.month)}` : 'No months projected'))
  body.push(h(Text, { key: 'asof', style: S.asOf },
    `Projected ${formatDateFull(data.generatedOn)} from booked work`))

  if (data.assumptions.length > 0) {
    body.push(h(View, { key: 'assume', style: S.assumptionsBlock },
      h(Text, { key: 'assume-h', style: S.assumptionsHead }, 'Assumptions'),
      ...data.assumptions.map((a, i) =>
        h(View, { key: `a-${i}`, style: S.assumption },
          h(Text, null, a.label), h(Text, null, a.value)))))
  }

  body.push(cells(['Month', 'Income', 'Overhead', 'Tax set-aside', 'Draw', 'Ending balance'],
    S.head, 'head'))
  body.push(cells(['Starting cash', '', '', '', '', formatUSD(data.openingBalanceCents)],
    S.opening, 'opening'))

  data.months.forEach((m, i) => {
    body.push(cells([
      monthLabel(m.month),
      formatUSD(m.incomeCents),
      formatUSD(-m.overheadCents),
      formatUSD(-m.taxCents),
      formatUSD(-m.drawCents),
      formatUSD(m.endingBalanceCents),
    ], S.row, `m-${i}`, m.covered ? undefined : S.short))
  })

  const notes: string[] = []
  if (data.bookedThrough !== null) {
    notes.push(`Booked work runs through ${monthLabel(data.bookedThrough)}. Months after it show no `
      + `income because none is booked yet — not because none is expected.`)
  }
  notes.push(data.beyondHorizon
    ? 'The balance stays positive for the whole period shown.'
    : data.coveredThrough !== null
      ? `Cash covers the plan through ${monthLabel(data.coveredThrough)}; months in red fall short.`
      : 'The plan is not covered even this month — see the first row.')
  notes.push('Overhead and the tax set-aside are shown as outflows. Draw is the owner pay planned '
    + 'for that month, which is a distribution and not a business expense.')

  body.push(h(View, { key: 'notes', style: S.note },
    ...notes.map((n, i) => h(Text, { key: `n-${i}`, style: { marginTop: i === 0 ? 0 : 3 } }, n))))

  return h(Document, null, h(Page, { size: 'LETTER', style: S.page }, ...(body as never[])))
}
