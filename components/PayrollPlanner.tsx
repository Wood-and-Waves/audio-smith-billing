'use client'

// The calculator: what a salary actually costs, before committing to one.
//
// It writes nothing. Dan asked to "model, record and remit", and this is the
// model — change the salary and watch the payroll tax move. The figure that
// matters most is employer cost, because that is what has to come out of the
// business, and it is meaningfully more than the salary itself.

import { useMemo, useState } from 'react'
import { formatUSD, formatAmount } from '@/lib/money'
import { parseUSDMath } from '@/lib/moneyMath'
import { FIELD_FULL } from '@/components/ui/field'
import { projectYear } from '@/lib/payrollCalc'
import { findRules, type TaxYearRules } from '@/lib/payrollRules'

const CADENCES = [
  { value: 12, label: 'Monthly' },
  { value: 24, label: 'Twice a month' },
  { value: 4, label: 'Quarterly' },
  { value: 1, label: 'Once a year' },
]

export default function PayrollPlanner({
  taxYears, planYear,
}: { taxYears: TaxYearRules[]; planYear: number }) {
  const years = taxYears.map((y) => y.year).sort((a, b) => b - a)
  const [year, setYear] = useState(years.includes(planYear) ? planYear : (years[0] ?? planYear))
  const [salary, setSalary] = useState('70000.00')
  const [periods, setPeriods] = useState(12)
  const [fedWithholding, setFedWithholding] = useState('500.00')
  const [allowances, setAllowances] = useState('0')

  const rules = findRules(taxYears, year)

  const projection = useMemo(() => {
    if (rules === null) return null
    const annualGrossCents = parseUSDMath(salary) ?? 0
    const fedPerPeriod = parseUSDMath(fedWithholding) ?? 0
    const n = Number(allowances)
    return projectYear({
      annualGrossCents,
      periodsPerYear: periods,
      fedWithholdingPerPeriodCents: fedPerPeriod,
      ilAllowances: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0,
      rules,
    })
  }, [rules, salary, periods, fedWithholding, allowances])

  const first = projection?.paychecks[0] ?? null
  const totals = projection?.totals ?? null
  const employerTaxCents = totals === null ? 0
    : totals.ssEmployerCents + totals.medicareEmployerCents + totals.futaCents + totals.ilSutaCents

  return (
    <section className="mb-12">
      <h2 className="eyebrow mb-3">What a salary costs</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Tax year</span>
          <select
            className={FIELD_FULL} value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Annual salary</span>
          <input
            type="text" inputMode="decimal" className={FIELD_FULL} placeholder="0.00"
            value={salary} onChange={(e) => setSalary(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Paid</span>
          <select
            className={FIELD_FULL} value={periods}
            onChange={(e) => setPeriods(Number(e.target.value))}
          >
            {CADENCES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Federal w/h each</span>
          <input
            type="text" inputMode="decimal" className={FIELD_FULL} placeholder="0.00"
            value={fedWithholding} onChange={(e) => setFedWithholding(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">IL allowances</span>
          <input
            type="text" inputMode="numeric" className={FIELD_FULL} placeholder="0"
            value={allowances} onChange={(e) => setAllowances(e.target.value)}
          />
        </label>
      </div>

      {/* No silent fallback to the nearest year on file. A stale wage base is
          how a payroll tool goes quietly wrong in January, so an absent year
          is said out loud instead of guessed at. */}
      {rules === null ? (
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2 text-sm">
          No tax figures on file for {year}. Add them below before computing a {year} paycheck
          &mdash; the rates and wage bases change every year and nothing here will guess them.
        </p>
      ) : first !== null && totals !== null && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-2">
          <div>
            <h3 className="eyebrow mb-2">Each paycheck</h3>
            <Row label="Gross" cents={first.grossCents} />
            <Row label="Federal income tax" cents={-first.fedWithholdingCents} />
            <Row label="Social Security" cents={-first.ssEmployeeCents} />
            <Row label="Medicare" cents={-first.medicareEmployeeCents} />
            {first.addlMedicareCents > 0 && (
              <Row label="Additional Medicare" cents={-first.addlMedicareCents} />
            )}
            <Row label="Illinois income tax" cents={-first.ilWithholdingCents} />
            <Row label="Take-home" cents={first.netCents} strong />
          </div>

          <div>
            <h3 className="eyebrow mb-2">The year</h3>
            <Row label="Salary" cents={totals.grossCents} />
            <Row label="Employer Social Security" cents={totals.ssEmployerCents} />
            <Row label="Employer Medicare" cents={totals.medicareEmployerCents} />
            <Row label="FUTA" cents={totals.futaCents} />
            <Row label="Illinois unemployment" cents={totals.ilSutaCents} />
            <Row label="Employer payroll tax" cents={employerTaxCents} />
            <Row label="Total cost to the business" cents={totals.employerCostCents} strong />
            <p className="text-muted text-xs mt-3 leading-relaxed">
              Of that, {formatUSD(totals.federalDepositCents)} goes to the IRS across the year
              and {formatUSD(totals.ilDepositCents + totals.ilSutaCents)} to Illinois.
              The {formatUSD(totals.fedWithholdingCents)} of federal income tax withheld is
              the figure you set above, not one this calculates &mdash; it needs the W-4 and
              the IRS withholding tables, which is your accountant&rsquo;s call.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

function Row({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 py-1.5 text-sm ${strong ? 'border-t border-line font-semibold mt-1 pt-2' : ''}`}>
      <span className={strong ? 'text-ink' : 'text-muted'}>{label}</span>
      <span className="tabular">{cents < 0 ? `(${formatAmount(-cents)})` : formatUSD(cents)}</span>
    </div>
  )
}
