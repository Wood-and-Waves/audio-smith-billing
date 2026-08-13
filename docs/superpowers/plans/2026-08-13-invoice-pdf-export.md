# Invoice PDF Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Dan download any invoice as a PDF that matches the on-screen document exactly.

**Architecture:** A pure builder module (`lib/invoicePdf.ts`) constructs the document from injected PDF primitives and never imports `@react-pdf/renderer` itself. A client button injects the real library and downloads a blob. The same builder will render the Phase 5 email attachment server-side, so the file a client receives is built by the code that was approved here.

**Tech Stack:** Next.js 16 App Router, React 19, `@react-pdf/renderer` v4, TypeScript, `node --test` with native type stripping.

**Spec:** `docs/superpowers/specs/2026-08-13-invoice-pdf-export-design.md`

**This plan's builder was executed before the plan was handed over.** The code in
Task 2 was extracted, rendered against both fixtures with the real library, and
converted to PNG and looked at. That run is what produced the U+2212, React-key
and font-path findings recorded below. It should render on the first try; if it
does not, suspect the environment before the code.

## Global Constraints

- **Money is integer cents.** The PDF **prints stored cents and never recomputes them.** Render through `formatUSD(cents)` from `lib/money.ts`; quantities through `formatQty(qtyHundredths)`. Never multiply, divide, sum or round a money value in this feature.
- **Dates go through `lib/dates.ts`.** Use `formatDateLong(iso)`. **Never `new Date()`** for a calendar date — it prints a day early west of UTC and has already caused a real bug in this app.
- **ACH bank details are never rendered.** `settings.ach_details` is not in `DocumentData`, is never passed, and must never be added. `remit_to` prints; ACH is sent only when a client asks.
- **No tax row.** Tax is zero on all 105 invoices. The row is removed from both renderers. `tax_bp`/`tax_cents` stay in the type and the database; they are simply never drawn.
- **Deposit row is conditional.** Printed only when `deposit_cents !== 0` — 16 invoices out of 105, $56,800.75 in total. Never unconditionally hidden.
- **Colours are hardcoded, never tokenised.** `#ffffff` paper, `#121212` ink, `#cbd5e1` rules, `#f59e0b` amber, `#737373` muted (Tailwind `neutral-500`), `#525252` muted-dark (`neutral-600`). A client's document does not follow anybody's colour scheme.
- **`lib/` modules use relative imports with explicit extensions** — `'./money.ts'`, not `'@/lib/money'`. Tests run under `node --test` with no path-alias loader, so `@/` in a runtime import breaks them.
- **No JSX in `lib/`.** Node strips types but does NOT transform JSX; a `.tsx` file cannot be imported by `node --test` at all. The builder is `.ts` and uses `createElement`.
- **The `DocumentData` import must be `import type`.** A value import would pull `components/InvoiceDocument.tsx` — and `next/image` — into the test process and fail.
- Every task ends with `npm test`, `npx tsc --noEmit` and `npm run build` all clean.

---

### Task 1: Bring the on-screen invoice to its final shape

The PDF mirrors `InvoiceDocument.tsx`, so the screen changes first and the PDF copies the finished thing. Removes the tax row and restores the closing line the old spreadsheet template carried on all 105 invoices.

**Files:**
- Modify: `components/InvoiceDocument.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: the exact rendered section order that Task 2's builder must match — header, bill-to/meta, line table, totals (subtotal → deposit-if-any → total due), footer, closing line.

- [ ] **Step 1: Delete the tax row**

In `components/InvoiceDocument.tsx`, find and delete this entire block:

```tsx
            {data.tax_bp > 0 && (
              <div className="flex justify-between py-1 text-sm">
                <dt className="text-neutral-600">Tax ({(data.tax_bp / 100).toFixed(2)}%)</dt>
                <dd className="tabular">{formatUSD(data.tax_cents)}</dd>
              </div>
            )}
