// One paycheck, in integer cents.
//
// NOTE THE NAME. lib/payroll.ts is already taken — it is the CrewTracker port
// that computes crew HOURS for client invoices and has nothing to do with the
// ledger. This module is the money side, and the two must not be confused.
//
// What this computes and what it refuses to:
//
//   Social Security, Medicare, Additional Medicare, FUTA, Illinois
//   unemployment and Illinois income tax are all pure arithmetic against a
//   rate and a wage base. They are computed here, exactly.
//
//   FEDERAL INCOME TAX WITHHELD IS AN INPUT, not a computation. Getting it
//   right means the IRS Pub 15-T percentage-method tables plus a reading of
//   the W-4, both of which change annually and neither of which fails loudly
//   when wrong. It belongs to whoever runs payroll. This module takes the
//   figure, and the screen shows what it adds up to across the year so a
//   number that is too light is at least visible.
//
// The wage bases are the interesting part. Social Security stops at a ceiling,
// FUTA stops at $7,000, Illinois unemployment stops at its own base — and all
// three depend on wages ALREADY PAID this year, so every call needs the
// year-to-date figure and none of them can be computed from one cheque alone.
//
// No '@/' imports and no JSX — exercised by node --test.

import { roundCents, taxOn } from './money.ts'
import type { TaxYearRules } from './payrollRules.ts'

export type PaycheckInput = {
  grossCents: number
  /** Wages already paid this calendar year, BEFORE this paycheck. */
  ytdWagesCents: number
  /** Federal income tax to withhold. An input — see the note above. */
  fedWithholdingCents: number
  /** Count of IL-W-4 basic allowances claimed. */
  ilAllowances: number
  /** 12 for monthly. Used only to pro-rate the Illinois allowance. */
  periodsPerYear: number
  rules: TaxYearRules
}

export type Paycheck = {
  grossCents: number
  fedWithholdingCents: number
  ssEmployeeCents: number
  ssEmployerCents: number
  medicareEmployeeCents: number
  medicareEmployerCents: number
  /** Employee only — there is no employer match on Additional Medicare. */
  addlMedicareCents: number
  ilWithholdingCents: number
  /** Employer only. */
  futaCents: number
  /** Employer only. */
  ilSutaCents: number
  netCents: number
  /** Gross plus the employer's own taxes: what the paycheck costs the company. */
  employerCostCents: number
  /** What goes to the IRS on a 941 deposit: both halves of FICA + federal withholding. */
  federalDepositCents: number
  /** What goes to Illinois on an IL-941 deposit. */
  ilDepositCents: number
}

/**
 * Wages from this paycheck that still fall under a wage base, given what has
 * already been paid. Never negative, never more than the paycheck itself.
 */
function taxableUpTo(grossCents: number, ytdWagesCents: number, baseCents: number): number {
  return Math.max(0, Math.min(grossCents, baseCents - ytdWagesCents))
}

/** Wages from this paycheck that fall ABOVE a threshold — the mirror of the above. */
function taxableAbove(grossCents: number, ytdWagesCents: number, thresholdCents: number): number {
  return Math.max(0, Math.min(grossCents, ytdWagesCents + grossCents - thresholdCents))
}

export function computePaycheck(input: PaycheckInput): Paycheck {
  const { grossCents, ytdWagesCents, fedWithholdingCents, ilAllowances, periodsPerYear, rules } = input

  const ssWages = taxableUpTo(grossCents, ytdWagesCents, rules.ssWageBaseCents)
  const ssEmployeeCents = taxOn(ssWages, rules.ssRateBp)
  const ssEmployerCents = ssEmployeeCents

  const medicareEmployeeCents = taxOn(grossCents, rules.medicareRateBp)
  const medicareEmployerCents = medicareEmployeeCents

  const addlWages = taxableAbove(grossCents, ytdWagesCents, rules.addlMedicareThresholdCents)
  const addlMedicareCents = taxOn(addlWages, rules.addlMedicareRateBp)

  // An IL-W-4 allowance is an ANNUAL amount, so it has to be spread across the
  // year's paychecks. periodsPerYear of 0 would divide by zero; treat it as no
  // allowance rather than throwing, since the caller may be mid-edit.
  const allowancePerPeriod = periodsPerYear > 0
    ? roundCents((ilAllowances * rules.ilAllowanceCents) / periodsPerYear)
    : 0
  const ilTaxable = Math.max(0, grossCents - allowancePerPeriod)
  const ilWithholdingCents = taxOn(ilTaxable, rules.ilIncomeRateBp)

  const futaCents = taxOn(taxableUpTo(grossCents, ytdWagesCents, rules.futaWageBaseCents), rules.futaRateBp)
  const ilSutaCents = taxOn(taxableUpTo(grossCents, ytdWagesCents, rules.ilSutaWageBaseCents), rules.ilSutaRateBp)

  const netCents = grossCents - fedWithholdingCents - ssEmployeeCents
    - medicareEmployeeCents - addlMedicareCents - ilWithholdingCents

  return {
    grossCents,
    fedWithholdingCents,
    ssEmployeeCents,
    ssEmployerCents,
    medicareEmployeeCents,
    medicareEmployerCents,
    addlMedicareCents,
    ilWithholdingCents,
    futaCents,
    ilSutaCents,
    netCents,
    employerCostCents: grossCents + ssEmployerCents + medicareEmployerCents + futaCents + ilSutaCents,
    federalDepositCents: fedWithholdingCents + ssEmployeeCents + ssEmployerCents
      + medicareEmployeeCents + medicareEmployerCents + addlMedicareCents,
    ilDepositCents: ilWithholdingCents,
  }
}

