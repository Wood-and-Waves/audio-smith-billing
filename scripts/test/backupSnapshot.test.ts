// The frozen backup. Pure — no database, no clock, no rendering.
//
// The invariant under test is the one the whole feature rests on: what the
// hours page CLAIMS must equal what the invoice CHARGES.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBackupSnapshot, dayLabel, type SnapshotInput } from '../../lib/backupSnapshot.ts'
import { computeShowLines, type ShowRates } from '../../lib/showBuckets.ts'
import type { ShowRuleset, ShowDayLike } from '../../lib/payroll.ts'

// These field lists are the real ones from lib/payroll.ts and
// lib/showBuckets.ts — checked, not remembered. Every field is required.
const RULES: ShowRuleset = {
  overtime_after_hours: 10,
  double_time_enabled: false,
  double_time_after_hours: 0,
  meal_penalty_enabled: true,
  meal_penalty_grace_hours: 6,
  minimum_meal_break_enabled: true,
  minimum_meal_break_minutes: 30,
  meal_break_deduction_cap: 60,
  short_turn_penalty_enabled: false,
  short_turn_rest_hours: 8,
  continuous_time_enabled: false,
}
const RATES: ShowRates = {
  day_rate_cents: 78000, travel_rate_cents: 39000, pm_rate_cents: 8500,
  ot_rate_cents: 11700, dt_rate_cents: 15600, meal_penalty_cents: 5000,
}

/** `2026-08-30` + 1 -> `2026-08-31`, in UTC so it can't skip a day locally. */
const addDays = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/**
 * A worked day in Eastern: punches are instants, so build them as UTC.
 *
 * Rolls the end punch to the next calendar day when its clock time is not
 * after the start's (both are zero-padded HH:MM, so string comparison is
 * exact) — an overnight shift's "end" is always after midnight, and without
 * this both punches would land on the same date, making the end punch land
 * BEFORE the start and the gross duration clamp to zero.
 */
const day = (date: string, startZ: string, endZ: string, over: Partial<ShowDayLike> = {}) => ({
  id: `d-${date}`,
  date,
  travel_in: false, travel_out: false, pay_as_half_day: false,
  punches: [
    { punch_type: 'start', punched_at: `${date}T${startZ}:00.000Z` },
    { punch_type: 'end', punched_at: `${endZ <= startZ ? addDays(date, 1) : date}T${endZ}:00.000Z` },
  ],
  ...over,
}) as ShowDayLike

const show = (days: ShowDayLike[], over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  name: 'PwC Orlando', timezone: 'America/New_York', days, rules: RULES, expenses: [], ...over,
})

test('the OT on the page equals the OT on the invoice', () => {
  // THE invariant. Two views of the same work, computed by different code, that
  // must never disagree — this project has shipped a $1,560 overbill, a preview
  // reading $5,850 against an invoice of $6,226.21, and an itemisation $120
  // adrift. Each was two views drifting apart.
  const days = [
    day('2026-08-30', '12:00', '00:30'),  // 12.5h gross, 12.0 net after meal
    day('2026-08-31', '13:00', '23:00'),  // 9.5 net
    day('2026-09-01', '12:00', '01:00'),  // 12.0 net
  ]
  const snap = buildBackupSnapshot({ shows: [show(days)], showHours: true })
  const lines = computeShowLines(days, [], RATES, RULES)

  const otLine = lines.find((l) => l.description === 'Overtime')
  assert.ok(otLine, 'this fixture is meant to generate overtime')
  assert.equal(snap.total_ot, otLine.qty_hundredths / 100,
    'the hours page and the invoice disagree about overtime')
})

test('straight time reconciles too', () => {
  // A whole-hour shift, deliberately: paidNetHours ceiling-rounds PER DAY
  // before splitting into ST/OT (lib/payroll.ts), so raw net_hours only equals
  // ST+OT when the day's net is already an integer. A fractional day (e.g. the
  // 12.5h fixture above) would fail this by design, not by a snapshot bug.
  const days = [day('2026-08-30', '12:00', '00:00')]  // exactly 12h, no meal
  const snap = buildBackupSnapshot({ shows: [show(days)], showHours: true })
  assert.equal(snap.total_st + snap.total_ot, snap.total_net,
    'ST + OT must account for every net hour')
})

