// The invoice document, as a PDF.
//
// This module builds the document but imports NO PDF library: the caller
// injects Document/Page/Text/View/Image. The browser download button injects
// @react-pdf/renderer's components; the Phase 5 email route will inject the
// same ones server-side. One builder, so the file Dan approves on screen and
// the file a client receives can never be built by different code.
//
// It mirrors components/InvoiceDocument.tsx for the invoice itself — same
// sections, same order, change one and change the other — but it is not a
// section-for-section mirror of the whole file any more: this builder also
// draws an itemisation page and the receipt image pages when the invoice has
// expenses, and InvoiceDocument.tsx (the on-screen preview) does not.
//
// Two things this file must never do, both load-bearing:
//   * No JSX. Node strips types but does not transform JSX, so a .tsx here
//     could not be imported by node --test and the tests below would not run.
//   * No value import of InvoiceDocument. The type comes in via `import type`
//     so it is erased; a value import would drag next/image into the test.

import { createElement as h } from 'react'
import { formatUSD, formatQty } from './money.ts'
import { formatDateLong } from './dates.ts'
import { CATEGORY_LABEL, CATEGORY_ORDER } from './expenses.ts'
import { billToText } from './clientAddress.ts'
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
// The one brand amber — the fill for the rule across the top AND the ink for
// "Smith" in the wordmark. It was two shades: the wordmark darkened to #b45309
// for contrast (#f59e0b is 2.15:1 on white, #b45309 is 4.8:1) until Dan asked
// for a single orange matching the top of the page. The wordmark is large and
// bold, so it carries — but it is lighter than a body-text amber would be.
// Mirrors --paper-accent in globals.css; the two must stay in step.
const AMBER = '#f59e0b'
const MUTED = '#737373'        // Tailwind neutral-500
const MUTED_DARK = '#525252'   // Tailwind neutral-600

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
  forEyebrow: { fontSize: 7, color: MUTED, letterSpacing: 1, marginBottom: 4, marginTop: 12 },
  forText: { fontSize: 9, lineHeight: 1.5 },
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

  expenseHead: { fontFamily: 'Oswald', fontSize: 12, marginBottom: 10 },
  expenseCat: { fontSize: 9, color: MUTED, letterSpacing: 1, marginTop: 12, marginBottom: 4 },
  expenseRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    borderBottomWidth: 1, borderBottomColor: LINE, paddingVertical: 4,
  },
  expenseSub: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingTop: 4, fontSize: 9, color: MUTED_DARK,
  },
  expenseTotal: {
    flexDirection: 'row', justifyContent: 'space-between',
    borderTopWidth: 2, borderTopColor: INK, paddingTop: 8, marginTop: 12,
  },
  hoursShow: { fontSize: 9, color: MUTED, letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  hoursHead: {
    flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: INK,
    paddingBottom: 4, fontSize: 7, color: MUTED, letterSpacing: 0.5,
  },
  hoursRow: {
    flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: LINE, paddingVertical: 4,
  },
  hDay:   { width: 58 },
  hClock: { width: 132 },
  hMeal:  { width: 56, color: MUTED_DARK },
  hNum:   { width: 42, textAlign: 'right' },
  hFlag:  { width: 118, paddingLeft: 16, color: MUTED_DARK, fontSize: 8 },
  hoursTotal: {
    flexDirection: 'row', borderTopWidth: 2, borderTopColor: INK, paddingTop: 8, marginTop: 14,
  },
  // Deliberately lighter than hoursTotal — a thin LINE-colour rule and a
  // small muted label — so a per-show subtotal reads as a running number,
  // not the bold, INK-bordered grand total the page ends on.
  hoursSubtotal: {
    flexDirection: 'row', borderTopWidth: 1, borderTopColor: LINE,
    paddingTop: 4, marginTop: 4, marginBottom: 10,
  },
  receiptPage: { backgroundColor: PAPER, padding: 40 },
  receiptCaption: { fontSize: 8, color: MUTED, marginBottom: 6 },
  // The height is capped in POINTS rather than left to the image.
  //
  // A LETTER page is 792pt; 40pt of padding top and bottom leaves 712, and the
  // caption takes about 14 of it. With only `width: '100%'`, a 1200x1600 phone
  // photo computes to 532x709pt — which together with the caption overflows the
  // page, so @react-pdf kept the caption and pushed the image onto a page of
  // its own. That left an orphaned caption page reading as a duplicate of the
  // itemisation, and a photo that appeared to vanish when you scrolled to it.
  // objectFit 'contain' keeps the aspect ratio inside this box, so a tall
  // receipt shrinks to fit instead of spilling.
  receiptImage: { width: '100%', height: 690, objectFit: 'contain' },
} as const

