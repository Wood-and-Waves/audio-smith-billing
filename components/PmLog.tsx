'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { addPmEntry, deletePmEntry } from '@/app/shows/actions'
import { formatDateShort, todayInChicago } from '@/lib/dates'
import { formatQty } from '@/lib/money'

type PmEntry = { id: string; worked_on: string; minutes: number; note: string | null }

// The whole point of logging PM this way instead of punching it is that
// 30 minutes of email should cost one tap. Each of these buttons submits
// immediately on click — there is no separate "Add" step for a preset.
const PRESETS: { label: string; minutes: number }[] = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '45m', minutes: 45 },
  { label: '1h', minutes: 60 },
  { label: '1h30', minutes: 90 },
  { label: '2h', minutes: 120 },
]

const field =
  'px-3 py-2 bg-surface border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none disabled:opacity-50'

/** "15m", "1h", "1h30" — matches the vocabulary of the preset buttons above. */
function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h${m}`
}

export default function PmLog({
  showId, entries, locked,
}: {
  showId: string
  entries: PmEntry[]
  locked: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [date, setDate] = useState(todayInChicago())
  const [note, setNote] = useState('')
  const [customMinutes, setCustomMinutes] = useState('')

  const sorted = [...entries].sort((a, b) => b.worked_on.localeCompare(a.worked_on))

  // Sessions sum first, THEN round up once for the whole show — mirrors
  // lib/showBuckets.ts computeShowLines exactly, so this preview can never
  // disagree with what actually lands on the invoice.
  const totalMinutes = entries.reduce((t, e) => t + e.minutes, 0)
  const billedHours = totalMinutes > 0 ? Math.ceil(totalMinutes / 60) : 0
  // minutes are always a multiple of 15 (enforced by addPmEntry), so this
  // division always lands on an exact hundredth — no float dust.
  const loggedHoursHundredths = Math.round((totalMinutes / 60) * 100)

  function add(minutes: number) {
    setError(null)
    start(async () => {
      const result = await addPmEntry(showId, date, minutes, note)
      if ('error' in result) { setError(result.error); return }
      setNote('')
      setCustomMinutes('')
      router.refresh()
    })
  }

  function addCustom() {
    setError(null)
    const minutes = Number(customMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setError('Enter a duration in minutes.')
      return
    }
    add(minutes)
  }

  function remove(id: string) {
    setError(null)
    start(async () => {
      const result = await deletePmEntry(id)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  return (
    <section className="mb-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
        <h2 className="eyebrow">Prep (PM)</h2>
        {totalMinutes > 0 && (
          <p className="tabular text-sm text-muted">
            {formatQty(loggedHoursHundredths)} hours logged · bills {billedHours}
          </p>
        )}
      </div>

      {sorted.length === 0 ? (
        <p className="text-muted border-l-2 border-line pl-4 py-1 mb-4">
          No prep time logged yet.
        </p>
      ) : (
        <ul className="border-t border-line mb-4">
          {sorted.map((e) => (
            <li key={e.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-line py-2">
              <span className="text-sm">
                {formatDateShort(e.worked_on)}
                <span className="tabular text-muted"> · {formatMinutes(e.minutes)}</span>
                {e.note && <span className="text-muted"> · {e.note}</span>}
              </span>
              <button
                type="button"
                disabled={locked || pending}
                onClick={() => remove(e.id)}
                aria-label={`Remove PM entry from ${formatDateShort(e.worked_on)}`}
                className="text-muted hover:text-danger transition-colors text-sm leading-none disabled:opacity-40"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-3 mb-3">
        <div>
          <label className="eyebrow block mb-1.5" htmlFor="pmDate">Date</label>
          <input id="pmDate" type="date" className={field} value={date} disabled={locked || pending}
                 onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <label className="eyebrow block mb-1.5" htmlFor="pmNote">Note (optional)</label>
          <input id="pmNote" type="text" className={`${field} w-full`} value={note}
                 disabled={locked || pending}
                 onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label} type="button" disabled={locked || pending}
            onClick={() => add(p.minutes)}
            className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-field
                       border border-line text-muted hover:text-ink disabled:opacity-40"
          >
            {p.label}
          </button>
        ))}
        <input
          type="number" min={15} step={15} placeholder="minutes" aria-label="Custom PM minutes"
          value={customMinutes} disabled={locked || pending}
          onChange={(e) => setCustomMinutes(e.target.value)}
          className={`${field} w-24`}
        />
        <button
          type="button" disabled={locked || pending || !customMinutes}
          onClick={addCustom}
          className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-field
                     border border-line text-muted hover:text-ink disabled:opacity-40"
        >
          {pending ? 'Adding…' : 'Add'}
        </button>
      </div>

      {locked && (
        <p className="text-xs text-muted mt-3">This show is billed, so prep time is locked.</p>
      )}
      {error && <p role="alert" className="text-xs text-danger mt-3">{error}</p>}
    </section>
  )
}