test('clock times are frozen in the show zone, not the machine zone', () => {
  // 12:00Z on 30 Aug is 8:00 AM Eastern and 7:00 AM Central. If this ever
  // rendered as 7:00 the show's zone is being ignored.
  const snap = buildBackupSnapshot({
    shows: [show([day('2026-08-30', '12:00', '00:30')])], showHours: true,
  })
  assert.equal(snap.shows[0].days[0].in, '8:00 AM')
  assert.equal(snap.shows[0].zone_label, 'Eastern')

  const central = buildBackupSnapshot({
    shows: [show([day('2026-08-30', '12:00', '00:30')], { timezone: 'America/Chicago' })],
    showHours: true,
  })
  assert.equal(central.shows[0].days[0].in, '7:00 AM', 'the same instant, a different clock')
})

test('a travel day is labelled, not given hours', () => {
  const travel = {
    id: 'd-travel', date: '2026-08-29', travel_in: true, travel_out: false,
    pay_as_half_day: false, punches: [],
  } as ShowDayLike
  const snap = buildBackupSnapshot({ shows: [show([travel])], showHours: true })
  const d = snap.shows[0].days[0]
  assert.equal(d.travel_in, true)
  assert.equal(d.in, null, 'no punches means no clock times, not a fabricated pair')
  assert.equal(d.net_hours, 0)
})

test('the flag off still records the hours, it only stops them rendering', () => {
  // The data is frozen either way, so turning the option on for a billed
  // invoice later has something to show.
  const snap = buildBackupSnapshot({
    shows: [show([day('2026-08-30', '12:00', '00:30')])], showHours: false,
  })
  assert.equal(snap.show_hours, false)
  assert.equal(snap.shows[0].days.length, 1, 'the rows are captured regardless')
})

test('expenses are frozen onto the snapshot with their receipt paths', () => {
  const snap = buildBackupSnapshot({
    shows: [show([], { expenses: [{
      id: 'e1', category: 'meals', where_spent: 'HMS Host',
      amount_cents: 1998, spent_on: '2026-08-29', receipt_path: 'owner/show/x-enhanced.jpg',
    }] })],
    showHours: false,
  })
  assert.equal(snap.expenses.length, 1)
  assert.equal(snap.expenses[0].amount_cents, 1998)
  assert.equal(snap.expenses[0].receipt_path, 'owner/show/x-enhanced.jpg',
    'the path is what can be frozen — the bucket is private and its URLs expire')
})

test('no prep data reaches the snapshot', () => {
  // Deliberately absent: prep is work done at home weeks earlier, it bills as
  // its own PM Hours line, and its minutes round UP to the next whole hour so
  // showing them raw beside that line reads as an overcharge.
  const snap = buildBackupSnapshot({
    shows: [show([day('2026-08-30', '12:00', '00:30')])], showHours: true,
  })
  assert.equal(JSON.stringify(snap).includes('pm'), false, 'no pm key anywhere')
})

test('day labels carry the weekday, deterministically', () => {
  assert.equal(dayLabel('2026-08-30'), 'Sun 8/30')
  assert.equal(dayLabel('2026-09-01'), 'Tue 9/1')
})

test('totals sum across several shows', () => {
  const a = show([day('2026-08-30', '12:00', '00:30')])
  const b = show([day('2026-09-05', '13:00', '23:00')], { name: 'Second' })
  const snap = buildBackupSnapshot({ shows: [a, b], showHours: true })
  assert.equal(snap.shows.length, 2)
  assert.equal(snap.total_net,
    snap.shows.flatMap((s) => s.days).reduce((t, d) => t + d.net_hours, 0))
})
