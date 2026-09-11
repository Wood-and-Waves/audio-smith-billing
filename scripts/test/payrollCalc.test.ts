// One paycheck, computed. The arithmetic itself is simple; the wage bases are
// not, and they are where a payroll calculator actually goes wrong — Social
// Security stops at a ceiling, FUTA stops at $7,000, Illinois unemployment
// stops at its own base, and all three depend on what was already paid THIS
// YEAR, not on this paycheck alone. Every crossover has a test below.
//
// Figures are checked against a $70,000 salary paid monthly, which is the
// arrangement Dan is planning.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePaycheck, projectYear } from '../../lib/payrollCalc.ts'
import { SEED_TAX_YEARS, findRules, type TaxYearRules } from '../../lib/payrollRules.ts'

const RULES = findRules(SEED_TAX_YEARS, 2026) as TaxYearRules

/** $70,000 / 12, to the cent. */
const MONTHLY_GROSS = 583_333

const base = (over: Partial<Parameters<typeof computePaycheck>[0]> = {}) => ({
  grossCents: MONTHLY_GROSS,
  ytdWagesCents: 0,
  fedWithholdingCents: 50_000,
  ilAllowances: 0,
  periodsPerYear: 12,
  rules: RULES,
  ...over,
})

// --- the ordinary paycheck ---

test('a monthly paycheck on a $70k salary comes out to the cent', () => {
  const p = computePaycheck(base())
  assert.equal(p.ssEmployeeCents, 36_167)
  assert.equal(p.ssEmployerCents, 36_167)
  assert.equal(p.medicareEmployeeCents, 8_458)
  assert.equal(p.medicareEmployerCents, 8_458)
  assert.equal(p.addlMedicareCents, 0)
  assert.equal(p.ilWithholdingCents, 28_875)
  assert.equal(p.futaCents, 3_500)
  assert.equal(p.ilSutaCents, 23_042)
})

test('net pay is gross less everything withheld from the employee', () => {
  const p = computePaycheck(base())
  assert.equal(p.netCents, 459_833)
  assert.equal(
    p.netCents,
    p.grossCents - p.fedWithholdingCents - p.ssEmployeeCents
      - p.medicareEmployeeCents - p.addlMedicareCents - p.ilWithholdingCents,
  )
})

// What the paycheck actually COSTS the company: gross plus the employer's own
// taxes. This is the number that decides whether a salary is affordable.
test('employer cost is gross plus the employer taxes, not just gross', () => {
  const p = computePaycheck(base())
  assert.equal(p.employerCostCents, 654_500)
  assert.equal(
    p.employerCostCents,
    p.grossCents + p.ssEmployerCents + p.medicareEmployerCents + p.futaCents + p.ilSutaCents,
  )
})

// The 941 deposit is BOTH halves of FICA plus the federal income tax withheld
// — and nothing else. FUTA is a 940, Illinois goes to Illinois.
test('the federal deposit is both halves of FICA plus federal withholding, and nothing else', () => {
  const p = computePaycheck(base())
  assert.equal(p.federalDepositCents, 139_250)
  assert.ok(p.federalDepositCents < p.employerCostCents)
})

test('the Illinois withholding deposit is separate from the federal one', () => {
  const p = computePaycheck(base())
  assert.equal(p.ilDepositCents, 28_875)
})

// --- Illinois allowances ---

test('IL-W-4 allowances reduce Illinois withholding, pro-rated over the year', () => {
  const p = computePaycheck(base({ ilAllowances: 6 }))
  // 6 allowances x $2,850 = $17,100 a year, $1,425 a month off the taxable base.
  // (583,333 - 142,500) x 4.95% = 21,821.2... -> 21,821
  assert.equal(p.ilWithholdingCents, 21_821)
})

test('allowances can never push Illinois withholding below zero', () => {
  const p = computePaycheck(base({ grossCents: 10_000, ilAllowances: 20 }))
  assert.equal(p.ilWithholdingCents, 0)
})

// --- the wage bases, which is where this gets interesting ---

test('Social Security stops at the wage base, mid-paycheck', () => {
  // $184,000 already paid against a $184,500 base: only $500 of this cheque
  // is still subject to Social Security.
  const p = computePaycheck(base({ ytdWagesCents: 18_400_000 }))
  assert.equal(p.ssEmployeeCents, 3_100)
  assert.equal(p.ssEmployerCents, 3_100)
})

test('once the Social Security base is passed, it charges nothing', () => {
  const p = computePaycheck(base({ ytdWagesCents: 20_000_000 }))
  assert.equal(p.ssEmployeeCents, 0)
  assert.equal(p.ssEmployerCents, 0)
})

test('Medicare has no ceiling and keeps charging', () => {
  const p = computePaycheck(base({ ytdWagesCents: 20_000_000 }))
  assert.equal(p.medicareEmployeeCents, 8_458)
  assert.equal(p.medicareEmployerCents, 8_458)
})

// FUTA is $7,000 of wages a year — about six weeks of this salary. After
// that it is zero for the rest of the year, which is why the annual figure
// is $42 and not $420.
test('FUTA applies only to the first $7,000 of the year', () => {
  const partial = computePaycheck(base({ ytdWagesCents: 650_000 }))
  assert.equal(partial.futaCents, 300) // only $500 of room left, at 0.6%
  const exhausted = computePaycheck(base({ ytdWagesCents: 700_000 }))
  assert.equal(exhausted.futaCents, 0)
})

