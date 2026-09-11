'use client'

// The paycheck register: what was actually paid, and when.
//
// The register is the SOURCE OF TRUTH, not the calculator. Whether the figures
// came from this app's arithmetic or from a payroll service is recorded on
// each row (`source`), because who runs payroll is still an open question and
// the record has to hold under either answer.
//
// Year-to-date wages are taken from the rows already on file, which is what
// makes the wage bases come out right: Social Security stops at its ceiling
// and FUTA stops at $7,000, and neither can be worked out from one cheque.

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD } from '@/lib/money'
import { parseUSDMath } from '@/lib/moneyMath'
import { formatDateShort, isPlainDate } from '@/lib/dates'
import { FIELD_FULL } from '@/components/ui/field'
import { computePaycheck, validateRunFigures, type RunFigures } from '@/lib/payrollCalc'
import { findRules, type TaxYearRules } from '@/lib/payrollRules'
import { recordPayrollRun, deletePayrollRun } from '@/app/money/payroll/actions'

export type RunRow = RunFigures & {
  id: string
  payDate: string
  periodStart: string
  periodEnd: string
  source: 'computed' | 'entered'
  rulesYear: number | null
  memo: string | null
}

const MANUAL_FIELDS: { key: keyof RunFigures; label: string }[] = [
  { key: 'grossCents', label: 'Gross' },
  { key: 'fedWithholdingCents', label: 'Federal income tax' },
  { key: 'ssEmployeeCents', label: 'Social Security withheld' },
  { key: 'medicareEmployeeCents', label: 'Medicare withheld' },
  { key: 'addlMedicareCents', label: 'Additional Medicare' },
  { key: 'ilWithholdingCents', label: 'Illinois withheld' },
  { key: 'netCents', label: 'Net pay' },
  { key: 'ssEmployerCents', label: 'Employer Social Security' },
  { key: 'medicareEmployerCents', label: 'Employer Medicare' },
  { key: 'futaCents', label: 'FUTA' },
  { key: 'ilSutaCents', label: 'Illinois unemployment' },
]

