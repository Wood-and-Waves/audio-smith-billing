// Run: npm run test:money
//
// The reconciliation cases at the bottom are real invoices out of the Google
// Sheet. If this file ever fails, the app has started disagreeing with
// invoices Dan has already sent to clients.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  roundCents,
  parseUSD,
  formatUSD,
  formatAmount,
  parseQty,
  formatQty,
  lineTotal,
  taxOn,
  computeTotals,
  balanceCents,
  travelRateFrom,
  overtimeRateFrom,
  doubleTimeRateFrom,
} from '../../lib/money.ts'

test('roundCents rounds half away from zero', () => {
  assert.equal(roundCents(0.5), 1)
  assert.equal(roundCents(1.5), 2)
  assert.equal(roundCents(2.4), 2)
  assert.equal(roundCents(-0.5), -1) // Math.round alone gives -0 here
  assert.equal(roundCents(-1.5), -2)
  assert.equal(roundCents(-2.4), -2)
})

test('parseUSD survives the classic float traps', () => {
  // parseFloat("19.99") * 100 === 1998.9999999999998
  assert.equal(parseUSD('19.99'), 1999)
  assert.equal(parseUSD('0.29'), 29)
  assert.equal(parseUSD('1.005'), 100) // extra precision truncated, not rounded up
  assert.equal(parseUSD('$1,234.56'), 123456)
  assert.equal(parseUSD('  $780  '), 78000)
  assert.equal(parseUSD('.5'), 50)
  assert.equal(parseUSD('5.'), 500)
})

test('parseUSD handles negatives, blanks and junk', () => {
  assert.equal(parseUSD('(5.75)'), -575)
  assert.equal(parseUSD('-5.75'), -575)
  assert.equal(parseUSD(''), 0)
  assert.equal(parseUSD('   '), 0)
  assert.equal(parseUSD(null), null)
  assert.equal(parseUSD(undefined), null)
  assert.equal(parseUSD('abc'), null)
  assert.equal(parseUSD('1.2.3'), null)
  assert.equal(parseUSD('.'), null)
})

test('formatting', () => {
  assert.equal(formatUSD(123456), '$1,234.56')
  assert.equal(formatUSD(0), '$0.00')
  assert.equal(formatUSD(78000), '$780.00')
  assert.equal(formatUSD(-575), '-$5.75')
  assert.equal(formatAmount(123456), '1234.56')
  assert.equal(formatAmount(50), '0.50')
})

test('quantity keeps fractional hours exact', () => {
  assert.equal(parseQty('4.5'), 450)
  assert.equal(parseQty('0.25'), 25)
  assert.equal(parseQty('6'), 600)
  assert.equal(parseQty(''), 0)
  assert.equal(parseQty('abc'), null)
  assert.equal(formatQty(600), '6')
  assert.equal(formatQty(450), '4.5')
})

test('lineTotal is exact for fractional quantities', () => {
  assert.equal(lineTotal(450, 10636), 47862) // 4.5 x $106.36 = $478.62
  assert.equal(lineTotal(600, 78000), 468000) // 6 x $780 = $4,680
  assert.equal(lineTotal(25, 10000), 2500) // 0.25 x $100 = $25
  assert.equal(lineTotal(300, 1), 3) // 3 x $0.01
  assert.equal(lineTotal(0, 78000), 0)
})

test('tax uses basis points', () => {
  assert.equal(taxOn(10000, 0), 0)
  assert.equal(taxOn(10000, 825), 825) // 8.25% of $100
  assert.equal(taxOn(60000, 625), 3750) // 6.25% of $600 (Illinois)
})

test('deposit is subtracted after tax, not treated as a discount', () => {
  const t = computeTotals([{ qtyHundredths: 100, unitPriceCents: 10000 }], {
    taxBasisPoints: 1000,
    depositCents: 5000,
  })
  assert.equal(t.subtotalCents, 10000)
  assert.equal(t.taxCents, 1000) // taxed on the full $100, not on $50
  assert.equal(t.totalCents, 6000) // 100 + 10 - 50
})

test('balance reflects recorded payments', () => {
  assert.equal(balanceCents(60000, []), 60000)
  assert.equal(balanceCents(60000, [20000, 20000]), 20000)
  assert.equal(balanceCents(60000, [60000]), 0)
})