test('Illinois unemployment stops at its own base, which is not FUTA’s', () => {
  const exhausted = computePaycheck(base({ ytdWagesCents: 1_391_600 }))
  assert.equal(exhausted.ilSutaCents, 0)
  // ...and it is still charging at a point where FUTA has long stopped.
  const between = computePaycheck(base({ ytdWagesCents: 700_000 }))
  assert.equal(between.futaCents, 0)
  assert.ok(between.ilSutaCents > 0)
})

// Additional Medicare is employee-only — there is no employer match. Getting
// that wrong overstates the company's cost and the 941 deposit.
test('Additional Medicare is withheld above the threshold, with no employer match', () => {
  const p = computePaycheck(base({ ytdWagesCents: 19_900_000 }))
  assert.equal(p.addlMedicareCents, 4_350)
  assert.equal(p.medicareEmployerCents, 8_458) // unchanged: no match
})

test('Additional Medicare does not apply below the threshold', () => {
  const p = computePaycheck(base({ ytdWagesCents: 10_000_000 }))
  assert.equal(p.addlMedicareCents, 0)
})

// --- degenerate inputs ---

test('a zero paycheck is a paycheck, not a crash', () => {
  const p = computePaycheck(base({ grossCents: 0, fedWithholdingCents: 0 }))
  assert.equal(p.netCents, 0)
  assert.equal(p.employerCostCents, 0)
  assert.equal(p.federalDepositCents, 0)
})

test('every figure is an integer number of cents', () => {
  const p = computePaycheck(base({ grossCents: 333_333, ytdWagesCents: 111_111 }))
  for (const [key, value] of Object.entries(p)) {
    if (typeof value === 'number') {
      assert.ok(Number.isInteger(value), `${key} = ${value}`)
    }
  }
})

// --- the year projection, which is what the planning card shows ---

test('twelve monthly paychecks add up to the salary, to the cent', () => {
  const year = projectYear({
    annualGrossCents: 7_000_000,
    periodsPerYear: 12,
    fedWithholdingPerPeriodCents: 50_000,
    ilAllowances: 0,
    rules: RULES,
  })
  assert.equal(year.paychecks.length, 12)
  const gross = year.paychecks.reduce((sum, p) => sum + p.grossCents, 0)
  assert.equal(gross, 7_000_000, 'the rounding remainder has to land somewhere')
  assert.equal(year.totals.grossCents, 7_000_000)
})

test('the projection carries the wage bases across the year, not per paycheck', () => {
  const year = projectYear({
    annualGrossCents: 7_000_000,
    periodsPerYear: 12,
    fedWithholdingPerPeriodCents: 50_000,
    ilAllowances: 0,
    rules: RULES,
  })
  // $7,000 of FUTA wages at 0.6% is $42 for the whole year, however it is split.
  assert.equal(year.totals.futaCents, 4_200)
  // ...and it stopped early, rather than charging every month.
  assert.equal(year.paychecks[11].futaCents, 0)
})

test('the projection totals the payroll tax the business actually owes', () => {
  const year = projectYear({
    annualGrossCents: 7_000_000,
    periodsPerYear: 12,
    fedWithholdingPerPeriodCents: 0,
    ilAllowances: 0,
    rules: RULES,
  })
  // Both halves of FICA on $70,000: 15.3%, near enough $10,710.
  const fica = year.totals.ssEmployeeCents + year.totals.ssEmployerCents
    + year.totals.medicareEmployeeCents + year.totals.medicareEmployerCents
  assert.ok(Math.abs(fica - 1_071_000) < 100, `FICA came to ${fica}`)
})

test('a projection with no periods is empty, not a division by zero', () => {
  const year = projectYear({
    annualGrossCents: 7_000_000,
    periodsPerYear: 0,
    fedWithholdingPerPeriodCents: 0,
    ilAllowances: 0,
    rules: RULES,
  })
  assert.deepEqual(year.paychecks, [])
  assert.equal(year.totals.grossCents, 0)
})

// --- the recorded figures, however they were arrived at ---

import { validateRunFigures, type RunFigures } from '../../lib/payrollCalc.ts'

const figures = (over: Partial<RunFigures> = {}): RunFigures => ({
  grossCents: 583_333,
  fedWithholdingCents: 50_000,
  ssEmployeeCents: 36_167,
  medicareEmployeeCents: 8_458,
  addlMedicareCents: 0,
  ilWithholdingCents: 28_875,
  ssEmployerCents: 36_167,
  medicareEmployerCents: 8_458,
  futaCents: 3_500,
  ilSutaCents: 23_042,
  netCents: 459_833,
  ...over,
})

test('figures that hold together are accepted', () => {
  assert.equal(validateRunFigures(figures()), null)
})

test('what computePaycheck produces always validates', () => {
  const p = computePaycheck(base())
  assert.equal(validateRunFigures(p), null)
})

test('net pay that does not match gross less withholding is refused', () => {
  const message = validateRunFigures(figures({ netCents: 459_834 }))
  assert.match(String(message), /Net pay/)
})

test('withholding more than the paycheck is worth is refused', () => {
  const message = validateRunFigures(figures({ fedWithholdingCents: 900_000, netCents: 0 }))
  assert.match(String(message), /More is withheld/)
})

test('a negative figure is refused, and named', () => {
  const message = validateRunFigures(figures({ ilSutaCents: -1 }))
  assert.match(String(message), /Illinois unemployment/)
})

test('a fractional cent is refused rather than silently rounded', () => {
  const message = validateRunFigures(figures({ futaCents: 3_500.5 }))
  assert.match(String(message), /whole number/)
})
