'use server'

// Payroll's writes. Four verbs: record a paycheck, record a remittance, undo
// either, and correct a tax year's figures.
//
// Every amount arrives as integer cents — the client has already run
// parseUSDMath — so nothing here re-parses a number. The interesting judgment
// (does this paycheck hold together?) lives in lib/payrollCalc.ts's
// validateRunFigures, where it can be tested without a database.
//
// Note what is NOT here: nothing creates a ledger_transactions row. The bank
// rows for a paycheck arrive in the Chase OFX import, and writing them here
// would duplicate them. Linking a run to the rows it turned out to be is a
// separate step.

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isPlainDate } from '@/lib/dates'
import { validateRunFigures, type RunFigures } from '@/lib/payrollCalc'

type Result = { ok: true } | { error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const OBLIGATIONS = [
  '941-deposit', '941-return', '940', 'il-941-deposit', 'il-941-return', 'il-ui',
] as const
type ObligationCode = (typeof OBLIGATIONS)[number]

export type RecordRunInput = RunFigures & {
  payDate: string
  periodStart: string
  periodEnd: string
  source: 'computed' | 'entered'
  rulesYear: number | null
  memo: string | null
}

export async function recordPayrollRun(input: RecordRunInput): Promise<Result> {
  if (!isPlainDate(input.payDate)) return { error: 'Pick a pay date.' }
  if (!isPlainDate(input.periodStart) || !isPlainDate(input.periodEnd)) {
    return { error: 'Pick the pay period this cheque covers.' }
  }
  if (input.periodStart > input.periodEnd) {
    return { error: 'The pay period ends before it starts.' }
  }
  if (input.source !== 'computed' && input.source !== 'entered') {
    return { error: 'A paycheck is either computed or entered.' }
  }
  if (input.rulesYear !== null && !Number.isInteger(input.rulesYear)) {
    return { error: 'That is not a tax year.' }
  }

  const problem = validateRunFigures(input)
  if (problem !== null) return { error: problem }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { error } = await supabase.from('payroll_runs').insert({
    owner_id: user.id,
    pay_date: input.payDate,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    gross_cents: input.grossCents,
    fed_withholding_cents: input.fedWithholdingCents,
    ss_employee_cents: input.ssEmployeeCents,
    medicare_employee_cents: input.medicareEmployeeCents,
    addl_medicare_cents: input.addlMedicareCents,
    il_withholding_cents: input.ilWithholdingCents,
    ss_employer_cents: input.ssEmployerCents,
    medicare_employer_cents: input.medicareEmployerCents,
    futa_cents: input.futaCents,
    il_suta_cents: input.ilSutaCents,
    net_cents: input.netCents,
    source: input.source,
    rules_year: input.rulesYear,
    memo: input.memo,
  })
  // One paycheck per pay date — a second row would double every obligation it
  // feeds, so say so plainly rather than showing a constraint name.
  if (error) {
    return error.code === '23505'
      ? { error: 'A paycheck is already recorded for that date.' }
      : { error: error.message }
  }

  revalidatePath('/money/payroll')
  return { ok: true }
}

export async function deletePayrollRun(id: string): Promise<Result> {
  if (!UUID.test(id)) return { error: 'That is not a paycheck.' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { error } = await supabase
    .from('payroll_runs').delete().eq('id', id).eq('owner_id', user.id)
  if (error) return { error: error.message }

  revalidatePath('/money/payroll')
  return { ok: true }
}

export type RecordPaymentInput = {
  obligation: ObligationCode
  periodStart: string
  periodEnd: string
  amountCents: number
  paidOn: string
  confirmation: string | null
}

export async function recordTaxPayment(input: RecordPaymentInput): Promise<Result> {
  if (!OBLIGATIONS.includes(input.obligation)) return { error: 'That is not an obligation.' }
  if (!isPlainDate(input.periodStart) || !isPlainDate(input.periodEnd)) {
    return { error: 'That payment has no period.' }
  }
  if (input.periodStart > input.periodEnd) return { error: 'That period ends before it starts.' }
  if (!isPlainDate(input.paidOn)) return { error: 'Pick the date you paid it.' }
  // Zero is meaningful and allowed: it is how a return gets marked as filed.
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
    return { error: 'A payment cannot be negative.' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { error } = await supabase.from('payroll_tax_payments').insert({
    owner_id: user.id,
    obligation: input.obligation,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    amount_cents: input.amountCents,
    paid_on: input.paidOn,
    confirmation: input.confirmation,
  })
  if (error) return { error: error.message }

  revalidatePath('/money/payroll')
  return { ok: true }
}

export async function deleteTaxPayment(id: string): Promise<Result> {
  if (!UUID.test(id)) return { error: 'That is not a payment.' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { error } = await supabase
    .from('payroll_tax_payments').delete().eq('id', id).eq('owner_id', user.id)
  if (error) return { error: error.message }

  revalidatePath('/money/payroll')
  return { ok: true }
}

export type SaveTaxYearInput = {
  year: number
  ssRateBp: number
  ssWageBaseCents: number
  medicareRateBp: number
  addlMedicareRateBp: number
  addlMedicareThresholdCents: number
  futaRateBp: number
  futaWageBaseCents: number
  ilIncomeRateBp: number
  ilAllowanceCents: number
  ilSutaRateBp: number
  ilSutaWageBaseCents: number
  note: string
}

/**
 * Add or correct a year's tax figures. This is the escape hatch that keeps the
 * tool usable in January without a code change: when SSA publishes the next
 * wage base, Dan types it in here.
 */
export async function saveTaxYear(input: SaveTaxYearInput): Promise<Result> {
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) {
    return { error: 'That is not a tax year.' }
  }
  const figures: [string, number][] = [
    ['Social Security rate', input.ssRateBp],
    ['Social Security wage base', input.ssWageBaseCents],
    ['Medicare rate', input.medicareRateBp],
    ['Additional Medicare rate', input.addlMedicareRateBp],
    ['Additional Medicare threshold', input.addlMedicareThresholdCents],
    ['FUTA rate', input.futaRateBp],
    ['FUTA wage base', input.futaWageBaseCents],
    ['Illinois income tax rate', input.ilIncomeRateBp],
    ['Illinois allowance', input.ilAllowanceCents],
    ['Illinois unemployment rate', input.ilSutaRateBp],
    ['Illinois unemployment wage base', input.ilSutaWageBaseCents],
  ]
  for (const [label, value] of figures) {
    if (!Number.isInteger(value) || value < 0) return { error: `${label} is not a number.` }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { error } = await supabase.from('payroll_tax_years').upsert({
    owner_id: user.id,
    year: input.year,
    ss_rate_bp: input.ssRateBp,
    ss_wage_base_cents: input.ssWageBaseCents,
    medicare_rate_bp: input.medicareRateBp,
    addl_medicare_rate_bp: input.addlMedicareRateBp,
    addl_medicare_threshold_cents: input.addlMedicareThresholdCents,
    futa_rate_bp: input.futaRateBp,
    futa_wage_base_cents: input.futaWageBaseCents,
    il_income_rate_bp: input.ilIncomeRateBp,
    il_allowance_cents: input.ilAllowanceCents,
    il_suta_rate_bp: input.ilSutaRateBp,
    il_suta_wage_base_cents: input.ilSutaWageBaseCents,
    note: input.note,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'owner_id,year' })
  if (error) return { error: error.message }

  revalidatePath('/money/payroll')
  return { ok: true }
}