export type YearProjectionInput = {
  annualGrossCents: number
  periodsPerYear: number
  fedWithholdingPerPeriodCents: number
  ilAllowances: number
  rules: TaxYearRules
}

export type PaycheckTotals = {
  grossCents: number
  fedWithholdingCents: number
  ssEmployeeCents: number
  ssEmployerCents: number
  medicareEmployeeCents: number
  medicareEmployerCents: number
  addlMedicareCents: number
  ilWithholdingCents: number
  futaCents: number
  ilSutaCents: number
  netCents: number
  employerCostCents: number
  federalDepositCents: number
  ilDepositCents: number
}

export type YearProjection = {
  paychecks: Paycheck[]
  totals: PaycheckTotals
}

const ZERO_TOTALS = (): PaycheckTotals => ({
  grossCents: 0, fedWithholdingCents: 0, ssEmployeeCents: 0, ssEmployerCents: 0,
  medicareEmployeeCents: 0, medicareEmployerCents: 0, addlMedicareCents: 0,
  ilWithholdingCents: 0, futaCents: 0, ilSutaCents: 0, netCents: 0,
  employerCostCents: 0, federalDepositCents: 0, ilDepositCents: 0,
})

/**
 * A whole year of paychecks at a target salary — the planning card.
 *
 * Runs the paychecks in sequence, carrying year-to-date wages forward, because
 * that is the only way the wage bases come out right: FUTA on a $70,000 salary
 * is $42 for the year, not $42 a month, and it stops in February.
 *
 * The division remainder lands on the LAST paycheck so the twelve add up to
 * the salary exactly.
 */
export function projectYear(input: YearProjectionInput): YearProjection {
  const { annualGrossCents, periodsPerYear, fedWithholdingPerPeriodCents, ilAllowances, rules } = input
  if (periodsPerYear <= 0) return { paychecks: [], totals: ZERO_TOTALS() }

  const perPeriod = Math.floor(annualGrossCents / periodsPerYear)
  const remainder = annualGrossCents - perPeriod * periodsPerYear

  const paychecks: Paycheck[] = []
  let ytd = 0
  for (let i = 0; i < periodsPerYear; i += 1) {
    const grossCents = i === periodsPerYear - 1 ? perPeriod + remainder : perPeriod
    const paycheck = computePaycheck({
      grossCents,
      ytdWagesCents: ytd,
      fedWithholdingCents: fedWithholdingPerPeriodCents,
      ilAllowances,
      periodsPerYear,
      rules,
    })
    paychecks.push(paycheck)
    ytd += grossCents
  }

  const totals = ZERO_TOTALS()
  for (const paycheck of paychecks) {
    for (const key of Object.keys(totals) as (keyof PaycheckTotals)[]) {
      totals[key] += paycheck[key]
    }
  }

  return { paychecks, totals }
}

/** The figures a recorded paycheck carries, however they were arrived at. */
export type RunFigures = {
  grossCents: number
  fedWithholdingCents: number
  ssEmployeeCents: number
  medicareEmployeeCents: number
  addlMedicareCents: number
  ilWithholdingCents: number
  ssEmployerCents: number
  medicareEmployerCents: number
  futaCents: number
  ilSutaCents: number
  netCents: number
}

/**
 * Refuse a paycheck that cannot be true, with a message a human can act on.
 * Returns null when the figures hold.
 *
 * The database carries the same net-vs-gross check, deliberately — this one
 * exists so a typo comes back as a sentence instead of a Postgres constraint
 * name, and so it can be tested without a database. The two must move
 * together: if this is relaxed and 0053's check is not, a row this accepts
 * still fails on insert.
 */
export function validateRunFigures(f: RunFigures): string | null {
  const named: [string, number][] = [
    ['Gross pay', f.grossCents],
    ['Federal withholding', f.fedWithholdingCents],
    ['Social Security withheld', f.ssEmployeeCents],
    ['Medicare withheld', f.medicareEmployeeCents],
    ['Additional Medicare', f.addlMedicareCents],
    ['Illinois withholding', f.ilWithholdingCents],
    ['Employer Social Security', f.ssEmployerCents],
    ['Employer Medicare', f.medicareEmployerCents],
    ['FUTA', f.futaCents],
    ['Illinois unemployment', f.ilSutaCents],
    ['Net pay', f.netCents],
  ]
  for (const [label, value] of named) {
    if (!Number.isInteger(value)) return `${label} must be a whole number of cents.`
    if (value < 0) return `${label} cannot be negative.`
  }

  const withheld = f.fedWithholdingCents + f.ssEmployeeCents + f.medicareEmployeeCents
    + f.addlMedicareCents + f.ilWithholdingCents
  if (withheld > f.grossCents) return 'More is withheld than the paycheck is worth.'
  if (f.netCents !== f.grossCents - withheld) {
    return 'Net pay does not equal gross less what was withheld.'
  }
  return null
}