/** `Invoice-386-Journey-Church.pdf` */
export function invoiceFilename(data: DocumentData): string {
  // Same precedence as `billTo` in the builder below, and for the same reason:
  // the snapshot is who the invoice was actually billed to. Reading client.name
  // alone meant an invoice whose client had since been unlinked downloaded as
  // the bare `Invoice-386.pdf` while the document inside it still said Journey
  // Church — a file Dan cannot identify in his downloads folder, and cannot
  // identify by opening it either, since the name it shows is not the name it
  // carries. bill_to_snapshot is newline-joined with the name on the first line.
  const raw = data.bill_to_snapshot?.split('\n')[0]?.trim() || data.client?.name || ''
  const name = raw.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return name ? `Invoice-${data.number}-${name}.pdf` : `Invoice-${data.number}.pdf`
}

export function buildInvoicePdf(parts: PdfParts, data: DocumentData, assets: PdfAssets) {
  const { Document, Page, Text, View, Image } = parts
  const set = data.settings

  const billTo = data.bill_to_snapshot ?? (data.client ? billToText(data.client) : '')

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

  const expenses = data.backup?.expenses ?? []
  const expenseTotal = expenses.reduce((t, e) => t + e.amount_cents, 0)

  // Only when there is something to show. An invoice not generated from shows
  // has no expenses and gains no pages at all.
  const expensePages = expenses.length === 0 ? [] : [
    h(Page, { size: 'LETTER', style: s.page },
      V(s.body, [
        T(s.expenseHead, `EXPENSES — INVOICE #${data.number}`),
        ...CATEGORY_ORDER.flatMap((cat) => {
          const rows = expenses.filter((e) => e.category === cat)
          if (rows.length === 0) return []
          const subtotal = rows.reduce((t, e) => t + e.amount_cents, 0)
          return [
            T(s.expenseCat, CATEGORY_LABEL[cat].toUpperCase()),
            ...rows.map((e) =>
              V(s.expenseRow, [
                T(null, `${formatDateLong(e.spent_on)}  ${e.where_spent}`),
                T(null, formatUSD(e.amount_cents)),
              ]),
            ),
            V(s.expenseSub, [T(null, 'Subtotal'), T(null, formatUSD(subtotal))]),
          ]
        }),
        V(s.expenseTotal, [
          T(s.grandLabel, 'TOTAL EXPENSES'),
          T({ fontSize: 12 }, formatUSD(expenseTotal)),
        ]),
      ]),
    ),

    // One page per receipt: a receipt scaled to fit a shared page is unreadable,
    // and unreadable backup is the same as none. A PDF-original expense skips
    // its page entirely — the original rides the end of this document at full
    // fidelity (see lib/mergePdfAppendices.ts), and a fuzzy rasterized twin
    // of it in the middle is clutter, not backup (Dan, on the first invoice
    // that carried both).
    ...expenses
      .filter((e) => e.receiptDataUri && !(e.receipt_original ?? '').endsWith('.pdf'))
      .map((e) =>
        h(Page, { size: 'LETTER', style: s.receiptPage },
          T(s.receiptCaption,
            `${CATEGORY_LABEL[e.category]} · ${e.where_spent} · ${formatUSD(e.amount_cents)} · ${formatDateLong(e.spent_on)}`),
          h(Image, { src: e.receiptDataUri as string, style: s.receiptImage }),
        ),
      ),
  ]

  const hrs = (n: number) => (n ? n.toFixed(1) : '')
  const backup = data.backup
  // The DT column only exists when there is double time — an empty column on
  // an ordinary show is noise.
  const anyDt = Boolean(backup?.shows.some((sh) => sh.days.some((d) => d.dt_hours > 0)))

  // Also gated on total_net: an expenses-only show, or a show that is all
  // travel legs, has nothing on this page to report but a heading, a column
  // header and a bold TOTAL row with four blank cells — worse than no page,
  // since it reads as data that failed to load rather than data that never
  // existed.
  // A per-show subtotal only earns its place when there is more than one
  // show — on a single-show invoice it would just repeat the grand total a
  // few lines down. Sitting right under the show's own rows, its rows sum,
  // rather than under the LAST show's rows with no separation from the
  // grand total below it.
  const multiShow = Boolean(backup && backup.shows.length > 1)
  const showTotals = (sh: { days: { net_hours: number; st_hours: number; ot_hours: number; dt_hours: number }[] }) => ({
    net: sh.days.reduce((t, d) => t + d.net_hours, 0),
    st: sh.days.reduce((t, d) => t + d.st_hours, 0),
    ot: sh.days.reduce((t, d) => t + d.ot_hours, 0),
    dt: sh.days.reduce((t, d) => t + d.dt_hours, 0),
  })
  // A day-rate show gets times, not hour math: printing "ST 9.5" beside a
  // flat day rate invites the client's AP clerk to recompute the invoice as
  // hours x rate, which is a different billing model than the one being
  // billed. `false` is the only way into the simplified sheet — `true`
  // (hourly) and, crucially, `undefined` (every snapshot frozen before this
  // field existed) both take the full sheet below, unchanged. That is the
  // same fail direction every other optional snapshot field in this file
  // already uses: an absent field renders the OLD, visible page, never a
  // guessed new one.
  const isSimplified = (sh: { bill_hourly?: boolean }) => sh.bill_hourly === false
  // The grand row used to close every hours page unconditionally. A
  // day-rate-only invoice now has no hour math anywhere on the page, so the
  // row that used to sum it renders only when at least one show kept the
  // full sheet — otherwise it would be the ONLY thing on the page still
  // doing arithmetic nothing above it did. Its own figures are untouched
  // (backup.total_ot etc. sum every show, day-rate included, because a
  // day-rate show can still bill Overtime and that OT must reconcile with
  // the invoice's Overtime line — see backupSnapshot.test.ts).
  const anyFullShow = Boolean(backup?.shows.some((sh) => !isSimplified(sh)))

  const hoursPages = !backup?.show_hours || backup.total_net === 0 ? [] : [
    h(Page, { size: 'LETTER', style: s.page },
      V(s.body, [
        T(s.expenseHead, `HOURS — INVOICE #${data.number}`),
        ...backup.shows.flatMap((sh) => {
          const simplified = isSimplified(sh)
          const totals = showTotals(sh)
          // OT and DT survive on a day-rate show because a day past the OT
          // threshold still bills Overtime/Double Time there (day rate + the
          // extra hours) — the sheet must show which day produced a charge
          // that is genuinely on the invoice. Scoped to THIS show, not the
          // page-wide `anyDt` below (shared by every full-sheet show): a
          // day-rate show with no double time must not gain a blank DT
          // column just because some OTHER show on the invoice hit it.
          const anyOtInShow = sh.days.some((d) => d.ot_hours > 0)
          const anyDtInShow = sh.days.some((d) => d.dt_hours > 0)

          const headCells = simplified
            ? [
                T(s.hDay, 'DAY'), T(s.hClock, 'TIMES'),
                ...(anyOtInShow ? [T(s.hNum, 'OT')] : []),
                ...(anyDtInShow ? [T(s.hNum, 'DT')] : []),
                T(s.hFlag, ''),
              ]
            : [
                T(s.hDay, 'DAY'), T(s.hClock, 'TIMES'), T(s.hMeal, 'MEAL'),
                T(s.hNum, 'NET'), T(s.hNum, 'ST'), T(s.hNum, 'OT'),
                ...(anyDt ? [T(s.hNum, 'DT')] : []), T(s.hFlag, ''),
              ]

          return [
            T(s.hoursShow, `${sh.name.toUpperCase()}   ·   ${sh.zone_label}`),
            V(s.hoursHead, headCells),
            ...sh.days.map((d) => {
              const flag = [d.travel_in && 'travel in', d.travel_out && 'travel out',
                            d.half_day && 'half day',
                            d.meal_penalties ? 'meal penalty' : ''].filter(Boolean).join(' · ')
              // A travel or half day carries no punches. Left blank it reads
              // as missing data, so it is labelled instead of given empty
              // columns. Same row on either sheet — there is no hour math
              // here for the two layouts to disagree about.
              if (!d.in || !d.out) {
                return V(s.hoursRow, [
                  T(s.hDay, d.day),
                  T({ ...s.hClock, color: MUTED_DARK, fontSize: 8 }, flag || '—'),
                ])
              }
              if (simplified) {
                return V(s.hoursRow, [
                  T(s.hDay, d.day),
                  T(s.hClock, `${d.in} – ${d.out}`),
                  ...(anyOtInShow ? [T(s.hNum, hrs(d.ot_hours))] : []),
                  ...(anyDtInShow ? [T(s.hNum, hrs(d.dt_hours))] : []),
                  T(s.hFlag, flag),
                ])
              }
              return V(s.hoursRow, [
                T(s.hDay, d.day),
                T(s.hClock, `${d.in} – ${d.out}`),
                T(s.hMeal, d.meal_minutes ? `${d.meal_minutes} min` : ''),
                T(s.hNum, hrs(d.net_hours)),
                T(s.hNum, hrs(d.st_hours)),
                T(s.hNum, hrs(d.ot_hours)),
                ...(anyDt ? [T(s.hNum, hrs(d.dt_hours))] : []),
                T(s.hFlag, flag),
              ])
            }),
            // No SUBTOTAL for a day-rate show — there is no hour math on its
            // rows to sum.
            ...(multiShow && !simplified ? [
              V(s.hoursSubtotal, [
                T({ ...s.hDay, fontSize: 8, color: MUTED_DARK }, 'SUBTOTAL'),
                T(s.hClock, ''), T(s.hMeal, ''),
                T({ ...s.hNum, fontSize: 8, color: MUTED_DARK }, hrs(totals.net)),
                T({ ...s.hNum, fontSize: 8, color: MUTED_DARK }, hrs(totals.st)),
                T({ ...s.hNum, fontSize: 8, color: MUTED_DARK }, hrs(totals.ot)),
                ...(anyDt ? [T({ ...s.hNum, fontSize: 8, color: MUTED_DARK }, hrs(totals.dt))] : []),
                T(s.hFlag, ''),
              ]),
            ] : []),
          ]
        }),
        ...(anyFullShow ? [
          V(s.hoursTotal, [
            T({ ...s.hDay, fontFamily: 'Oswald', fontSize: 10 }, multiShow ? 'ALL SHOWS' : 'TOTAL'),
            T(s.hClock, ''), T(s.hMeal, ''),
            T({ ...s.hNum, fontFamily: 'Oswald', fontSize: 10 }, hrs(backup.total_net)),
            T({ ...s.hNum, fontFamily: 'Oswald', fontSize: 10 }, hrs(backup.total_st)),
            T({ ...s.hNum, fontFamily: 'Oswald', fontSize: 10 }, hrs(backup.total_ot)),
            ...(anyDt ? [T({ ...s.hNum, fontFamily: 'Oswald', fontSize: 10 }, hrs(backup.total_dt))] : []),
            T(s.hFlag, ''),
          ]),
        ] : []),
      ]),
    ),
  ]

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
                T(s.wordmark, ['THE AUDIO ', T({ color: AMBER }, 'SMITH')]),
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
              // Null on every hand-written invoice and all 105 historical
              // ones — omitted entirely, not printed empty, so they render
              // exactly as they always have. Mirrors InvoiceDocument.tsx.
              ...(data.work_for ? [
                T(s.forEyebrow, 'FOR'),
                T(s.forText, data.work_for),
              ] : []),
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
    ...hoursPages,
    ...expensePages,
  )
}