test('derived rates match the rates Dan actually billed', () => {
  // Streamline: $780 day rate
  assert.equal(travelRateFrom(78000), 39000) // billed as "Travel Days" $390
  assert.equal(overtimeRateFrom(78000, 10), 11700) // billed as $117.00
  assert.equal(overtimeRateFrom(78000, 11), 10636) // billed as $106.36
  // JRP Live: $600 day rate
  assert.equal(overtimeRateFrom(60000, 10), 9000) // billed as $90.00
  // Willow Creek / Reach: $550 day rate
  assert.equal(overtimeRateFrom(55000, 10), 8250) // billed as $82.50
  assert.equal(doubleTimeRateFrom(60000, 10), 12000) // billed as $120.00
  assert.equal(overtimeRateFrom(78000, 0), 0) // no divide-by-zero
})

// --- Reconciliation against invoices already sent to clients --------------

test('invoice #303 (Streamline, 2023-09-25) reconciles', () => {
  const t = computeTotals(
    [
      { qtyHundredths: 500, unitPriceCents: 78000 }, // 5 x Day Rate $780
      { qtyHundredths: 200, unitPriceCents: 39000 }, // 2 x Travel Days $390
      { qtyHundredths: 100, unitPriceCents: 39981 }, // 1 x Expenses $399.81
    ],
    { depositCents: 330000 }, // $3,300 deposit
  )
  assert.equal(t.subtotalCents, 507981) // $5,079.81
  assert.equal(t.totalCents, 177981) // $1,779.81 — matches the sheet
})

test('invoice #312 (Streamline, 2024-03-11) reconciles, incl. $106.36 overtime', () => {
  const t = computeTotals(
    [
      { qtyHundredths: 500, unitPriceCents: 78000 },
      { qtyHundredths: 200, unitPriceCents: 39000 },
      { qtyHundredths: 800, unitPriceCents: 10636 }, // 8 x Overtime $106.36
      { qtyHundredths: 100, unitPriceCents: 18000 }, // Travel to/from OHare
      { qtyHundredths: 200, unitPriceCents: 5000 }, // 2 x Baggage $50
    ],
    { depositCents: 468000 },
  )
  assert.equal(t.subtotalCents, 581088) // $5,810.88
  assert.equal(t.totalCents, 113088) // $1,130.88 — matches the sheet
})

test('invoice #320 (JRP Live, 2024-04-04) reconciles', () => {
  const t = computeTotals(
    [
      { qtyHundredths: 400, unitPriceCents: 60000 }, // 4 x Day Rate $600
      { qtyHundredths: 500, unitPriceCents: 9000 }, // 5 x Overtime $90
      { qtyHundredths: 400, unitPriceCents: 6500 }, // 4 x Per Diem $65
      { qtyHundredths: 100, unitPriceCents: 2400 }, // Parking $24
    ],
    { depositCents: 26000 },
  )
  assert.equal(t.subtotalCents, 313400) // $3,134.00
  assert.equal(t.totalCents, 287400) // $2,874.00 — matches the sheet
})

test('invoice #280 (Reach Communications, 2023-05-02) reconciles a $5.75 deposit', () => {
  const t = computeTotals(
    [
      { qtyHundredths: 200, unitPriceCents: 25000 }, // 2 x Travel days $250
      { qtyHundredths: 400, unitPriceCents: 55000 }, // 4 x Day Rate $550
      { qtyHundredths: 100, unitPriceCents: 55000 }, // Day Rate - Pre work
      { qtyHundredths: 100, unitPriceCents: 11000 }, // Airport Parking
      { qtyHundredths: 100, unitPriceCents: 5075 }, // Uber $50.75
      { qtyHundredths: 100, unitPriceCents: 37580 }, // Flight $375.80
      { qtyHundredths: 500, unitPriceCents: 6500 }, // 5 x Per Diem $65
    ],
    { depositCents: 575 },
  )
  assert.equal(t.subtotalCents, 411155) // $4,111.55
  assert.equal(t.totalCents, 410580) // $4,105.80 — matches the sheet
})