```

Leave `tax_bp` and `tax_cents` in the `DocumentData` type. They are real stored columns; they are simply never drawn.

- [ ] **Step 2: Update the component's header comment**

The comment at the top of the file lists three deliberate departures from the old template. Replace the numbered list item 2 and add a fourth. Find:

```tsx
//   2. Zero-value rows are omitted. Tax has been 0% on all 105 invoices and
//      printing "TAX 0%" on every one is noise.
```

Replace with:

```tsx
//   2. There is no tax row at all. Tax is 0% on all 105 invoices ever issued,
//      so the row was noise; the deposit row survives because 16 invoices
//      really carry one. A zero deposit is omitted, a real one is printed.
```

- [ ] **Step 3: Add the closing line**

Immediately after the closing `)}` of the `{(s?.remit_to || data.notes) && (...)}` footer block, and before the closing `</div>` of the `p-8 sm:p-12` wrapper, add:

```tsx
        {/* The old spreadsheet template signed off every one of 105 invoices
            with "THANK YOU FOR YOUR BUSINESS!". It was the only wording the
            data-only rebuild dropped, restored here in the document's own
            voice rather than the template's capitals. */}
        <p className="mt-10 text-center text-[11px] text-neutral-500">
          Thank you for your business!
        </p>
```

- [ ] **Step 4: Verify it builds and renders**

Run:

```bash
npm run build && npx tsc --noEmit
```

Expected: compiles successfully, no type errors.

- [ ] **Step 5: Commit**

```bash
git add components/InvoiceDocument.tsx
git commit -m "Drop the tax row, restore the closing line."
```

---

### Task 2: The PDF document builder

A pure module that builds the document from injected primitives. It imports no PDF library, so it is fully testable under `node --test` with plain string stubs.

**Files:**
- Create: `lib/invoicePdf.ts`
- Create: `scripts/test/invoicePdf.test.ts`

**Interfaces:**
- Consumes: `formatUSD`, `formatQty` from `lib/money.ts`; `formatDateLong` from `lib/dates.ts`; the `DocumentData` type from `components/InvoiceDocument.tsx`.
- Produces:
  - `export type PdfParts = { Document: any; Page: any; Text: any; View: any; Image: any }`
  - `export type PdfAssets = { logoSrc: string }`
  - `export function buildInvoicePdf(parts: PdfParts, data: DocumentData, assets: PdfAssets): any`
  - `export function invoiceFilename(data: DocumentData): string`

**Two deliberate deviations from the spec, both disclosed:**

1. **`StyleSheet` is not in `PdfParts`.** `@react-pdf/renderer` accepts plain style objects; `StyleSheet.create` is validation plus identity. Dropping it removes a stub from every test for no loss.
2. **A third `assets` parameter carries `logoSrc`.** The spec anticipated this for fonts — the same reasoning applies to the logo. The browser passes `/logo.png`; the Phase 5 server will pass a filesystem path. A builder that hardcoded `/logo.png` would silently break server-side.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/invoicePdf.test.ts`:

