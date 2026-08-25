// Run: npm test -- scripts/test/showRuns.test.ts
//
// The calendar's bar geometry. Dan's corner rule — a true start/finish is
// rounded, a week-boundary continuation is square — reduces entirely to the
// continuesLeft/continuesRight flags asserted here, so these tests are what
// keep the rendered corners honest.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contiguousRuns, segmentForWeek, layOutWeek, layOutMonth, MAX_LANES } from '../../lib/showRuns.ts'
import { monthGrid, addDays } from '../../lib/dates.ts'

const day = (showId: string, date: string, showName = showId) => ({ showId, showName, date })

// The real September 2026 grid rows this feature was designed against.
const W_AUG30 = ['2026-08-30','2026-08-31','2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05']
const W_SEP13 = ['2026-09-13','2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-19']
const W_SEP20 = ['2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26']

test('a contiguous block of days is ONE run', () => {
  const runs = contiguousRuns([
    day('a', '2026-09-13'), day('a', '2026-09-14'), day('a', '2026-09-15'),
  ])
  assert.deepEqual(runs, [{ showId: 'a', showName: 'a', start: '2026-09-13', end: '2026-09-15' }])
})

test('a gap splits one show into two runs — a bar must never paper over a day he is not working', () => {
  const runs = contiguousRuns([
    day('a', '2026-09-13'), day('a', '2026-09-14'),
    day('a', '2026-09-17'), day('a', '2026-09-18'),
  ])
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map((r) => [r.start, r.end]), [
    ['2026-09-13', '2026-09-14'], ['2026-09-17', '2026-09-18'],
  ])
})

test('a single day is a run of one, and unsorted input still groups correctly', () => {
  const runs = contiguousRuns([day('b', '2026-09-15'), day('a', '2026-09-14'), day('a', '2026-09-13')])
  assert.deepEqual(runs, [
    { showId: 'a', showName: 'a', start: '2026-09-13', end: '2026-09-14' },
    { showId: 'b', showName: 'b', start: '2026-09-15', end: '2026-09-15' },
  ])
})

test('two shows never merge into one run even on adjacent days', () => {
  const runs = contiguousRuns([day('a', '2026-09-13'), day('b', '2026-09-14')])
  assert.equal(runs.length, 2)
})

test('a run inside one week: rounded on BOTH ends', () => {
  const seg = segmentForWeek(
    { showId: 'a', showName: 'BMS', start: '2026-09-13', end: '2026-09-17' }, W_SEP13,
  )
  assert.deepEqual(seg, { startCol: 0, span: 5, continuesLeft: false, continuesRight: false })
})

test("Dan's real PwC run (8/28-9/3) is SQUARE on the left in the 8/30 week — it arrived from August", () => {
  const seg = segmentForWeek(
    { showId: 'p', showName: 'PwC', start: '2026-08-28', end: '2026-09-03' }, W_AUG30,
  )
  assert.deepEqual(seg, { startCol: 0, span: 5, continuesLeft: true, continuesRight: false })
})

test("Children's Health (9/17-9/20) is square where it crosses and rounded where it truly ends", () => {
  const run = { showId: 'c', showName: 'CHF', start: '2026-09-17', end: '2026-09-20' }
  assert.deepEqual(segmentForWeek(run, W_SEP13), { startCol: 4, span: 3, continuesLeft: false, continuesRight: true })
  assert.deepEqual(segmentForWeek(run, W_SEP20), { startCol: 0, span: 1, continuesLeft: true, continuesRight: false })
})

test('a run that swallows the whole week is square on both sides', () => {
  const seg = segmentForWeek(
    { showId: 'x', showName: 'X', start: '2026-09-01', end: '2026-12-01' }, W_SEP13,
  )
  assert.deepEqual(seg, { startCol: 0, span: 7, continuesLeft: true, continuesRight: true })
})

test('a run outside the week yields no segment', () => {
  assert.equal(segmentForWeek({ showId: 'a', showName: 'A', start: '2026-10-01', end: '2026-10-02' }, W_SEP13), null)
  assert.equal(segmentForWeek({ showId: 'a', showName: 'A', start: '2026-09-01', end: '2026-09-02' }, W_SEP13), null)
})

test('overlapping runs take separate lanes; a finished lane is REUSED', () => {
  const runs = contiguousRuns([
    ...['2026-09-13','2026-09-14','2026-09-15','2026-09-16','2026-09-17'].map((d) => day('bms', d, 'BMS')),
    ...['2026-09-17','2026-09-18','2026-09-19'].map((d) => day('chf', d, 'CHF')),
  ])
  const { bars, overflowByCol } = layOutWeek(runs, W_SEP13)
  assert.deepEqual(bars.map((b) => [b.showName, b.lane, b.startCol, b.span]), [
    ['BMS', 0, 0, 5], ['CHF', 1, 4, 3],
  ])
  assert.deepEqual(overflowByCol, [0, 0, 0, 0, 0, 0, 0])

  // Same week, no overlap: the second run drops back to lane 0.
  const apart = contiguousRuns([
    day('a', '2026-09-13', 'A'), day('a', '2026-09-14', 'A'),
    day('b', '2026-09-17', 'B'), day('b', '2026-09-18', 'B'),
  ])
  assert.deepEqual(layOutWeek(apart, W_SEP13).bars.map((b) => b.lane), [0, 0])
})

