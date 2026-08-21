import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  workingBalance, clearedBalance, compareLedgerOrder, runningBalances,
} from '../../lib/ledgerBalance.ts'
import type { LedgerOrderKey } from '../../lib/ledgerBalance.ts'

const T = (amount_cents: number, cleared: 'uncleared' | 'cleared' | 'reconciled') =>
  ({ amount_cents, cleared })

test('working balance counts everything, cleared balance skips uncleared', () => {
  const txns = [T(60000, 'reconciled'), T(-4253, 'cleared'), T(-10000, 'uncleared')]
  assert.equal(workingBalance(1000, txns), 46747)
  assert.equal(clearedBalance(1000, txns), 56747)
})

test('no transactions: both balances are the opening balance', () => {
  assert.equal(workingBalance(123456, []), 123456)
  assert.equal(clearedBalance(123456, []), 123456)
})

// --- compareLedgerOrder ---------------------------------------------------

const K = (date: string, created_at: string, id: string): LedgerOrderKey =>
  ({ date, created_at, id })

test('compareLedgerOrder: date is the primary key', () => {
  const earlier = K('2026-01-01', '2026-01-01T09:00:00Z', 'z')
  const later = K('2026-01-02', '2026-01-01T01:00:00Z', 'a')
  assert.ok(compareLedgerOrder(earlier, later) < 0)
  assert.ok(compareLedgerOrder(later, earlier) > 0)
})

test('compareLedgerOrder: same date, created_at breaks the tie', () => {
  const first = K('2026-01-01', '2026-01-01T09:00:00Z', 'zzz')
  const second = K('2026-01-01', '2026-01-01T10:00:00Z', 'aaa')
  assert.ok(compareLedgerOrder(first, second) < 0)
  assert.ok(compareLedgerOrder(second, first) > 0)
})

test('compareLedgerOrder: same date and created_at, id breaks the tie', () => {
  const first = K('2026-01-01', '2026-01-01T09:00:00Z', 'aaa')
  const second = K('2026-01-01', '2026-01-01T09:00:00Z', 'bbb')
  assert.ok(compareLedgerOrder(first, second) < 0)
  assert.ok(compareLedgerOrder(second, first) > 0)
})

test('compareLedgerOrder: identical keys compare equal', () => {
  const key = K('2026-01-01', '2026-01-01T09:00:00Z', 'aaa')
  assert.equal(compareLedgerOrder(key, { ...key }), 0)
})

test('compareLedgerOrder: total order, so sorting a reversed array converges '
  + 'on the same result as sorting the original', () => {
  const keys = [
    K('2026-01-01', '2026-01-01T08:00:00Z', 'a1'),
    K('2026-01-01', '2026-01-01T09:00:00Z', 'a2'),
    K('2026-01-02', '2026-01-02T08:00:00Z', 'b1'),
    K('2026-01-02', '2026-01-02T08:00:00Z', 'b2'),
    K('2026-01-03', '2026-01-03T07:00:00Z', 'c1'),
    K('2026-01-03', '2026-01-03T07:30:00Z', 'c2'),
    K('2026-01-05', '2026-01-05T00:00:00Z', 'd0'),
    K('2026-01-05', '2026-01-05T00:00:00Z', 'd1'),
  ]
  const sortedForward = [...keys].sort(compareLedgerOrder)
  const sortedFromReversed = [...keys].reverse().sort(compareLedgerOrder)
  assert.deepEqual(sortedFromReversed, sortedForward)
})

// --- runningBalances -------------------------------------------------------

test('runningBalances: known sequence, prefix sums after each txn', () => {
  const txns = [{ amount_cents: 500 }, { amount_cents: -200 }, { amount_cents: 300 }]
  assert.deepEqual(runningBalances(1000, txns), [1500, 1300, 1600])
})

test('runningBalances: empty transactions returns empty array', () => {
  assert.deepEqual(runningBalances(123456, []), [])
})

test('runningBalances: negative balances flow through unclamped', () => {
  const txns = [{ amount_cents: -50 }, { amount_cents: -100 }]
  assert.deepEqual(runningBalances(100, txns), [50, -50])
})

test('runningBalances: invariant — last balance equals workingBalance over the '
  + 'same rows, sorted into ledger order from a shuffled start', () => {
  const rows = [
    { ...K('2026-01-01', '2026-01-01T08:00:00Z', 'a1'), amount_cents: 1000 },
    { ...K('2026-01-01', '2026-01-01T09:00:00Z', 'a2'), amount_cents: -500 },
    { ...K('2026-01-02', '2026-01-02T08:00:00Z', 'b1'), amount_cents: 2000 },
    { ...K('2026-01-02', '2026-01-02T08:00:00Z', 'b2'), amount_cents: -300 },
    { ...K('2026-01-03', '2026-01-03T07:00:00Z', 'c1'), amount_cents: -1500 },
    { ...K('2026-01-03', '2026-01-03T07:30:00Z', 'c2'), amount_cents: 400 },
    { ...K('2026-01-05', '2026-01-05T00:00:00Z', 'd0'), amount_cents: 250 },
    { ...K('2026-01-05', '2026-01-05T00:00:00Z', 'd1'), amount_cents: -700 },
  ]
  // Fixed (non-identity, non-sorted) permutation — deterministic, not random.
  const shuffleOrder = [4, 0, 7, 2, 5, 1, 6, 3]
  const shuffled = shuffleOrder.map((i) => rows[i])
  const sorted = [...shuffled].sort(compareLedgerOrder)
  const opening = 10000
  const balances = runningBalances(opening, sorted)
  assert.equal(balances.at(-1), workingBalance(opening, rows))
})

test('display invariant: the register\'s newest-first top row (sort DESC) is '
  + 'the same row as ledger order\'s last row (sort ASC), and its running '
  + 'balance is workingBalance', () => {
  const rows = [
    { ...K('2026-01-01', '2026-01-01T08:00:00Z', 'a1'), amount_cents: 1000, cleared: 'reconciled' as const },
    { ...K('2026-01-01', '2026-01-01T09:00:00Z', 'a2'), amount_cents: -500, cleared: 'cleared' as const },
    { ...K('2026-01-02', '2026-01-02T08:00:00Z', 'b1'), amount_cents: 2000, cleared: 'uncleared' as const },
    { ...K('2026-01-03', '2026-01-03T07:00:00Z', 'c1'), amount_cents: -1500, cleared: 'cleared' as const },
    { ...K('2026-01-03', '2026-01-03T07:30:00Z', 'c2'), amount_cents: 400, cleared: 'uncleared' as const },
  ]
  const displayTop = [...rows].sort((a, b) => compareLedgerOrder(b, a))[0]
  const ledgerLast = [...rows].sort(compareLedgerOrder).at(-1)
  assert.equal(displayTop, ledgerLast)

  const opening = 10000
  const ledgerOrder = [...rows].sort(compareLedgerOrder)
  const balances = runningBalances(opening, ledgerOrder)
  assert.equal(balances.at(-1), workingBalance(opening, rows))
})
