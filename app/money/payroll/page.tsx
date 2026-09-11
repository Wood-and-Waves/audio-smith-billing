import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'
import MoneyNav from '@/components/MoneyNav'
import PayrollPlanner from '@/components/PayrollPlanner'
import PayrollRuns, { type RunRow } from '@/components/PayrollRuns'
import PayrollDue from '@/components/PayrollDue'
import PayrollRules from '@/components/PayrollRules'
import { todayInChicago } from '@/lib/dates'
import { type TaxYearRules } from '@/lib/payrollRules'
import { buildObligations, type ObligationRun, type ObligationPayment } from '@/lib/payrollObligations'

export const dynamic = 'force-dynamic'

function LoadError({ message }: { message: string }) {
  return (
    <AppShell current="money" wide>
      <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
        Couldn&rsquo;t load payroll: {message}
      </p>
    </AppShell>
  )
}

export default async function MoneyPayrollPage() {
  const supabase = await createClient()
  const today = todayInChicago()

  // No paging loop here, unlike every other money page: these three tables
  // grow by twelve paychecks and a couple of dozen payments a YEAR, so
  // PostgREST's silent 1000-row cap is decades away. Every other read in
  // /money pages because it sums rows that already number in the thousands.
  const [yearsRes, runsRes, paymentsRes] = await Promise.all([
    supabase.from('payroll_tax_years').select('*').order('year', { ascending: false }),
    supabase.from('payroll_runs').select('*').order('pay_date', { ascending: false }),
    supabase.from('payroll_tax_payments').select('*').order('paid_on', { ascending: false }),
  ])

  // Each error is checked before its rows are read. A failed query coerced to
  // [] would say "no payroll yet" — which is not an absence of payroll, it is
  // an absence of knowledge, and the two must never look the same on screen.
  if (yearsRes.error) return <LoadError message={yearsRes.error.message} />
  if (runsRes.error) return <LoadError message={runsRes.error.message} />
  if (paymentsRes.error) return <LoadError message={paymentsRes.error.message} />

  const taxYears: TaxYearRules[] = (yearsRes.data ?? []).map((r) => ({
    year: r.year,
    ssRateBp: r.ss_rate_bp,
    ssWageBaseCents: r.ss_wage_base_cents,
    medicareRateBp: r.medicare_rate_bp,
    addlMedicareRateBp: r.addl_medicare_rate_bp,
    addlMedicareThresholdCents: r.addl_medicare_threshold_cents,
    futaRateBp: r.futa_rate_bp,
    futaWageBaseCents: r.futa_wage_base_cents,
    ilIncomeRateBp: r.il_income_rate_bp,
    ilAllowanceCents: r.il_allowance_cents,
    ilSutaRateBp: r.il_suta_rate_bp,
    ilSutaWageBaseCents: r.il_suta_wage_base_cents,
    note: r.note ?? '',
  }))

  const runs: RunRow[] = (runsRes.data ?? []).map((r) => ({
    id: r.id,
    payDate: r.pay_date,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    grossCents: r.gross_cents,
    fedWithholdingCents: r.fed_withholding_cents,
    ssEmployeeCents: r.ss_employee_cents,
    medicareEmployeeCents: r.medicare_employee_cents,
    addlMedicareCents: r.addl_medicare_cents,
    ilWithholdingCents: r.il_withholding_cents,
    ssEmployerCents: r.ss_employer_cents,
    medicareEmployerCents: r.medicare_employer_cents,
    futaCents: r.futa_cents,
    ilSutaCents: r.il_suta_cents,
    netCents: r.net_cents,
    source: r.source as 'computed' | 'entered',
    rulesYear: r.rules_year,
    memo: r.memo,
  }))

  // Kind-shaped? No: these are payroll's own rows, not ledger rows, so neither
  // explodeForReports nor explodeForCategories applies. The ledger only enters
  // the picture when a run is linked to the bank row it turned out to be.
  const obligationRuns: ObligationRun[] = runs.map((r) => ({
    payDate: r.payDate,
    federalDepositCents: r.fedWithholdingCents + r.ssEmployeeCents + r.ssEmployerCents
      + r.medicareEmployeeCents + r.medicareEmployerCents + r.addlMedicareCents,
    ilDepositCents: r.ilWithholdingCents,
    futaCents: r.futaCents,
    ilSutaCents: r.ilSutaCents,
  }))

  const payments: ObligationPayment[] = (paymentsRes.data ?? []).map((p) => ({
    code: p.obligation,
    periodStart: p.period_start,
    periodEnd: p.period_end,
    amountCents: p.amount_cents,
  }))

  const obligations = buildObligations({ runs: obligationRuns, payments, today })

  // The year Dan is planning for: the one after the last paycheck on file, or
  // simply next year when there is none. He is starting payroll in 2027.
  const planYear = runs.length > 0 ? Number(runs[0].payDate.slice(0, 4)) : Number(today.slice(0, 4)) + 1

  return (
    <AppShell current="money" wide>
      <MoneyNav current="payroll" />

      <h1 className="display text-3xl font-bold mb-8">Payroll</h1>

      <PayrollDue obligations={obligations} today={today} />
      <PayrollPlanner taxYears={taxYears} planYear={planYear} />
      <PayrollRuns runs={runs} taxYears={taxYears} today={today} />
      <PayrollRules taxYears={taxYears} />
    </AppShell>
  )
}