test('beyond MAX_LANES a segment is NOT drawn and counts into overflowByCol on every column it covers', () => {
  const days = []
  for (let i = 0; i < MAX_LANES + 1; i++) {
    days.push(day(`s${i}`, '2026-09-14', `S${i}`), day(`s${i}`, '2026-09-15', `S${i}`))
  }
  const { bars, overflowByCol } = layOutWeek(contiguousRuns(days), W_SEP13)
  assert.equal(bars.length, MAX_LANES)
  assert.deepEqual(overflowByCol, [0, 1, 1, 0, 0, 0, 0])
})

test('lane order is stable — identical input gives an identical layout', () => {
  const days = [
    day('z', '2026-09-13', 'Z'), day('z', '2026-09-16', 'Z'),
    day('a', '2026-09-13', 'A'), day('a', '2026-09-15', 'A'),
  ]
  const once = layOutWeek(contiguousRuns(days), W_SEP13).bars
  const twice = layOutWeek(contiguousRuns([...days].reverse()), W_SEP13).bars
  assert.deepEqual(once, twice)
})

// --- layOutMonth: a run must not step lanes at a week boundary ---------------

// The grid the feature was designed against: Sep 2026 starts on a Tuesday,
// so week 2 is Sep 13-19 and week 3 is Sep 20-26.
const SEP = monthGrid('2026-09')
const W_OF_13 = 2
const W_OF_20 = 3

const spanDays = (showId: string, showName: string, from: string, to: string) => {
  const out = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(day(showId, d, showName))
  return out
}

test("layOutMonth: Children's Health keeps ONE lane across the 9/19-9/20 break", () => {
  const runs = contiguousRuns([
    ...spanDays('bms', 'BMS', '2026-09-13', '2026-09-17'),
    ...spanDays('chf', 'CHF', '2026-09-17', '2026-09-20'),
  ])

  // The bug, for the record: per-week greedy puts CHF on lane 1 beside BMS
  // and then on lane 0 once BMS is gone — the bar steps up a row.
  assert.equal(layOutWeek(runs, SEP[W_OF_13]).bars.find((b) => b.showName === 'CHF')!.lane, 1)
  assert.equal(layOutWeek(runs, SEP[W_OF_20]).bars.find((b) => b.showName === 'CHF')!.lane, 0)

  const month = layOutMonth(runs, SEP)
  const before = month[W_OF_13].bars.find((b) => b.showName === 'CHF')!
  const after = month[W_OF_20].bars.find((b) => b.showName === 'CHF')!
  assert.equal(before.lane, after.lane)
  assert.equal(before.continuesRight, true)
  assert.equal(after.continuesLeft, true)
  // BMS is untouched: it never crosses, so it still owns lane 0.
  assert.equal(month[W_OF_13].bars.find((b) => b.showName === 'BMS')!.lane, 0)
})

test('layOutMonth: an uncontested run crossing a boundary stays on lane 0', () => {
  const runs = contiguousRuns(spanDays('a', 'A', '2026-09-17', '2026-09-22'))
  const month = layOutMonth(runs, SEP)
  assert.deepEqual(month[W_OF_13].bars.map((b) => b.lane), [0])
  assert.deepEqual(month[W_OF_20].bars.map((b) => b.lane), [0])
})

test('layOutMonth: a three-week run holds one lane the whole way', () => {
  const runs = contiguousRuns([
    // `early` claims lane 0 in the first week, pushing `long` to lane 1.
    ...spanDays('early', 'EARLY', '2026-09-07', '2026-09-12'),
    ...spanDays('long', 'LONG', '2026-09-08', '2026-09-24'),
    ...spanDays('p', 'P', '2026-09-14', '2026-09-15'),
  ])

  // Per-week greedy would drop LONG from lane 1 to lane 0 the moment EARLY
  // finishes — the bar steps DOWN a row mid-booking.
  assert.equal(layOutWeek(runs, SEP[1]).bars.find((b) => b.showName === 'LONG')!.lane, 1)
  assert.equal(layOutWeek(runs, SEP[2]).bars.find((b) => b.showName === 'LONG')!.lane, 0)

  const month = layOutMonth(runs, SEP)
  const lanes = [1, 2, 3].map((w) => month[w].bars.find((b) => b.showName === 'LONG')!.lane)
  assert.deepEqual(lanes, [1, 1, 1])
  // P was placed AROUND the pinned lane, not dropped.
  assert.equal(month[2].bars.find((b) => b.showName === 'P')!.lane, 0)
})

test('layOutMonth: one entry per week, and a single-week layout matches layOutWeek', () => {
  const runs = contiguousRuns([
    ...spanDays('bms', 'BMS', '2026-09-13', '2026-09-17'),
    ...spanDays('chf', 'CHF', '2026-09-17', '2026-09-19'),
  ])
  assert.equal(layOutMonth(runs, SEP).length, SEP.length)

  const solo = layOutMonth(runs, [W_SEP13])
  assert.equal(solo.length, 1)
  assert.deepEqual(solo[0], layOutWeek(runs, W_SEP13))
})

test('layOutMonth: overflow beyond MAX_LANES still counts into overflowByCol', () => {
  const days = []
  for (let i = 0; i < MAX_LANES + 1; i++) {
    days.push(...spanDays(`s${i}`, `S${i}`, '2026-09-14', '2026-09-15'))
  }
  const week = layOutMonth(contiguousRuns(days), SEP)[W_OF_13]
  assert.equal(week.bars.length, MAX_LANES)
  assert.deepEqual(week.overflowByCol, [0, 1, 1, 0, 0, 0, 0])
})
