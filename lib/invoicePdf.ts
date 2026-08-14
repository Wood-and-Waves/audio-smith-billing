// The invoice document, as a PDF.
//
// This module builds the document but imports NO PDF library: the caller
// injects Document/Page/Text/View/Image. The browser download button injects
// @react-pdf/renderer's components; the Phase 5 email route will inject the
// same ones server-side. One builder, so the file Dan approves on screen and
// the file a client receives can never be built by different code.
//
// It mirrors components/InvoiceDocument.tsx section for section, in the same
// order. Change one, change the other.
//
// Two things this file must never do, both load-bearing:
//   * No JSX. Node strips types but does not transform JSX, so a .tsx here
//     could not be imported by node --test and the tests below would not run.
//   * No value import of InvoiceDocument. The type comes in via `import type`
//     so it is erased; a value import would drag next/image into the test.

import { createElement as h } from 'react'
import { formatUSD, formatQty } from './money.ts'
import { formatDateLong } from './dates.ts'
import type { DocumentData } from '../components/InvoiceDocument.tsx'

export type PdfParts = {
  Document: any; Page: any; Text: any; View: any; Image: any
}

/** Environment-specific sources. The browser passes a URL, the server a path. */
export type PdfAssets = { logoSrc: string }

// The paper palette, hardcoded. These are deliberately NOT the app's theme
// tokens: an invoice is a document a client receives and prints, so it looks
// the same whatever colour scheme anyone is running.
const PAPER = '#ffffff'
const INK = '#121212'
const LINE = '#cbd5e1'
const AMBER = '#f59e0b'        // amber as a FILL — the rule across the top
const MUTED = '#737373'        // Tailwind neutral-500
const MUTED_DARK = '#525252'   // Tailwind neutral-600

// Amber as INK. #f59e0b measures 2.15:1 on white and fails WCAG AA even at the
// 3:1 large-text threshold, so the wordmark's "Smith" darkens to 4.8:1. Mirrors
// --paper-accent in globals.css; the two must stay in step.
const AMBER_INK = '#b45309'

// Column widths, shared by the header row and every body row so the two can
// never drift apart. Description takes whatever is left.
const col = { qty: 40, price: 64, total: 76 }

const s = {
  page: { backgroundColor: PAPER, color: INK, fontFamily: 'Helvetica', fontSize: 9 },
  rule: { height: 6, backgroundColor: AMBER },
  body: { padding: 40 },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    borderBottomWidth: 2, borderBottomColor: INK, paddingBottom: 16,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  logo: { width: 30, height: 30, marginRight: 8 },
  wordmark: { fontFamily: 'Oswald', fontSize: 15 },
  legal: { fontSize: 7, color: MUTED, letterSpacing: 1, marginTop: 2 },
  contact: { fontSize: 8, color: MUTED_DARK, textAlign: 'right', lineHeight: 1.5 },

  midRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 20 },
  billTo: { flexGrow: 1, paddingRight: 24 },
  eyebrow: { fontSize: 7, color: MUTED, letterSpacing: 1, marginBottom: 4 },
  billToName: { fontSize: 10, lineHeight: 1.5 },
  meta: { width: 170, borderLeftWidth: 1, borderLeftColor: LINE, paddingLeft: 16 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  metaLabel: { fontSize: 7, color: MUTED, letterSpacing: 1 },
  metaValue: { fontSize: 9 },

  thead: {
    flexDirection: 'row', borderBottomWidth: 2, borderBottomColor: INK, paddingBottom: 4,
  },
  th: { fontSize: 7, color: MUTED, letterSpacing: 1 },
  row: {
    flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: LINE, paddingVertical: 6,
  },
  cellDesc: { flexGrow: 1, paddingRight: 12 },

  totalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: 12 },
  totals: { width: 210 },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  totalsLabel: { color: MUTED_DARK },
  grandRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end',
    borderTopWidth: 2, borderTopColor: INK, paddingTop: 8, marginTop: 6,
  },
  grandLabel: { fontFamily: 'Oswald', fontSize: 10 },
  grandValue: { fontSize: 17 },

  footer: {
    flexDirection: 'row', marginTop: 32, paddingTop: 16,
    borderTopWidth: 1, borderTopColor: LINE,
  },
  footerCol: { flexGrow: 1, flexBasis: 0, paddingRight: 20 },
  footerText: { fontSize: 8, color: MUTED_DARK, lineHeight: 1.5 },
  ask: { fontSize: 8, color: MUTED, marginTop: 6 },

  closing: { marginTop: 24, fontSize: 8, color: MUTED, textAlign: 'center' },
  pageNo: {
    position: 'absolute', bottom: 20, left: 40, right: 40,
    fontSize: 7, color: MUTED, textAlign: 'center',
  },
} as const

/** `Invoice-386-Journey-Church.pdf` */
export function invoiceFilename(data: DocumentData): string {
  const raw = data.client?.name ?? ''
  const name = raw.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return name ? `Invoice-${data.number}-${name}.pdf` : `Invoice-${data.number}.pdf`
}