export default function PayrollRuns({
  runs, taxYears, today,
}: { runs: RunRow[]; taxYears: TaxYearRules[]; today: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [payDate, setPayDate] = useState(today)
  const [periodStart, setPeriodStart] = useState(`${today.slice(0, 7)}-01`)
  const [periodEnd, setPeriodEnd] = useState(today)
  const [gross, setGross] = useState('')
  const [fedWithholding, setFedWithholding] = useState('')
  const [allowances, setAllowances] = useState('0')
  const [manual, setManual] = useState(false)
  const [manualFigures, setManualFigures] = useState<Record<string, string>>({})

  const year = Number(payDate.slice(0, 4))
  const rules = findRules(taxYears, year)

  // Wages already paid this calendar year, before this cheque. Only rows
  // strictly earlier count, so inserting a correction mid-year behaves.
  const ytdWagesCents = useMemo(
    () => runs
      .filter((r) => r.payDate.slice(0, 4) === payDate.slice(0, 4) && r.payDate < payDate)
      .reduce((sum, r) => sum + r.grossCents, 0),
    [runs, payDate],
  )

  const computed = useMemo(() => {
    if (rules === null) return null
    const grossCents = parseUSDMath(gross)
    if (grossCents === null || grossCents < 0) return null
    const n = Number(allowances)
    return computePaycheck({
      grossCents,
      ytdWagesCents,
      fedWithholdingCents: parseUSDMath(fedWithholding) ?? 0,
      ilAllowances: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0,
      periodsPerYear: 12,
      rules,
    })
  }, [rules, gross, fedWithholding, allowances, ytdWagesCents])

  function manualCents(key: keyof RunFigures): number {
    return parseUSDMath(manualFigures[key] ?? '') ?? 0
  }

  function save() {
    setError(null)
    if (!isPlainDate(payDate)) { setError('Pick a pay date.'); return }
    if (!isPlainDate(periodStart) || !isPlainDate(periodEnd)) {
      setError('Pick the period this cheque covers.'); return
    }

    let figures: RunFigures
    if (manual) {
      figures = {
        grossCents: manualCents('grossCents'),
        fedWithholdingCents: manualCents('fedWithholdingCents'),
        ssEmployeeCents: manualCents('ssEmployeeCents'),
        medicareEmployeeCents: manualCents('medicareEmployeeCents'),
        addlMedicareCents: manualCents('addlMedicareCents'),
        ilWithholdingCents: manualCents('ilWithholdingCents'),
        ssEmployerCents: manualCents('ssEmployerCents'),
        medicareEmployerCents: manualCents('medicareEmployerCents'),
        futaCents: manualCents('futaCents'),
        ilSutaCents: manualCents('ilSutaCents'),
        netCents: manualCents('netCents'),
      }
    } else if (computed === null) {
      setError(rules === null
        ? `No tax figures on file for ${year}. Add them below, or enter this paycheck yourself.`
        : 'Enter the gross pay.')
      return
    } else {
      figures = computed
    }

    const problem = validateRunFigures(figures)
    if (problem !== null) { setError(problem); return }

    start(async () => {
      const result = await recordPayrollRun({
        ...figures,
        payDate,
        periodStart,
        periodEnd,
        source: manual ? 'entered' : 'computed',
        rulesYear: manual ? null : year,
        memo: null,
      })
      if ('error' in result) { setError(result.error); return }
      setAdding(false)
      setGross('')
      setFedWithholding('')
      setManualFigures({})
      router.refresh()
    })
  }

  function remove(id: string) {
    setError(null)
    start(async () => {
      const result = await deletePayrollRun(id)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  return (
    <section className="mb-12">
      <div className="flex items-center justify-between mb-3">
        <h2 className="eyebrow">Paychecks</h2>
        <button
          type="button" onClick={() => { setAdding(!adding); setError(null) }}
          className="rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted hover:text-ink transition-colors"
        >
          {adding ? 'Cancel' : 'Record a paycheck'}
        </button>
      </div>

      {adding && (
        <div className="border border-line rounded-card p-4 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-4">
            <Field label="Pay date"><input type="date" className={FIELD_FULL} value={payDate} onChange={(e) => setPayDate(e.target.value)} /></Field>
            <Field label="Period from"><input type="date" className={FIELD_FULL} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></Field>
            <Field label="Period to"><input type="date" className={FIELD_FULL} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field>
            {!manual && <>
              <Field label="Gross"><input type="text" inputMode="decimal" className={FIELD_FULL} placeholder="0.00" value={gross} onChange={(e) => setGross(e.target.value)} /></Field>
              <Field label="Federal w/h"><input type="text" inputMode="decimal" className={FIELD_FULL} placeholder="0.00" value={fedWithholding} onChange={(e) => setFedWithholding(e.target.value)} /></Field>
              <Field label="IL allowances"><input type="text" inputMode="numeric" className={FIELD_FULL} placeholder="0" value={allowances} onChange={(e) => setAllowances(e.target.value)} /></Field>
            </>}
          </div>

          <label className="flex items-center gap-2 text-sm text-muted mb-4">
            <input type="checkbox" checked={manual} onChange={(e) => { setManual(e.target.checked); setError(null) }} />
            Enter the figures myself &mdash; my accountant or payroll service computed them
          </label>

          {manual ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-4">
              {MANUAL_FIELDS.map((f) => (
                <Field key={f.key} label={f.label}>
                  <input
                    type="text" inputMode="decimal" className={FIELD_FULL} placeholder="0.00"
                    value={manualFigures[f.key] ?? ''}
                    onChange={(e) => setManualFigures({ ...manualFigures, [f.key]: e.target.value })}
                  />
                </Field>
              ))}
            </div>
          ) : computed !== null && (
            <div className="text-sm mb-4">
              <p className="text-muted mb-2">
                Take-home <span className="tabular text-ink font-semibold">{formatUSD(computed.netCents)}</span>
                {' · '}costs the business <span className="tabular text-ink font-semibold">{formatUSD(computed.employerCostCents)}</span>
                {ytdWagesCents > 0 && <> · {formatUSD(ytdWagesCents)} paid earlier this year</>}
              </p>
              <p className="text-muted text-xs">
                IRS {formatUSD(computed.federalDepositCents)} · Illinois {formatUSD(computed.ilDepositCents + computed.ilSutaCents)} · FUTA {formatUSD(computed.futaCents)}
              </p>
            </div>
          )}

          {rules === null && !manual && (
            <p role="alert" className="text-danger border-l-2 border-danger pl-3 py-1 mb-4 text-sm">
              No tax figures on file for {year}. Add them below, or tick the box and enter this paycheck yourself.
            </p>
          )}

          {error !== null && (
            <p role="alert" className="text-danger border-l-2 border-danger pl-3 py-1 mb-4 text-sm">{error}</p>
          )}

          <button
            type="button" disabled={pending} onClick={save}
            className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider text-sm rounded-field hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Record it'}
          </button>
        </div>
      )}

      {runs.length === 0 ? (
        <p className="text-muted text-sm border-l-2 border-line pl-4 py-2">
          No paychecks recorded. Every dollar taken out so far is an owner draw &mdash;
          which is not a deduction, and not the same thing as a salary.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="eyebrow pb-2 pr-3 text-left font-semibold">Pay date</th>
                <th className="eyebrow pb-2 px-3 text-left font-semibold">Period</th>
                <th className="eyebrow pb-2 px-3 text-right font-semibold">Gross</th>
                <th className="eyebrow pb-2 px-3 text-right font-semibold">Withheld</th>
                <th className="eyebrow pb-2 px-3 text-right font-semibold">Net</th>
                <th className="eyebrow pb-2 px-3 text-right font-semibold">Employer tax</th>
                <th className="eyebrow pb-2 px-3 text-left font-semibold">Figures</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const withheld = r.fedWithholdingCents + r.ssEmployeeCents
                  + r.medicareEmployeeCents + r.addlMedicareCents + r.ilWithholdingCents
                const employerTax = r.ssEmployerCents + r.medicareEmployerCents
                  + r.futaCents + r.ilSutaCents
                return (
                  <tr key={r.id} className="border-b border-line">
                    <td className="tabular py-2.5 pr-3">{formatDateShort(r.payDate)}</td>
                    <td className="px-3 py-2.5 text-muted">
                      {formatDateShort(r.periodStart)} &ndash; {formatDateShort(r.periodEnd)}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">{formatUSD(r.grossCents)}</td>
                    <td className="tabular px-3 py-2.5 text-right text-muted">{formatUSD(withheld)}</td>
                    <td className="tabular px-3 py-2.5 text-right font-semibold">{formatUSD(r.netCents)}</td>
                    <td className="tabular px-3 py-2.5 text-right text-muted">{formatUSD(employerTax)}</td>
                    <td className="px-3 py-2.5 text-muted text-xs uppercase tracking-wider">
                      {r.source === 'entered' ? 'Entered' : `Computed ${r.rulesYear ?? ''}`}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button" disabled={pending} onClick={() => remove(r.id)}
                        className="rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted hover:text-danger transition-colors disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!adding && error !== null && (
        <p role="alert" className="text-danger border-l-2 border-danger pl-3 py-1 mt-4 text-sm">{error}</p>
      )}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      {children}
    </label>
  )
}
