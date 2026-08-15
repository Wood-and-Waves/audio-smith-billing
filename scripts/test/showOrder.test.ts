// Closest first. The list used to be ordered by created_at — the order Dan
// happened to type shows in, which tells him nothing a month later.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byDateClosestFirst, whenIs } from '../../lib/showOrder.ts'

const TODAY = '2026-08-15'
const show = (name: string, from: string, to: string) => {
  const dates: string[] = []
  for (let d = from; d <= to; ) {
    dates.push(d)
    const [y, m, day] = d.split('-').map(Number)
    const next = new Date(Date.UTC(y, m - 1, day + 1))
    d = next.toISOString().slice(0, 10)
  }
  return { name, dates }
}
const order = (shows: { name: string; dates: string[] }[]) =>
  byDateClosestFirst(shows, TODAY).map((s) => s.name)

test('the next show comes first', () => {
  assert.deepEqual(
    order([
      show('Orlando', '2026-08-28', '2026-09-03'),
      show('San Diego', '2026-08-22', '2026-08-27'),
    ]),
    ['San Diego', 'Orlando'],
  )
})

test('a show already under way outranks one that has not started', () => {
  // Bucketing on the FIRST day would file a trip that began yesterday under
  // history, when it is the most relevant thing on the screen.
  const running = show('In progress', '2026-08-14', '2026-08-20')
  assert.equal(whenIs(running, TODAY), 'current')
  assert.deepEqual(
    order([show('Next month', '2026-09-10', '2026-09-12'), running]),
    ['In progress', 'Next month'],
  )
})

test('finished shows come after upcoming ones, most recent first', () => {
  assert.deepEqual(
    order([
      show('Long ago', '2026-05-01', '2026-05-03'),
      show('Upcoming', '2026-08-22', '2026-08-27'),
      show('Last week', '2026-08-05', '2026-08-08'),
    ]),
    ['Upcoming', 'Last week', 'Long ago'],
  )
})

test('a show with no days yet sits at the very top', () => {
  // It has no days because it is being set up right now.
  assert.deepEqual(
    order([
      show('Upcoming', '2026-08-22', '2026-08-27'),
      { name: 'Just created', dates: [] },
      show('Finished', '2026-07-01', '2026-07-03'),
    ]),
    ['Just created', 'Upcoming', 'Finished'],
  )
  assert.equal(whenIs({ dates: [] }, TODAY), 'planning')
})

test('a show ending today still counts as current', () => {
  const endingToday = show('Ends today', '2026-08-13', TODAY)
  assert.equal(whenIs(endingToday, TODAY), 'current')
  assert.deepEqual(
    order([show('Finished yesterday', '2026-08-10', '2026-08-14'), endingToday]),
    ['Ends today', 'Finished yesterday'],
  )
})

test('the input array is not mutated', () => {
  // The page passes the array it renders from; sorting in place would reorder
  // it under the caller.
  const input = [
    show('B', '2026-09-01', '2026-09-02'),
    show('A', '2026-08-20', '2026-08-21'),
  ]
  byDateClosestFirst(input, TODAY)
  assert.deepEqual(input.map((s) => s.name), ['B', 'A'])
})

test('days in any order still sort correctly', () => {
  // dates comes from a Supabase embed with no ORDER BY, so it arrives unsorted.
  const scrambled = { name: 'Scrambled', dates: ['2026-08-27', '2026-08-22', '2026-08-25'] }
  assert.deepEqual(
    order([show('Later', '2026-08-24', '2026-08-24'), scrambled]),
    ['Scrambled', 'Later'],
  )
})
