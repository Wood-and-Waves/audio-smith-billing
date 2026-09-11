'use client'

// The tax figures every paycheck is computed from, on screen and editable.
//
// They are here rather than buried in code for two reasons. First, they are
// not knowable ahead of time: SSA announces the next Social Security wage base
// in October, and the Illinois unemployment rate is specific to Dan's own IDES
// account and arrives in a letter. Second, and more important — a wrong figure
// here is a wrong payment to the IRS, and the only defence that has ever
// worked is putting the numbers in front of the person who can recognise them.
//
// Rates are stored as basis points and shown as percentages, because nobody
// checking a rate against a letter from IDES thinks in basis points.

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatAmount } from '@/lib/money'
import { parseUSDMath } from '@/lib/moneyMath'
import { FIELD_FULL } from '@/components/ui/field'
import { saveTaxYear } from '@/app/money/payroll/actions'
import type { TaxYearRules } from '@/lib/payrollRules'

type FieldSpec = {
  key: keyof TaxYearRules
  label: string
  kind: 'percent' | 'money'
}

const FIELDS: FieldSpec[] = [
  { key: 'ssRateBp', label: 'Social Security rate (each side)', kind: 'percent' },
  { key: 'ssWageBaseCents', label: 'Social Security wage base', kind: 'money' },
  { key: 'medicareRateBp', label: 'Medicare rate (each side)', kind: 'percent' },
  { key: 'addlMedicareRateBp', label: 'Additional Medicare rate', kind: 'percent' },
  { key: 'addlMedicareThresholdCents', label: 'Additional Medicare threshold', kind: 'money' },
  { key: 'futaRateBp', label: 'FUTA rate (after state credit)', kind: 'percent' },
  { key: 'futaWageBaseCents', label: 'FUTA wage base', kind: 'money' },
  { key: 'ilIncomeRateBp', label: 'Illinois income tax rate', kind: 'percent' },
  { key: 'ilAllowanceCents', label: 'Illinois allowance (each, annual)', kind: 'money' },
  { key: 'ilSutaRateBp', label: 'Illinois unemployment rate', kind: 'percent' },
  { key: 'ilSutaWageBaseCents', label: 'Illinois unemployment wage base', kind: 'money' },
]

const showValue = (rules: TaxYearRules, f: FieldSpec): string =>
  f.kind === 'percent'
    ? String((rules[f.key] as number) / 100)
    : formatAmount(rules[f.key] as number)

const readValue = (raw: string, kind: 'percent' | 'money'): number | null => {
  if (kind === 'money') {
    const cents = parseUSDMath(raw)
    return cents === null || cents < 0 ? null : cents
  }
  const pct = Number(raw.trim().replace('%', ''))
  if (!Number.isFinite(pct) || pct < 0) return null
  return Math.round(pct * 100)
}