export function buildInvoicePdf(parts: PdfParts, data: DocumentData, assets: PdfAssets) {
  const { Document, Page, Text, View, Image } = parts
  const set = data.settings

  const billTo =
    data.bill_to_snapshot ??
    [data.client?.name, data.client?.address_line1, data.client?.address_line2]
      .filter(Boolean)
      .join('\n')

  // Children are ALWAYS spread as variadic arguments, never passed as a single
  // array. React warns "Each child in a list should have a unique key" for an
  // array child, and every render would print it; spread arguments are exempt.
  // Verified against @react-pdf/renderer v4 before this was written.
  const T = (style: unknown, children: unknown, extra: Record<string, unknown> = {}) =>
    h(Text, { style, ...extra }, ...((Array.isArray(children) ? children : [children]) as never[]))
  const V = (style: unknown, children: unknown[], extra: Record<string, unknown> = {}) =>
    h(View, { style, ...extra }, ...(children as never[]))

  const metaRow = (label: string, value: string) =>
    V(s.metaRow, [T(s.metaLabel, label.toUpperCase()), T(s.metaValue, value)])

  const totalsRow = (label: string, value: string) =>
    V(s.totalsRow, [T(s.totalsLabel, label), T(null, value)])

  return h(
    Document,
    null,
    h(
      Page,
      { size: 'LETTER', style: s.page },
      ...[
        // The amber rule, the way the site closes its header.
        V(s.rule, []),

        V(s.body, [
          // ---- header -------------------------------------------------
          V(s.header, [
            V(s.brandRow, [
              h(Image, { src: assets.logoSrc, style: s.logo }),
              V(null, [
                // Uppercase to match the screen: components/InvoiceDocument.tsx
                // renders this wordmark with className="display", and
                // app/globals.css's .display sets text-transform: uppercase.
                T(s.wordmark, ['THE AUDIO ', T({ color: AMBER_INK }, 'SMITH')]),
                T(s.legal, (set?.legal_name ?? 'Smith Audio, LLC').toUpperCase()),
              ]),
            ]),
            V(null, [
              set?.address_line1 ? T(s.contact, set.address_line1) : null,
              set?.address_line2 ? T(s.contact, set.address_line2) : null,
              set?.phone ? T(s.contact, set.phone) : null,
              set?.email ? T(s.contact, set.email) : null,
            ]),
          ]),

          // ---- bill to + meta -----------------------------------------
          V(s.midRow, [
            V(s.billTo, [
              T(s.eyebrow, 'BILL TO'),
              ...(billTo ? billTo.split('\n') : ['—']).map((l) => T(s.billToName, l)),
            ]),
            V(s.meta, [
              metaRow('Invoice', `#${data.number}`),
              metaRow('Date', formatDateLong(data.issue_date)),
              metaRow('Terms', `Net ${data.terms_days}`),
              metaRow('Due', formatDateLong(data.due_date)),
            ]),
          ]),

          // ---- lines --------------------------------------------------
          // `fixed` repeats the header if the table ever runs past one page.
          V(s.thead, [
            T({ ...s.th, ...s.cellDesc }, 'DESCRIPTION'),
            T({ ...s.th, width: col.qty, textAlign: 'right' }, 'QTY'),
            T({ ...s.th, width: col.price, textAlign: 'right' }, 'PRICE'),
            T({ ...s.th, width: col.total, textAlign: 'right' }, 'TOTAL'),
          ], { fixed: true }),

          ...data.lines.map((l) =>
            V(s.row, [
              T(s.cellDesc, l.description),
              T({ width: col.qty, textAlign: 'right' }, formatQty(l.qty_hundredths)),
              T({ width: col.price, textAlign: 'right' }, formatUSD(l.unit_price_cents)),
              T({ width: col.total, textAlign: 'right' }, formatUSD(l.line_total_cents)),
            ]),
          ),

          // ---- totals -------------------------------------------------
          // No tax row: tax is 0% on every invoice ever issued. The deposit
          // row is real — 16 invoices carry one — so it prints when non-zero.
          // wrap={false} keeps the block from splitting across a page break.
          V(s.totalsWrap, [
            V(s.totals, [
              totalsRow('Subtotal', formatUSD(data.subtotal_cents)),
              // ASCII hyphen, NOT the U+2212 minus the screen uses. Helvetica's
              // built-in WinAnsi encoding has no glyph for U+2212 and drops it
              // SILENTLY — the line renders "$5,850.00", which reads as another
              // charge rather than a credit. Verified by rendering both.
              data.deposit_cents !== 0
                ? totalsRow('Deposit received', `-${formatUSD(data.deposit_cents)}`)
                : null,
              V(s.grandRow, [
                // A paid invoice that still says TOTAL DUE reads as a demand
                // for money already received. Mirrors InvoiceDocument.
                T(s.grandLabel, data.status === 'paid' ? 'PAID IN FULL' : 'TOTAL DUE'),
                T(s.grandValue, formatUSD(data.total_cents)),
              ]),
            ]),
          ], { wrap: false }),

          // ---- footer -------------------------------------------------
          set?.remit_to || data.notes
            ? V(s.footer, [
                set?.remit_to
                  ? V(s.footerCol, [
                      T(s.eyebrow, 'PAYMENT'),
                      ...set.remit_to.split('\n').map((l) => T(s.footerText, l)),
                      // The INVITATION to ask about ACH, not the ACH details
                      // themselves. InvoiceDocument.tsx prints this same line;
                      // the bank routing/account numbers never print anywhere.
                      T(s.ask, 'Paying by ACH? Ask and I’ll send the transfer details.'),
                    ])
                  : null,
                data.notes
                  ? V(s.footerCol, [
                      T(s.eyebrow, 'NOTES'),
                      ...data.notes.split('\n').map((l) => T(s.footerText, l)),
                    ])
                  : null,
              ])
            : null,

          T(s.closing, 'Thank you for your business!'),
        ]),

        // Page number only when there is more than one page.
        h(Text, {
          style: s.pageNo,
          fixed: true,
          render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
            totalPages > 1 ? `${pageNumber} of ${totalPages}` : '',
        }),
      ],
    ),
  )
}
