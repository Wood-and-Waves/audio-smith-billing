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
