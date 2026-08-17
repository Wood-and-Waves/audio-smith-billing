// publicBackup is the guard that keeps receipt PHOTOS and storage PATHS out of
// the public download: it maps a frozen snapshot to the PDF's backup shape with
// every image nulled and every path dropped, while preserving the hours and
// expense itemisation the client already saw in the emailed PDF.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicBackup } from '../../lib/publicInvoiceBackup.ts'

const SNAPSHOT = {
  show_hours: true,
  shows: [{
    name: 'Willow Creek', zone_label: 'Chicago',
    days: [{
      day: '2026-08-01', in: '09:00', out: '17:00', meal_minutes: 30,
      net_hours: 7.5, st_hours: 7.5, ot_hours: 0, dt_hours: 0,
      travel_in: false, travel_out: false, half_day: false, meal_penalties: 0,
    }],
  }],
  total_net: 7.5, total_st: 7.5, total_ot: 0, total_dt: 0,
  expenses: [{
    category: 'meals', where_spent: 'Panera', amount_cents: 1875, spent_on: '2026-08-01',
    receipt_path: 'owner-uuid/receipt-abc.jpg',
  }],
}

test('a null or non-object snapshot yields undefined (no backup pages)', () => {
  assert.equal(publicBackup(null), undefined)
  assert.equal(publicBackup(undefined), undefined)
  assert.equal(publicBackup('nope'), undefined)
})

test('expense images are nulled and receipt paths are dropped', () => {
  const b = publicBackup(SNAPSHOT)
  assert.ok(b, 'a snapshot produces a backup')
  assert.equal(b.expenses.length, 1)
  const e = b.expenses[0]
  assert.equal(e.receiptDataUri, null, 'no image')
  assert.ok(!('receipt_path' in e), 'no storage path carried through')
  assert.equal(e.category, 'meals')
  assert.equal(e.where_spent, 'Panera')
  assert.equal(e.amount_cents, 1875)
  assert.equal(e.spent_on, '2026-08-01')
})

test('hours itemisation is preserved', () => {
  const b = publicBackup(SNAPSHOT)
  assert.ok(b)
  assert.equal(b.show_hours, true)
  assert.equal(b.total_net, 7.5)
  assert.equal(b.shows.length, 1)
  assert.equal(b.shows[0].days[0].net_hours, 7.5)
})

test('a snapshot with no expenses maps to an empty expense list', () => {
  const b = publicBackup({ ...SNAPSHOT, expenses: [] })
  assert.ok(b)
  assert.deepEqual(b.expenses, [])
})