export default function PayrollRules({ taxYears }: { taxYears: TaxYearRules[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [newYear, setNewYear] = useState('')
  const [error, setError] = useState<string | null>(null)

  function edit(rules: TaxYearRules) {
    const next: Record<string, string> = {}
    for (const f of FIELDS) next[f.key] = showValue(rules, f)
    setDraft(next)
    setNote(rules.note)
    setEditing(rules.year)
    setError(null)
  }

  function addYear() {
    setError(null)
    const year = Number(newYear.trim())
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      setError('Enter a year, like 2027.'); return
    }
    if (taxYears.some((y) => y.year === year)) { setError(`${year} is already on file.`); return }
    // Seed the form from the most recent year so only what CHANGED has to be
    // typed — but it saves nothing until he presses save, so nothing is
    // assumed on his behalf.
    const latest = [...taxYears].sort((a, b) => b.year - a.year)[0]
    const next: Record<string, string> = {}
    for (const f of FIELDS) next[f.key] = latest === undefined ? '0' : showValue(latest, f)
    setDraft(next)
    setNote(`Entered by hand for ${year}. Check each figure against the IRS and IDES notices.`)
    setEditing(year)
  }

  function save(year: number) {
    setError(null)
    const values: Record<string, number> = {}
    for (const f of FIELDS) {
      const value = readValue(draft[f.key] ?? '', f.kind)
      if (value === null) { setError(`${f.label} is not a number.`); return }
      values[f.key] = value
    }
    start(async () => {
      const result = await saveTaxYear({
        year,
        ssRateBp: values.ssRateBp,
        ssWageBaseCents: values.ssWageBaseCents,
        medicareRateBp: values.medicareRateBp,
        addlMedicareRateBp: values.addlMedicareRateBp,
        addlMedicareThresholdCents: values.addlMedicareThresholdCents,
        futaRateBp: values.futaRateBp,
        futaWageBaseCents: values.futaWageBaseCents,
        ilIncomeRateBp: values.ilIncomeRateBp,
        ilAllowanceCents: values.ilAllowanceCents,
        ilSutaRateBp: values.ilSutaRateBp,
        ilSutaWageBaseCents: values.ilSutaWageBaseCents,
        note,
      })
      if ('error' in result) { setError(result.error); return }
      setEditing(null)
      setNewYear('')
      router.refresh()
    })
  }

  return (
    <section className="mb-12">
      <div className="flex items-center justify-between mb-3">
        <h2 className="eyebrow">Tax figures</h2>
        <div className="flex items-center gap-2">
          <input
            type="text" inputMode="numeric" aria-label="Year to add"
            placeholder="2027" value={newYear} onChange={(e) => setNewYear(e.target.value)}
            className="px-3 py-1.5 w-24 bg-surface border border-line rounded-field text-ink text-sm focus:border-accent focus:outline-none"
          />
          <button
            type="button" onClick={addYear}
            className="rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted hover:text-ink transition-colors"
          >
            Add a year
          </button>
        </div>
      </div>

      {error !== null && editing === null && (
        <p role="alert" className="text-danger border-l-2 border-danger pl-3 py-1 mb-4 text-sm">{error}</p>
      )}

      {taxYears.length === 0 && editing === null && (
        <p className="text-muted text-sm border-l-2 border-line pl-4 py-2">
          No tax figures on file. Add a year before recording a computed paycheck.
        </p>
      )}

      {editing !== null && (
        <div className="border border-line rounded-card p-4 mb-6">
          <h3 className="display text-lg font-bold mb-4">{editing}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
            {FIELDS.map((f) => (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="eyebrow">{f.label}{f.kind === 'percent' ? ' (%)' : ''}</span>
                <input
                  type="text" inputMode="decimal" className={FIELD_FULL}
                  value={draft[f.key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <label className="flex flex-col gap-1 mb-4">
            <span className="eyebrow">Where these came from</span>
            <textarea
              className={FIELD_FULL} rows={2}
              value={note} onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error !== null && (
            <p role="alert" className="text-danger border-l-2 border-danger pl-3 py-1 mb-4 text-sm">{error}</p>
          )}
          <div className="flex gap-2">
            <button
              type="button" disabled={pending} onClick={() => save(editing)}
              className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider text-sm rounded-field hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button" disabled={pending} onClick={() => { setEditing(null); setError(null) }}
              className="px-5 py-2.5 border border-line text-muted hover:text-ink font-bold uppercase tracking-wider text-sm rounded-field transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {taxYears.map((rules) => (
        <div key={rules.year} className="border-b border-line py-4">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="display text-lg font-bold">{rules.year}</h3>
            <button
              type="button" onClick={() => edit(rules)}
              className="rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted hover:text-ink transition-colors"
            >
              Edit
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-1 text-sm">
            {FIELDS.map((f) => (
              <div key={f.key} className="flex justify-between gap-4">
                <span className="text-muted">{f.label}</span>
                <span className="tabular">
                  {f.kind === 'percent'
                    ? `${(rules[f.key] as number) / 100}%`
                    : `$${formatAmount(rules[f.key] as number)}`}
                </span>
              </div>
            ))}
          </div>
          {rules.note.trim() !== '' && (
            <p className="text-muted text-xs mt-3 leading-relaxed">{rules.note}</p>
          )}
        </div>
      ))}
    </section>
  )
}
