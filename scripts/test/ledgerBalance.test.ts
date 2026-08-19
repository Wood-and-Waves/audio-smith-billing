import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workingBalance, clearedBalance } from '../../lib/ledgerBalance.ts'

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