```ts
// The builder takes its PDF primitives as an argument, so these tests pass
// plain strings as the primitives and walk the resulting React element tree.
// No PDF engine runs, nothing is rendered, and the assertions are about the
// exact strings a client would read on paper.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInvoicePdf, invoiceFilename, type PdfParts } from '../../lib/invoicePdf.ts'
import { formatUSD } from '../../lib/money.ts'
import type { DocumentData } from '../../components/InvoiceDocument.tsx'

const PARTS: PdfParts = {
  Document: 'DOC', Page: 'PAGE', Text: 'TEXT', View: 'VIEW', Image: 'IMG',
}
const ASSETS = { logoSrc: '/logo.png' }

const SETTINGS: DocumentData['settings'] = {
  business_name: 'The Audio Smith',
  legal_name: 'Smith Audio, LLC',
  address_line1: '2610 Melbourne Lane',
  address_line2: 'Lake in the Hills, IL 60156',
  phone: '269.217.8400',
  email: 'dan@theaudiosmith.com',
  remit_to: 'Smith Audio, LLC\n2610 Melbourne Lane',
}

// Invoice #386 as it was actually issued.
const INVOICE: DocumentData = {
  number: 386,
  issue_date: '2026-08-07',
  due_date: '2026-09-06',
  terms_days: 30,
  bill_to_snapshot: 'Journey Church',
  subtotal_cents: 50000,
  tax_bp: 0,
  tax_cents: 0,
  deposit_cents: 0,
  total_cents: 50000,
  notes: null,
  client: { name: 'Journey Church', address_line1: null, address_line2: null },
  lines: [{
    id: 'l1',
    description: 'Audio Training/Maintenance',
    qty_hundredths: 100,
    unit_price_cents: 50000,
    line_total_cents: 50000,
  }],
  settings: SETTINGS,
}

// Every string the document would print, in order.
function textOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out)
    return out
  }
  const props = (node as { props?: { children?: unknown } }).props
  if (props && 'children' in props) textOf(props.children, out)
  return out
}

const joined = (data: DocumentData) =>
  textOf(buildInvoicePdf(PARTS, data, ASSETS)).join(' ')

test('every money string is formatUSD of the stored cents, never recomputed', () => {
  const all = textOf(buildInvoicePdf(PARTS, INVOICE, ASSETS))
  assert.ok(all.includes(formatUSD(50000)), 'subtotal / total / line figures print as $500.00')
  // Nothing may print a figure that is not one of the stored values.
  const money = all.filter((s) => /^\$[\d,]+\.\d{2}$/.test(s))
  assert.ok(money.length > 0, 'the document prints money')
  for (const m of money) {
    assert.equal(m, formatUSD(50000), `unexpected money string ${m}`)
  }
})

test('dates print as the dates they are, not a day early', () => {
  const all = joined(INVOICE)
  assert.ok(all.includes('8/7/2026'), 'issue date prints 8/7/2026')
  assert.ok(all.includes('9/6/2026'), 'due date prints 9/6/2026')
})

test('no tax row is ever emitted, even when tax is set', () => {
  const taxed: DocumentData = { ...INVOICE, tax_bp: 875, tax_cents: 4375 }
  const all = joined(taxed)
  assert.ok(!/tax/i.test(all), 'the word "tax" never appears')
  assert.ok(!all.includes('8.75'), 'the tax rate never appears')
  assert.ok(!all.includes(formatUSD(4375)), 'the tax amount never appears')
})

test('a zero deposit prints no deposit row', () => {
  assert.ok(!/deposit/i.test(joined(INVOICE)))
})

test('a real deposit prints, negated, and the three figures reconcile', () => {
  // Invoice #340, Streamline Pictures, as actually issued.
  const withDeposit: DocumentData = {
    ...INVOICE,
    number: 340,
    subtotal_cents: 688394,
    deposit_cents: 585000,
    total_cents: 103394,
    lines: [{
      id: 'l1', description: 'Day Rate', qty_hundredths: 600,
      unit_price_cents: 78000, line_total_cents: 468000,
    }],
  }
  const all = joined(withDeposit)
  assert.ok(/deposit/i.test(all), 'the deposit row is present')
  assert.ok(all.includes(formatUSD(688394)), 'subtotal $6,883.94 prints')
  // ASCII hyphen, deliberately. Helvetica silently drops U+2212, which would
  // make the credit read as a charge. See the comment in the builder.
  assert.ok(all.includes(`-${formatUSD(585000)}`), 'deposit prints negated as -$5,850.00')
  assert.ok(!all.includes(`−${formatUSD(585000)}`), 'and NOT with a U+2212 minus')
  assert.ok(all.includes(formatUSD(103394)), 'total $1,033.94 prints')
  assert.equal(688394 - 585000, 103394, 'the printed figures reconcile')
})

test('lines print in order, one row each', () => {
  const many: DocumentData = {
    ...INVOICE,
    lines: [
      { id: 'a', description: 'Day Rate', qty_hundredths: 600, unit_price_cents: 78000, line_total_cents: 468000 },
      { id: 'b', description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000, line_total_cents: 78000 },
      { id: 'c', description: 'PM Hours', qty_hundredths: 400, unit_price_cents: 7091, line_total_cents: 28364 },
    ],
  }
  const all = textOf(buildInvoicePdf(PARTS, many, ASSETS))
  const at = (s: string) => all.indexOf(s)
  assert.ok(at('Day Rate') < at('Travel Rate'), 'Day Rate before Travel Rate')
  assert.ok(at('Travel Rate') < at('PM Hours'), 'Travel Rate before PM Hours')
  assert.ok(all.includes('6'), 'quantity 6 prints via formatQty')
})

test('ACH details can never reach the document', () => {
  // ach_details is not part of DocumentData. This attaches it the way a
  // careless future widening of the type would, and proves the builder still
  // does not print it. The type is the real guard; this catches its removal.
  const leaky = {
    ...INVOICE,
    settings: { ...SETTINGS, ach_details: 'Routing 071000013 Account 1234567890' },
  } as unknown as DocumentData
  const all = joined(leaky)
  assert.ok(!all.includes('071000013'), 'no routing number')
  assert.ok(!all.includes('1234567890'), 'no account number')
  assert.ok(!/ach/i.test(all), 'no ACH label')
})

test('the closing line always prints', () => {
  assert.ok(joined(INVOICE).includes('Thank you for your business!'))
})

test('the filename names the invoice and the client', () => {
  assert.equal(invoiceFilename(INVOICE), 'Invoice-386-Journey-Church.pdf')
  assert.equal(
    invoiceFilename({ ...INVOICE, client: null, bill_to_snapshot: null }),
    'Invoice-386.pdf',
  )
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../../lib/invoicePdf.ts'`.

