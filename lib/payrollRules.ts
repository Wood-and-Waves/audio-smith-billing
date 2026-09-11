// The tax figures a paycheck is computed from, one set per calendar year.
//
// These are DATA, not constants, and they live in the database — because they
// change every January and because the ones that matter most are not knowable
// in advance. The 2027 Social Security wage base is announced by SSA in
// October 2026; the Illinois unemployment rate is specific to Dan's own
// account and arrives in a letter. A tool that hardcoded either would be
// quietly wrong the first time it was used in anger.
//
// So: this module owns the SHAPE and the seed, the database owns the values,
// and the screen prints every figure it used. An error here is a wrong payment
// to the IRS, and the only defence that has ever worked is making the numbers
// visible to the person who can recognise them.
//
// Rates are basis points, matching lib/money.ts's taxOn: 6.2% -> 620.
// No '@/' imports and no JSX — exercised by node --test.

/**
 * One year's payroll tax rules. Every rate is basis points, every threshold
 * integer cents, so nothing here is ever a float.
 */
export type TaxYearRules = {
  year: number

  /** Social Security, charged to employee AND employer at this same rate. */
  ssRateBp: number
  /** Wages above this in a year are not subject to Social Security. */
  ssWageBaseCents: number

  /** Medicare, employee AND employer, uncapped. */
  medicareRateBp: number
  /** Additional Medicare — EMPLOYEE ONLY, no employer match. */
  addlMedicareRateBp: number
  /** Wages above this trigger Additional Medicare withholding. */
  addlMedicareThresholdCents: number

  /** FUTA after the state credit (6.0% gross less up to 5.4%). Employer only. */
  futaRateBp: number
  futaWageBaseCents: number

  /** Illinois income tax — flat. */
  ilIncomeRateBp: number
  /** Annual value of one IL-W-4 basic allowance. */
  ilAllowanceCents: number

  /** Illinois unemployment. Employer only, and SPECIFIC TO THE ACCOUNT. */
  ilSutaRateBp: number
  ilSutaWageBaseCents: number

  /**
   * Where these figures came from and what still needs checking. Printed on
   * screen verbatim — this is the field that makes a bad number findable.
   */
  note: string
}

/**
 * The seed. 2026 only, deliberately: 2027's figures do not exist yet at the
 * time of writing (2026-09-10), and inventing them would be worse than having
 * none. `findRules` returns null for a year with no row, the screen says so,
 * and Dan adds 2027 in October when SSA publishes.
 *
 * The Illinois unemployment rate below is a NEW-EMPLOYER placeholder. Dan's
 * own rate comes from IDES and must replace it before the first real run.
 */
export const SEED_TAX_YEARS: TaxYearRules[] = [
  {
    year: 2026,
    ssRateBp: 620,
    ssWageBaseCents: 18_450_000,
    medicareRateBp: 145,
    addlMedicareRateBp: 90,
    addlMedicareThresholdCents: 20_000_000,
    futaRateBp: 60,
    futaWageBaseCents: 700_000,
    ilIncomeRateBp: 495,
    ilAllowanceCents: 285_000,
    ilSutaRateBp: 395,
    ilSutaWageBaseCents: 1_391_600,
    note:
      'Seeded 2026-09-10 and NOT yet verified. Check with your accountant before '
      + 'the first real run: the Social Security wage base, the Illinois allowance '
      + 'amount, the Illinois unemployment wage base, and above all your own IDES '
      + 'unemployment rate (the 3.95% here is a new-employer placeholder, not yours).',
  },
]

/**
 * Find one year's rules. Returns null when the year is absent — deliberately,
 * and with no fallback to the nearest year.
 *
 * The tempting alternative is to fall back to the most recent year on file.
 * That is exactly how a payroll tool goes wrong in January: every figure looks
 * plausible, the arithmetic is clean, and the wage base is a year stale. An
 * absent year has to be loud, so it is null and the caller must say so.
 */
export function findRules(rows: TaxYearRules[], year: number): TaxYearRules | null {
  return rows.find((r) => r.year === year) ?? null
}

/** The years on file, ascending — for a picker, and for saying what is missing. */
export function yearsOnFile(rows: TaxYearRules[]): number[] {
  return rows.map((r) => r.year).sort((a, b) => a - b)
}
