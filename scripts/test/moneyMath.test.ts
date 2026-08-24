// Run: npm test -- scripts/test/moneyMath.test.ts (or npm test for the whole suite)
//
// parseUSDMath is the ONE entry point every money box in the register now
// types through (add amount, edit amount, AssignedCell, MoveMoneyDialog,
// TargetEditor). A lone number must be byte-identical to parseUSD — that's
// not a sampled coincidence, it's load-bearing: the parity table below
// exercises parseUSD's own documented edge cases (empty string, $, commas,
// negatives, the accounting-parens convention, garbage) and asserts equality
// against parseUSD directly, not against a hand-copied expected number.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUSDMath } from '../../lib/moneyMath.ts'
import { parseUSD } from '../../lib/money.ts'

test('Dan\'s own case: 24.36+45.72 -> 7008', () => {
  assert.equal(parseUSDMath('24.36+45.72'), 7008)
})

test('subtraction produces a negative result', () => {
  assert.equal(parseUSDMath('5-10'), -500)
})

test('multiplication: 3*12.99 -> 3897', () => {
  assert.equal(parseUSDMath('3*12.99'), 3897)
})

test('division rounds once at the end: 100/3 -> 3333', () => {
  assert.equal(parseUSDMath('100/3'), 3333)
})

test('standard precedence: * before +', () => {
  assert.equal(parseUSDMath('2+3*4'), 1400) // not (2+3)*4 = 2000
})

test('left-associative: 10-3-2 -> 500, not 10-(3-2) -> 900', () => {
  assert.equal(parseUSDMath('10-3-2'), 500)
})

test('parentheses override precedence', () => {
  assert.equal(parseUSDMath('(24.36+45.72)*2'), 14016)
})

test('nested parentheses', () => {
  assert.equal(parseUSDMath('((1+2))*3'), 900)
})

test('parentheses inside an expression are grouping, not the accounting-negative convention', () => {
  // A LONE "(5.75)" is parseUSD's negative convention (-575, see the parity
  // table below). But once an operator is present, parens can only mean
  // "evaluate this sub-expression first" the way every calculator treats
  // them -- so (5.75)+1 is $5.75 + $1 = $6.75, not -$5.75 + $1.
  assert.equal(parseUSDMath('(5.75)+1'), 675)
})

test('$ and commas are tolerated inside expression operands', () => {
  assert.equal(parseUSDMath('$1,234.56+1'), 123556)
})

test('whitespace around numbers and operators', () => {
  assert.equal(parseUSDMath('  24.36 + 45.72  '), 7008)
})

test('division by zero -> null', () => {
  assert.equal(parseUSDMath('5/0'), null)
  assert.equal(parseUSDMath('5/(3-3)'), null)
})

test('malformed input -> null, never throws', () => {
  assert.equal(parseUSDMath('abc'), null)
  assert.equal(parseUSDMath('5+'), null)
  assert.equal(parseUSDMath('+'), null)
  // NOT malformed: "5 5" has no operator, so it's not an expression at all
  // -- it delegates whole to parseUSD, which strips ALL whitespace (its own
  // /[$,\s]/g, not just leading/trailing) and reads "55" -> 5500. Verified
  // directly against parseUSD, not assumed; see the parity test below too.
  assert.equal(parseUSDMath('5 5'), parseUSD('5 5'))
  // Two numbers with no operator between them IS malformed once an operator
  // elsewhere makes this a real expression -- the parser sees a complete
  // primary (5), then unconsumed tokens (5+1) left over, and refuses.
  assert.equal(parseUSDMath('5 5+1'), null)
  assert.equal(parseUSDMath('1.2.3+1'), null)
  assert.equal(parseUSDMath('5)+3'), null)
  assert.equal(parseUSDMath('(5+3'), null)
  assert.equal(parseUSDMath('()'), null)
  assert.equal(parseUSDMath('()+5'), null)
  assert.doesNotThrow(() => parseUSDMath('*/+-()()('))
})

test('a plain number typed through parseUSDMath is identical to parseUSD (numbers)', () => {
  assert.equal(parseUSDMath(24.36), parseUSD(24.36))
  assert.equal(parseUSDMath(0), parseUSD(0))
  assert.equal(parseUSDMath(-19.99), parseUSD(-19.99))
  assert.equal(parseUSDMath(NaN), parseUSD(NaN))
  assert.equal(parseUSDMath(Infinity), parseUSD(Infinity))
})

test('null and undefined -> null, matching parseUSD', () => {
  assert.equal(parseUSDMath(null), parseUSD(null))
  assert.equal(parseUSDMath(undefined), parseUSD(undefined))
})

test('lone-number parity: parseUSDMath matches parseUSD over a value table', () => {
  const values: Array<string | number | null | undefined> = [
    '24.36',
    '0.29',
    '1.005',
    '$1,234.56',
    '  $780  ',
    '.5',
    '5.',
    '(5.75)', // parseUSD's accounting-negative convention
    '-5.75',
    '(-5.75)', // parseUSD's own double-negative quirk (cancels to positive)
    '',
    '   ',
    null,
    undefined,
    'abc',
    '1.2.3',
    '.',
    '-',
    '(',
    '()',
    0,
    19.99,
    -19.99,
    NaN,
    Infinity,
    -Infinity,
  ]
  for (const v of values) {
    assert.equal(
      parseUSDMath(v),
      parseUSD(v),
      `parseUSDMath(${JSON.stringify(v)}) should equal parseUSD(${JSON.stringify(v)})`,
    )
  }
})

test('chained multiplication after division rounds ONCE at the end — the per-node-rounding bug ships green without this', () => {
  // 100/3 = 33.333…; ×3 = 100 exactly under end-rounding. A per-node
  // implementation rounds 33.333… to 3333 cents first and returns 9999.
  assert.equal(parseUSDMath('100/3*3'), 10000)
  assert.equal(parseUSDMath('10/3*3'), 1000)
})

test('scientific notation is rejected — a parseFloat-based tokenizer would silently accept 1e3 as $1000', () => {
  assert.equal(parseUSDMath('1e3'), null)
  assert.equal(parseUSDMath('2e2+1'), null)
})

test('a pasted blob of nested parens or signs returns null instead of blowing the stack', () => {
  assert.equal(parseUSDMath('('.repeat(5000) + '5' + ')'.repeat(5000)), null)
  assert.equal(parseUSDMath('-'.repeat(5000) + '5'), null)
})