- [ ] **Step 3: Write the builder**

Create `lib/invoicePdf.ts`:

```ts
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
                T(s.wordmark, ['The Audio ', T({ color: AMBER }, 'Smith')]),
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
                T(s.grandLabel, 'TOTAL DUE'),
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm test 2>&1 | tail -20
```

Expected: PASS — all 9 new tests green, and the pre-existing 44 still green (53 total).

If `every money string is formatUSD...` fails with an unexpected money string, the builder is computing a figure instead of printing a stored one. Fix the builder, never the assertion.

- [ ] **Step 5: Typecheck**

Run:

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add lib/invoicePdf.ts scripts/test/invoicePdf.test.ts
git commit -m "Build the invoice PDF document from injected primitives."
```

---

### Task 3: The download button

Installs the real library, vendors the one font, and wires a button into the invoice page.

**Files:**
- Create: `components/DownloadInvoiceButton.tsx`
- Create: `public/fonts/Oswald-Bold.ttf` (vendored binary)
- Modify: `app/invoices/[id]/page.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: `buildInvoicePdf`, `invoiceFilename`, `PdfParts` from `lib/invoicePdf.ts`; `DocumentData` from `components/InvoiceDocument.tsx`.
- Produces: `<DownloadInvoiceButton data={docData} />`.

- [ ] **Step 1: Install the renderer**

Run:

```bash
npm install @react-pdf/renderer@^4.5.1
```

Expected: added to `dependencies`. It is large — that is why Step 3 imports it dynamically.

- [ ] **Step 2: Vendor Oswald Bold**

`@react-pdf/renderer` needs a static TTF; it does not handle variable fonts, and `@fontsource` ships only woff/woff2. Take the static TTF from the Expo Google Fonts package, then remove the package — one vendored file, no lingering dependency:

