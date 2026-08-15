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
  client: {
    name: 'Journey Church', address_line1: null, address_line2: null,
    city: null, state: null, postal_code: null,
  },
  lines: [{
    id: 'l1',
    description: 'Audio Training/Maintenance',
    qty_hundredths: 100,
    unit_price_cents: 50000,
    line_total_cents: 50000,
  }],
  settings: SETTINGS,
}

// Every string the document would print, in order. Text can arrive two ways:
// as `children` (the common case) or, for @react-pdf/renderer's page-number
// trick, as a `render` callback the renderer invokes at layout time. Calling
// only the former would leave that text invisible to every assertion here —
// including the negative ones (no tax, no routing number, no account
// number) — so both are walked.
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
  const props = (node as { props?: { children?: unknown; render?: unknown } }).props
  if (props && 'children' in props) textOf(props.children, out)
  if (props && typeof props.render === 'function') {
    textOf((props.render as (arg: { pageNumber: number; totalPages: number }) => unknown)(
      { pageNumber: 1, totalPages: 2 },
    ), out)
  }
  return out
}

const joined = (data: DocumentData) =>
  textOf(buildInvoicePdf(PARTS, data, ASSETS)).join('')

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

test('stored cents print even when they disagree with qty x price', () => {
  // Dan's history holds both $106.36 and $106.37 as the overtime rate for the
  // same computed figure — the same maths rounded two ways, years apart. An
  // invoice that was sent at the rounded-up total must re-export at that
  // total, so this fixture stores a line total one cent away from what
  // qty x unit_price would give and asserts the stored value is what prints.
  const drifted: DocumentData = {
    ...INVOICE,
    subtotal_cents: 116997,   // recomputing 11 x 10636 would give 116996
    total_cents: 116997,
    lines: [{
      id: 'l1',
      description: 'Overtime',
      qty_hundredths: 1100,
      unit_price_cents: 10636,
      line_total_cents: 116997,
    }],
  }
  const all = textOf(buildInvoicePdf(PARTS, drifted, ASSETS))
  assert.ok(all.includes(formatUSD(116997)), 'the stored $1,169.97 prints')
  assert.ok(!all.includes(formatUSD(116996)), 'the recomputed $1,169.96 never appears')
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

  // The three figures above are only proof the *strings* appear somewhere in
  // the tree — a builder that printed total_cents in the Subtotal row and
  // subtotal_cents in TOTAL DUE would pass every assertion above while
  // sending invoice #340 out reading "Subtotal $1,033.94 ... TOTAL DUE
  // $6,883.94". The tree walk collects strings in document order, so pin
  // each label to the figure that immediately follows it.
  const strings = textOf(buildInvoicePdf(PARTS, withDeposit, ASSETS))
  const labelThenValue = (label: string, value: string) => {
    const i = strings.indexOf(label)
    assert.notEqual(i, -1, `"${label}" appears in the document`)
    assert.equal(strings[i + 1], value, `"${label}" is immediately followed by ${value}`)
  }
  labelThenValue('Subtotal', formatUSD(688394))
  labelThenValue('Deposit received', `-${formatUSD(585000)}`)
  labelThenValue('TOTAL DUE', formatUSD(103394))
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

test('bank details can never reach the document', () => {
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
  // The INVITATION to ask about ACH is not the ACH details, and it must print —
  // InvoiceDocument shows it, and the PDF mirrors that component exactly.
  assert.ok(all.includes('Paying by ACH?'), 'the invitation to ask still prints')
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

// A paid invoice must not print "TOTAL DUE". The emailed body was fixed for
// this; the document itself carried the same contradiction — the public page
// banners "Paid — thank you" and the invoice underneath still demanded money.
test('a paid invoice reads PAID IN FULL, not TOTAL DUE', () => {
  const paid: DocumentData = { ...INVOICE, status: 'paid' }
  const all = textOf(buildInvoicePdf(PARTS, paid, ASSETS))
  assert.ok(all.includes('PAID IN FULL'), 'the label reads PAID IN FULL')
  assert.ok(!all.includes('TOTAL DUE'), 'and never TOTAL DUE')
  assert.ok(all.includes(formatUSD(50000)), 'the figure still prints')
})

test('an unpaid invoice still reads TOTAL DUE', () => {
  for (const status of ['draft', 'sent', undefined] as const) {
    const all = textOf(buildInvoicePdf(PARTS, { ...INVOICE, status }, ASSETS))
    assert.ok(all.includes('TOTAL DUE'), `${status ?? 'no status'} reads TOTAL DUE`)
    assert.ok(!all.includes('PAID IN FULL'), `${status ?? 'no status'} is not marked paid`)
  }
})

// The itemisation and the invoice lines are two views of the same money. Two
// views that can silently disagree is the failure this project keeps finding,
// so the reconciliation is a test rather than an intention.
test('the itemisation total equals the expense lines on the invoice', () => {
  const withExpenses: DocumentData = {
    ...INVOICE,
    subtotal_cents: 88621,
    total_cents: 88621,
    lines: [
      { id: 'l1', description: 'Meal Expenses', qty_hundredths: 100,
        unit_price_cents: 26621, line_total_cents: 26621 },
      { id: 'l2', description: 'Baggage Expenses', qty_hundredths: 100,
        unit_price_cents: 12000, line_total_cents: 12000 },
      { id: 'l3', description: 'Day Rate', qty_hundredths: 100,
        unit_price_cents: 50000, line_total_cents: 50000 },
    ],
    backup: {
      show_hours: false,
      shows: [],
      total_net: 0, total_st: 0, total_ot: 0, total_dt: 0,
      expenses: [
        { category: 'meals', where_spent: 'The Well', amount_cents: 1998,
          spent_on: '2026-05-16', receiptDataUri: null },
        { category: 'meals', where_spent: 'The Meritage', amount_cents: 24623,
          spent_on: '2026-05-21', receiptDataUri: null },
        { category: 'baggage', where_spent: 'United', amount_cents: 6000,
          spent_on: '2026-05-16', receiptDataUri: null },
        { category: 'baggage', where_spent: 'United', amount_cents: 6000,
          spent_on: '2026-05-21', receiptDataUri: null },
      ],
    },
  }

  const all = textOf(buildInvoicePdf(PARTS, withExpenses, ASSETS))
  const joined = all.join(' ')

  assert.ok(joined.includes('The Well'), 'each expense is itemised')
  assert.ok(joined.includes('United'), 'including repeats of the same vendor')

  const expenseTotal = withExpenses.backup!.expenses.reduce((t, e) => t + e.amount_cents, 0)
  assert.equal(expenseTotal, 26621 + 12000, 'the fixture itself reconciles')
  assert.ok(joined.includes(formatUSD(expenseTotal)), 'and the page prints that total')
})

test('an invoice with no expenses gains no itemisation', () => {
  const joined = textOf(buildInvoicePdf(PARTS, INVOICE, ASSETS)).join(' ')
  assert.ok(!/itemis|receipt/i.test(joined), 'no expense page on a plain invoice')
})

test('a receipt image is height-capped so it cannot push itself onto a second page', () => {
  // Invoice 390 shipped with only `width: '100%'`. A 1200x1600 phone photo then
  // computed to 532x709pt, which together with the caption overflowed a 792pt
  // page — so @react-pdf kept the caption and moved the image to a page of its
  // own, leaving an orphaned caption page that read as a duplicate of the
  // itemisation. Verified by rendering: the old style produced 4 pages for one
  // receipt, this one produces 3.
  const withReceipt: DocumentData = {
    ...INVOICE,
    backup: {
      show_hours: false,
      shows: [],
      total_net: 0, total_st: 0, total_ot: 0, total_dt: 0,
      expenses: [{
        category: 'meals', where_spent: 'HMS Host', amount_cents: 5000,
        spent_on: '2026-08-14', receiptDataUri: 'data:image/png;base64,AAAA',
      }],
    },
  }

  const images: Record<string, unknown>[] = []
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    const node = n as { type?: unknown; props?: { style?: unknown; children?: unknown } }
    if (node.type === PARTS.Image && node.props?.style) images.push(node.props.style as Record<string, unknown>)
    if (node.props) {
      const kids = node.props.children
      if (Array.isArray(kids)) kids.forEach(walk)
      else walk(kids)
    }
  }
  walk(buildInvoicePdf(PARTS, withReceipt, ASSETS))

  const receipt = images.find((s) => s.objectFit === 'contain')
  assert.ok(receipt, 'the receipt image should be rendered with objectFit contain')
  assert.equal(typeof receipt.height, 'number',
    'the height must be an explicit number of points, not left to the image')
  assert.ok((receipt.height as number) <= 712,
    'and must fit inside a LETTER page less its 40pt padding, with room for the caption')
})

test('the hours page prints only when the client opted in', () => {
  const withHours: DocumentData = {
    ...INVOICE,
    backup: {
      show_hours: true,
      shows: [{ name: 'PwC Orlando', zone_label: 'Eastern', days: [
        { day: 'Sat 8/30', in: '8:00 AM', out: '8:30 PM', meal_minutes: 30,
          net_hours: 12, st_hours: 10, ot_hours: 2, dt_hours: 0,
          travel_in: false, travel_out: false, half_day: false, meal_penalties: 0 },
      ] }],
      total_net: 12, total_st: 10, total_ot: 2, total_dt: 0, expenses: [],
    },
  }
  const on = textOf(buildInvoicePdf(PARTS, withHours, ASSETS)).join(' ')
  assert.ok(on.includes('PWC ORLANDO'), 'the show is named')
  assert.ok(on.includes('8:00 AM'), 'clock times print')
  assert.ok(on.includes('Eastern'), 'and the zone they are quoted in')

  const off = textOf(buildInvoicePdf(
    PARTS, { ...withHours, backup: { ...withHours.backup!, show_hours: false } }, ASSETS)).join(' ')
  assert.ok(!off.includes('PWC ORLANDO'), 'the flag off suppresses the page entirely')
})

test('a multi-show invoice subtotals each show and labels the grand total ALL SHOWS', () => {
  // Design doc example: Napa's four rows (here compressed to two, same sum)
  // summing to 13.5, printed directly beneath the final show's rows with no
  // separation, reading as if TOTAL 33.5 belonged to Napa alone.
  const twoShows: DocumentData = {
    ...INVOICE,
    backup: {
      show_hours: true,
      shows: [
        { name: 'Napa', zone_label: 'Pacific', days: [
          { day: 'Mon 8/24', in: '8:00 AM', out: '2:30 PM', meal_minutes: 0,
            net_hours: 6.5, st_hours: 6.5, ot_hours: 0, dt_hours: 0,
            travel_in: false, travel_out: false, half_day: false, meal_penalties: 0 },
          { day: 'Tue 8/25', in: '8:00 AM', out: '3:00 PM', meal_minutes: 0,
            net_hours: 7.0, st_hours: 7.0, ot_hours: 0, dt_hours: 0,
            travel_in: false, travel_out: false, half_day: false, meal_penalties: 0 },
        ] },
        { name: 'PwC Orlando', zone_label: 'Eastern', days: [
          { day: 'Sat 8/29', in: '8:00 AM', out: '8:30 PM', meal_minutes: 30,
            net_hours: 20.0, st_hours: 10.0, ot_hours: 10.0, dt_hours: 0,
            travel_in: false, travel_out: false, half_day: false, meal_penalties: 0 },
        ] },
      ],
      total_net: 33.5, total_st: 23.5, total_ot: 10.0, total_dt: 0, expenses: [],
    },
  }

  const strings = textOf(buildInvoicePdf(PARTS, twoShows, ASSETS))
  // Each hours row is DAY, TIMES, MEAL, NET, ST, OT[, DT], flag — so the NET
  // figure for a TOTAL/SUBTOTAL row sits three slots after its label, past
  // the two blank TIMES/MEAL cells that row leaves empty.
  const netAfter = (label: string, from = 0) => {
    const i = strings.indexOf(label, from)
    assert.notEqual(i, -1, `"${label}" appears in the document`)
    return { index: i, net: strings[i + 3] }
  }

  const napaSubtotal = netAfter('SUBTOTAL')
  assert.equal(napaSubtotal.net, '13.5', "Napa's subtotal reads 13.5")
  const orlandoSubtotal = netAfter('SUBTOTAL', napaSubtotal.index + 1)
  assert.equal(orlandoSubtotal.net, '20.0', "Orlando's subtotal reads 20.0")

  const grand = netAfter('ALL SHOWS')
  assert.equal(grand.net, '33.5', 'the grand total equals the sum of the per-show subtotals')
  assert.equal(
    Number(napaSubtotal.net) + Number(orlandoSubtotal.net), Number(grand.net),
    'the grand total equals the sum of the printed subtotals, not just the fixture totals',
  )
})

test('an invoice with no snapshot renders exactly as it always did', () => {
  const joined = textOf(buildInvoicePdf(PARTS, INVOICE, ASSETS)).join(' ')
  assert.ok(!/HOURS —/.test(joined), 'no hours page')
  assert.ok(!/itemis|EXPENSES/i.test(joined), 'and no expense pages')
})

test('a travel day is labelled instead of showing empty columns', () => {
  // A travel leg alongside a worked day, not a travel-only show — an
  // all-travel show has total_net 0 and renders no hours page at all (see
  // 'a show with zero net hours renders no hours page' below). This fixture
  // proves the travel day within a show that DOES bill hours is labelled
  // rather than shown with blank numeric columns.
  const travelPlusWorked: DocumentData = {
    ...INVOICE,
    backup: {
      show_hours: true,
      shows: [{ name: 'PwC Orlando', zone_label: 'Eastern', days: [
        { day: 'Fri 8/29', in: null, out: null, meal_minutes: 0,
          net_hours: 0, st_hours: 0, ot_hours: 0, dt_hours: 0,
          travel_in: true, travel_out: false, half_day: false, meal_penalties: 0 },
        { day: 'Sat 8/30', in: '8:00 AM', out: '8:30 PM', meal_minutes: 30,
          net_hours: 12, st_hours: 10, ot_hours: 2, dt_hours: 0,
          travel_in: false, travel_out: false, half_day: false, meal_penalties: 0 },
      ] }],
      total_net: 12, total_st: 10, total_ot: 2, total_dt: 0, expenses: [],
    },
  }
  const joined = textOf(buildInvoicePdf(PARTS, travelPlusWorked, ASSETS)).join(' ')
  assert.ok(joined.includes('travel in'), 'the day says what it is')
})

test('a show with zero net hours renders no hours page', () => {
  // An expenses-only show, or one that is all travel legs, has nothing on
  // this page to report but a heading, a column header and a bold TOTAL row
  // with four blank cells — worse than no page at all.
  const allTravel: DocumentData = {
    ...INVOICE,
    backup: {
      show_hours: true,
      shows: [{ name: 'PwC Orlando', zone_label: 'Eastern', days: [
        { day: 'Fri 8/29', in: null, out: null, meal_minutes: 0,
          net_hours: 0, st_hours: 0, ot_hours: 0, dt_hours: 0,
          travel_in: true, travel_out: false, half_day: false, meal_penalties: 0 },
      ] }],
      total_net: 0, total_st: 0, total_ot: 0, total_dt: 0, expenses: [],
    },
  }
  const joined = textOf(buildInvoicePdf(PARTS, allTravel, ASSETS)).join(' ')
  assert.ok(!/HOURS —/.test(joined), 'no hours page at all')
  assert.ok(!joined.includes('PWC ORLANDO'), 'not even the show heading')
})

test('the FOR heading prints only when the invoice names its work', () => {
  const withWork = { ...INVOICE, work_for: 'PwC Orlando, Streamline Napa' }
  const on = textOf(buildInvoicePdf(PARTS, withWork, ASSETS)).join(' ')
  assert.ok(on.includes('PwC Orlando, Streamline Napa'))

  const off = textOf(buildInvoicePdf(PARTS, INVOICE, ASSETS)).join(' ')
  assert.ok(!/\bFOR\b/.test(off), 'a historical invoice gains nothing')
})

test('the live-client fallback prints city/state/ZIP as their own line', () => {
  // bill_to_snapshot is null here on purpose — this exercises the fallback
  // that reads straight off the client row, not the frozen snapshot every
  // real invoice actually carries.
  const noSnapshot: DocumentData = {
    ...INVOICE,
    bill_to_snapshot: null,
    client: {
      name: 'Streamline Pictures',
      address_line1: '10700 75th St',
      address_line2: null,
      city: 'Elgin',
      state: 'IL',
      postal_code: '60123',
    },
  }
  const all = textOf(buildInvoicePdf(PARTS, noSnapshot, ASSETS))
  const i = all.indexOf('10700 75th St')
  assert.notEqual(i, -1, 'the street line prints')
  assert.equal(all[i + 1], 'Elgin, IL 60123', 'city/state/ZIP prints as the very next line')
})

test('no Unicode minus reaches the page', () => {
  // U+2212 renders as NOTHING in Helvetica. A deposit once printed as a charge
  // rather than a credit because of it.
  const joined = textOf(buildInvoicePdf(PARTS, INVOICE, ASSETS)).join(' ')
  assert.ok(!joined.includes('−'))
})
