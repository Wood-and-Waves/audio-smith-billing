// Run: npm test
//
// These exist because an invoice dated 2026-08-10 rendered as 8/9/2026 in the
// browser: the formatter parsed the plain date as UTC midnight and then
// formatted it in Chicago time, moving it back five hours into the previous
// day. The stored value was right the whole time; only the display lied.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDateShort, formatDateLong, addDays, todayInChicago, isPlainDate,
  WEEKDAYS, weekdayIndex, monthLabel, addMonths, monthGrid,
} from '../../lib/dates.ts'

test('a plain date renders as the date it is, west of UTC', () => {
  // The original bug, verbatim.
  assert.equal(formatDateLong('2026-08-10'), '8/10/2026')
  assert.equal(formatDateShort('2026-08-10'), '8/10/26')
})

test('formatting holds across month, year and leap-day boundaries', () => {
  assert.equal(formatDateLong('2026-01-01'), '1/1/2026')
  assert.equal(formatDateLong('2025-12-31'), '12/31/2025')
  assert.equal(formatDateLong('2024-02-29'), '2/29/2024')
})

test('addDays stays in plain-date space', () => {
  assert.equal(addDays('2026-08-10', 30), '2026-09-09')
  assert.equal(addDays('2026-01-31', 1), '2026-02-01')
  assert.equal(addDays('2024-02-28', 1), '2024-02-29') // leap year
  assert.equal(addDays('2025-02-28', 1), '2025-03-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-08-10', 0), '2026-08-10')
})

test('Net 30 from every day of a month lands 30 days later', () => {
  for (let d = 1; d <= 28; d++) {
    const iso = `2026-06-${String(d).padStart(2, '0')}`
    const due = addDays(iso, 30)
    const days = (Date.parse(due + 'T00:00:00Z') - Date.parse(iso + 'T00:00:00Z')) / 86_400_000
    assert.equal(days, 30, `${iso} -> ${due}`)
  }
})

test('todayInChicago returns a well-formed plain date', () => {
  const today = todayInChicago()
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/)
  // Round-trips through the formatter without shifting.
  assert.equal(formatDateLong(today), new Intl.DateTimeFormat('en-US', {
    month: 'numeric', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(today + 'T00:00:00Z')))
})

// A cleared <input type="date"> submits "". Every helper here builds
// new Date(iso + 'T00:00:00Z'), and for "" that is an Invalid Date whose
// toISOString() THROWS — so addShowDays walking a range crashed with a
// RangeError instead of returning a message. isPlainDate is the guard.
test('isPlainDate rejects everything addDays cannot handle', () => {
  // These crash addDays outright.
  for (const bad of ['', '   ', '08/10/2026', 'today', '2026-8-10']) {
    assert.equal(isPlainDate(bad), false, `${JSON.stringify(bad)} should be rejected`)
    assert.throws(() => addDays(bad, 1))
  }

  // A partial date is worse than a crash: '2026-08' parses to Aug 1 and
  // returns a real-looking date, so a half-typed year-month would have
  // silently created days on dates nobody asked for. Shape is checked up
  // front for this reason, rather than catching what throws.
  assert.equal(isPlainDate('2026-08'), false)
  assert.equal(addDays('2026-08', 1), '2026-08-02')

  // Well-shaped but not a real date — why a regex alone is not enough.
  assert.equal(isPlainDate('2026-02-31'), false)
  assert.equal(isPlainDate('2026-13-01'), false)

  assert.equal(isPlainDate('2026-08-10'), true)
  assert.equal(isPlainDate('2024-02-29'), true)   // a real leap day
})

// ---------------------------------------------------------------------------
// Month-grid helpers, added for the calendar wave. Same UTC-pinned doctrine
// as the rest of this file: build with Date.UTC(y, m-1, d), read with
// getUTC*, never let the machine's local timezone touch these.

test('WEEKDAYS lists the seven day abbreviations, Sunday first', () => {
  assert.deepEqual(WEEKDAYS, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
})

test('monthLabel renders a full month name and year', () => {
  assert.equal(monthLabel('2026-08'), 'August 2026')
  assert.equal(monthLabel('2026-01'), 'January 2026')
  assert.equal(monthLabel('2026-12'), 'December 2026')
})

test('addMonths wraps the year both directions', () => {
  assert.equal(addMonths('2026-01', -1), '2025-12')
  assert.equal(addMonths('2026-12', 1), '2027-01')
  assert.equal(addMonths('2026-08', -1), '2026-07')
  assert.equal(addMonths('2026-08', 6), '2027-02')
})

test('weekdayIndex is UTC-pinned — no machine-timezone drift', () => {
  // 2026-08-01 is a Saturday (verified); the suite runs with TZ=America/Chicago
  // (see package.json) specifically so a local-time bug here would show up.
  assert.equal(weekdayIndex('2026-08-01'), 6)
  assert.equal(weekdayIndex('2026-08-02'), 0) // Sunday
  assert.equal(weekdayIndex('2026-01-01'), 4) // Thursday
})

test('monthGrid august 2026 runs sunday july twenty-sixth through saturday september fifth', () => {
  // 2026-08-01 is a Saturday (verified), so the Sun-first grid needs a full
  // leading week of July and spills into September to fill the last row.
  const grid = monthGrid('2026-08')
  assert.equal(grid.length, 6)
  for (const row of grid) assert.equal(row.length, 7)
  assert.equal(grid[0][0], '2026-07-26')
  assert.equal(grid[0][6], '2026-08-01')
  assert.equal(grid[5][6], '2026-09-05')
})

test('monthGrid pads a month that starts on Sunday with no leading days', () => {
  // 2026-11-01 is a Sunday: the grid should start exactly on the 1st.
  const grid = monthGrid('2026-11')
  assert.equal(grid[0][0], '2026-11-01')
  assert.equal(weekdayIndex('2026-11-01'), 0)
})

test('monthGrid rows are contiguous, Sunday-first, covering the whole month', () => {
  const grid = monthGrid('2026-02') // short month, leap-adjacent
  const flat = grid.flat()
  // No gaps or repeats: consecutive calendar dates throughout.
  for (let i = 1; i < flat.length; i++) {
    assert.equal(addDays(flat[i - 1], 1), flat[i], `${flat[i - 1]} -> ${flat[i]}`)
  }
  // Every day of February 2026 is present exactly once.
  for (let d = 1; d <= 28; d++) {
    const iso = `2026-02-${String(d).padStart(2, '0')}`
    assert.equal(flat.filter((x) => x === iso).length, 1, iso)
  }
  // Sunday-first: every row's first column is a Sunday.
  for (const row of grid) assert.equal(weekdayIndex(row[0]), 0)
})