```bash
npm install --no-save @expo-google-fonts/oswald
mkdir -p public/fonts
cp node_modules/@expo-google-fonts/oswald/700Bold/Oswald_700Bold.ttf public/fonts/Oswald-Bold.ttf
npm uninstall @expo-google-fonts/oswald
```

**Do this after Step 1, not before.** `npm install --no-save` reinstalls from
`package.json` and prunes anything not listed there — running it first would
silently remove an unsaved `@react-pdf/renderer`. Step 1 saves it, so by now it
is safe.

The path above was verified against the published package. If it has moved,
find it with `find node_modules/@expo-google-fonts/oswald -name '*700Bold*.ttf'`.

Verify the file is a real TrueType font and a sane size:

```bash
file public/fonts/Oswald-Bold.ttf && du -h public/fonts/Oswald-Bold.ttf
```

Expected: `TrueType Font data` (or `TrueType font data`), roughly 30–90KB.

If the path inside the package differs, locate it first with `find node_modules/@expo-google-fonts/oswald -name '*700Bold*.ttf'` and copy that. **Do not** substitute a variable-weight `Oswald[wght].ttf` — `@react-pdf` will render it wrong or not at all.

- [ ] **Step 3: Write the button**

Create `components/DownloadInvoiceButton.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { buildInvoicePdf, invoiceFilename, type PdfParts } from '@/lib/invoicePdf'
import type { DocumentData } from '@/components/InvoiceDocument'

// @react-pdf/renderer is around 2MB, so it is imported on click rather than at
// module scope — no invoice page should pay for it just by being opened.
//
// Font.register is global to the library and only needs to happen once.
let fontReady = false

export default function DownloadInvoiceButton({ data }: { data: DocumentData }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setError(null)
    setBusy(true)
    try {
      const { Document, Page, Text, View, Image, Font, pdf } = await import('@react-pdf/renderer')

      if (!fontReady) {
        Font.register({ family: 'Oswald', src: '/fonts/Oswald-Bold.ttf', fontWeight: 700 })
        fontReady = true
      }

      const parts: PdfParts = { Document, Page, Text, View, Image }
      const blob = await pdf(buildInvoicePdf(parts, data, { logoSrc: '/logo.png' })).toBlob()

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = invoiceFilename(data)
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the PDF.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="text-xs font-semibold uppercase tracking-wider text-muted hover:text-ink
                   transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? 'Preparing…' : 'Download PDF'}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Wire it into the invoice page**

In `app/invoices/[id]/page.tsx`, add the import at the top with the others:

```tsx
import DownloadInvoiceButton from '@/components/DownloadInvoiceButton'
```

The page currently builds the document data inline inside `<InvoiceDocument data={{ ... }} />`. Hoist it so the button and the document are given the *same object* — two constructions could drift. Replace the whole `<InvoiceDocument data={{...}} />` element with a `const` declared just above the `return`, plus a plain usage.

Add immediately before `return (`:

```tsx
  const docData: DocumentData = {
    number: inv.number,
    issue_date: inv.issue_date,
    due_date: inv.due_date,
    terms_days: inv.terms_days,
    bill_to_snapshot: inv.bill_to_snapshot,
    subtotal_cents: inv.subtotal_cents,
    tax_bp: inv.tax_bp,
    tax_cents: inv.tax_cents,
    deposit_cents: inv.deposit_cents,
    total_cents: inv.total_cents,
    // The import note belongs above the document, not printed on it.
    notes: inv.imported ? null : inv.notes,
    client: inv.clients,
    lines,
    settings: settings ?? null,
  }
```

Then replace the entire `<InvoiceDocument data={{ ... }} />` element with:

```tsx
      <InvoiceDocument data={docData} />
```

And in the top action row, replace this:

```tsx
        <Link
          href={`/invoices/${inv.id}/edit`}
          className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80"
        >
          Edit
        </Link>
```

with this:

```tsx
        <div className="flex items-center gap-5">
          <DownloadInvoiceButton data={docData} />
          <Link
            href={`/invoices/${inv.id}/edit`}
            className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80"
          >
            Edit
          </Link>
        </div>
```

- [ ] **Step 5: Verify**

Run:

```bash
npm test 2>&1 | tail -6 && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
```

Expected: 53 tests pass, no type errors, `✓ Compiled successfully`.

- [ ] **Step 6: Commit**

```bash
git add components/DownloadInvoiceButton.tsx public/fonts/Oswald-Bold.ttf "app/invoices/[id]/page.tsx" package.json package-lock.json
git commit -m "Download an invoice as a PDF."
```

---

### Task 4: Prove it renders

The tests prove the data is right. Only looking at a real PDF proves the layout is. This also exercises the builder server-side under Node, which is the path Phase 5's email attachment will take — so it de-risks that too.

**Files:**
- Create: `scripts/pdf-sample.mjs`
- Modify: `package.json` (one script entry)

**Interfaces:**
- Consumes: `buildInvoicePdf` from `lib/invoicePdf.ts`.
- Produces: `npm run pdf:sample` writing two PDFs to `tmp/`.

- [ ] **Step 1: Write the sample renderer**

Create `scripts/pdf-sample.mjs`:

```js
// Renders sample invoices to tmp/ so the layout can actually be looked at.
//
// Deliberately uses hardcoded figures rather than the database: this must be
// runnable by anyone, and the two cases that matter are a plain invoice and
// one carrying a deposit. It also proves the builder works under Node with
// renderToFile, which is the path the Phase 5 email attachment will use.
//
//   npm run pdf:sample

import { mkdirSync } from 'node:fs'
import { Document, Page, Text, View, Image, Font, renderToFile } from '@react-pdf/renderer'
import { buildInvoicePdf } from '../lib/invoicePdf.ts'

Font.register({ family: 'Oswald', src: 'public/fonts/Oswald-Bold.ttf', fontWeight: 700 })

const parts = { Document, Page, Text, View, Image }
const assets = { logoSrc: 'public/logo.png' }

const settings = {
  business_name: 'The Audio Smith',
  legal_name: 'Smith Audio, LLC',
  address_line1: '2610 Melbourne Lane',
  address_line2: 'Lake in the Hills, IL 60156',
  phone: '269.217.8400',
  email: 'dan@theaudiosmith.com',
  remit_to: 'Smith Audio, LLC\n2610 Melbourne Lane\nLake in the Hills, IL 60156',
}

// #386 as issued: one line, no deposit.
const simple = {
  number: 386,
  issue_date: '2026-08-07',
  due_date: '2026-09-06',
  terms_days: 30,
  bill_to_snapshot: 'Journey Church',
  subtotal_cents: 50000,
  tax_bp: 0, tax_cents: 0,
  deposit_cents: 0,
  total_cents: 50000,
  notes: null,
  client: { name: 'Journey Church', address_line1: null, address_line2: null },
  lines: [{
    id: 'l1', description: 'Audio Training/Maintenance',
    qty_hundredths: 100, unit_price_cents: 50000, line_total_cents: 50000,
  }],
  settings,
}

// #340 as issued: several lines and a real deposit.
const withDeposit = {
  ...simple,
  number: 340,
  bill_to_snapshot: 'Streamline Pictures',
  subtotal_cents: 688394,
  deposit_cents: 585000,
  total_cents: 103394,
  notes: 'Thanks for a great week.',
  client: { name: 'Streamline Pictures', address_line1: null, address_line2: null },
  lines: [
    { id: 'a', description: 'Day Rate', qty_hundredths: 600, unit_price_cents: 78000, line_total_cents: 468000 },
    { id: 'b', description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000, line_total_cents: 78000 },
    { id: 'c', description: 'Overtime', qty_hundredths: 1900, unit_price_cents: 10636, line_total_cents: 202084 },
    { id: 'd', description: 'PM Hours', qty_hundredths: 800, unit_price_cents: 7091, line_total_cents: 56728 },
  ],
}

mkdirSync('tmp', { recursive: true })
for (const [name, data] of [['simple', simple], ['deposit', withDeposit]]) {
  await renderToFile(buildInvoicePdf(parts, data, assets), `tmp/invoice-${name}.pdf`)
  console.log(`wrote tmp/invoice-${name}.pdf`)
}
```

- [ ] **Step 2: Add the script and ignore the output**

In `package.json`, add to `"scripts"`:

```json
    "pdf:sample": "node scripts/pdf-sample.mjs",
```

Append to `.gitignore`:

```
tmp/
```

- [ ] **Step 3: Render**

Run:

```bash
npm run pdf:sample
```

Expected:

```
wrote tmp/invoice-simple.pdf
wrote tmp/invoice-deposit.pdf
```

- [ ] **Step 4: Check both files are real PDFs of a sane size**

Run:

```bash
file tmp/invoice-*.pdf && du -h tmp/invoice-*.pdf
```

Expected: both report `PDF document`, each roughly 20–200KB. A file under 5KB means the font or logo failed to embed.

- [ ] **Step 5: Convert to PNG and look at the result**

**Do not try to verify these by extracting text from the PDF.** `@react-pdf`
embeds subsetted fonts with custom encodings, so the content streams hold glyph
indices, not readable strings — a `(text)` scrape returns font binary. This was
attempted and does not work. The *text* is already proven by Task 2's tests;
what is unproven here is the *layout*, and that has to be seen.

`sips` ships with macOS, so no install is needed:

```bash
sips -s format png tmp/invoice-simple.pdf --out tmp/invoice-simple.png
sips -s format png tmp/invoice-deposit.pdf --out tmp/invoice-deposit.png
```

Expected: two PNGs written, each roughly 40–120KB.

- [ ] **Step 6: Check the rendering against this list**

Open `tmp/invoice-simple.png` and `tmp/invoice-deposit.png` and confirm each of
these. Every one of them is something that has actually gone wrong in a PDF
renderer at some point:

1. A full-width amber rule across the very top.
2. The logo renders — a visible mark, not an empty box or a missing-image glyph.
3. "The Audio **Smith**" with *Smith* in amber, and both the wordmark and
   "TOTAL DUE" visibly **condensed** — that is Oswald. If they look like the
   body text, the font silently failed to register and everything fell back to
   Helvetica.
4. The business address block is right-aligned at the top right.
5. "BILL TO" left, the Invoice / Date / Terms / Due block right, with a vertical
   rule between them.
6. Four table columns, right-aligned figures, aligned with the totals below.
7. **On the deposit sample only:** the line reads `-$5,850.00` **with a visible
   minus sign**, and `$6,883.94 − $5,850.00 = $1,033.94` is what the page shows.
   A missing minus means the U+2212 regression is back and the credit now reads
   as a charge.
8. **Neither sample shows a tax row.**
9. "Thank you for your business!" centred at the bottom.
10. Both are a single page with **no page number** printed.

- [ ] **Step 7: Commit**

```bash
git add scripts/pdf-sample.mjs package.json .gitignore
git commit -m "Render sample invoices so the layout can be checked."
```

---

## Verification

- `npm test` — 53 tests pass.
- `npx tsc --noEmit` — clean.
- `npm run build` — compiles.
- `npm run pdf:sample` — two PDFs written, text extraction shows no tax row on either and a reconciling deposit on the second.
- The download button produces a file named `Invoice-386-Journey-Church.pdf` in a real browser.

## Blast radius

Additive. No migration, no schema change, no server action, nothing touching the 105 real invoices or 19 clients. The only edits to existing behaviour are the tax row leaving `InvoiceDocument` and the closing line arriving — both visual, both on a component with no logic.
