'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FIELD_FULL } from '@/components/ui/field'
import { saveCategory } from '@/app/money/actions'

export type CategoryRow = {
  id: string
  name: string
  grp: string
  sort: number
  hidden: boolean
  isEquipment: boolean
  deductible: boolean
}

/**
 * Buckets rows by grp, preserving the order they arrive in. The page's own
 * query already orders by (grp, sort), so every group's rows are contiguous
 * — a plain insertion-ordered Map is enough to bucket them without re-sorting
 * anything here.
 */
function groupBy(rows: CategoryRow[]): Map<string, CategoryRow[]> {
  const groups = new Map<string, CategoryRow[]>()
  for (const row of rows) {
    const bucket = groups.get(row.grp)
    if (bucket) bucket.push(row)
    else groups.set(row.grp, [row])
  }
  return groups
}

/**
 * The full chart of accounts, editable. Rows come straight from the server
 * page — nothing here keeps its own copy of the list, so a save just calls
 * router.refresh() and the next render is the new truth (same idiom as
 * MoneyRegister). The rename inputs are the one exception: they need
 * somewhere to hold what's being typed before it's saved, so each gets a
 * small local buffer keyed by row id.
 */
export default function CategoryEditor({ categories }: { categories: CategoryRow[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [newNames, setNewNames] = useState<Record<string, string>>({})

  const groups = groupBy(categories)

  function rename(row: CategoryRow) {
    setError(null)
    const name = (names[row.id] ?? row.name).trim()
    if (!name || name === row.name) {
      // Unchanged, or blanked back to nothing — a blank name is refused
      // server-side anyway, so this just reverts the input to the row's real
      // name instead of round-tripping a request that can only fail.
      setNames((prev) => { const next = { ...prev }; delete next[row.id]; return next })
      return
    }
    start(async () => {
      const result = await saveCategory({
        id: row.id, name, grp: row.grp, hidden: row.hidden, isEquipment: row.isEquipment,
        deductible: row.deductible,
      })
      if ('error' in result) { setError(result.error); return }
      setNames((prev) => { const next = { ...prev }; delete next[row.id]; return next })
      router.refresh()
    })
  }

  function toggle(row: CategoryRow, patch: { hidden?: boolean; isEquipment?: boolean; deductible?: boolean }) {
    setError(null)
    start(async () => {
      const result = await saveCategory({
        id: row.id,
        name: row.name,
        grp: row.grp,
        hidden: patch.hidden ?? row.hidden,
        isEquipment: patch.isEquipment ?? row.isEquipment,
        deductible: patch.deductible ?? row.deductible,
      })
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  function addToGroup(grp: string) {
    setError(null)
    const name = (newNames[grp] ?? '').trim()
    if (!name) { setError('Give the category a name.'); return }
    start(async () => {
      // Deductible defaults on for a new category, income group included —
      // Dan can untick it right away for an Income-group addition (income
      // rows are never a deduction), same as he can with Hidden/Equipment.
      const result = await saveCategory({ id: null, name, grp, hidden: false, isEquipment: false, deductible: true })
      if ('error' in result) { setError(result.error); return }
      setNewNames((prev) => ({ ...prev, [grp]: '' }))
      router.refresh()
    })
  }

  return (
    <section>
      {[...groups.entries()].map(([grp, rows]) => (
        <div key={grp} className="mb-10">
          <h2 className="eyebrow mb-3">{grp}</h2>
          <ul className="border-t border-line">
            {rows.map((row) => (
              <li key={row.id}
                  className="border-b border-line py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <input
                  aria-label={`Name for ${row.name}`}
                  className={`${FIELD_FULL} max-w-xs`}
                  value={names[row.id] ?? row.name}
                  disabled={pending}
                  onChange={(e) => setNames((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  onBlur={() => rename(row)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                />
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input type="checkbox" className="h-4 w-4 accent-accent" checked={row.hidden}
                         disabled={pending} onChange={(e) => toggle(row, { hidden: e.target.checked })} />
                  Hidden
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input type="checkbox" className="h-4 w-4 accent-accent" checked={row.isEquipment}
                         disabled={pending} onChange={(e) => toggle(row, { isEquipment: e.target.checked })} />
                  Equipment
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input type="checkbox" className="h-4 w-4 accent-accent" checked={row.deductible}
                         disabled={pending} onChange={(e) => toggle(row, { deductible: e.target.checked })} />
                  Deductible
                </label>
              </li>
            ))}
            <li className="py-3 flex items-center gap-3">
              <input
                aria-label={`New category in ${grp}`}
                placeholder="New category"
                className={`${FIELD_FULL} max-w-xs`}
                value={newNames[grp] ?? ''}
                disabled={pending}
                onChange={(e) => setNewNames((prev) => ({ ...prev, [grp]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') addToGroup(grp) }}
              />
              <button type="button" onClick={() => addToGroup(grp)} disabled={pending}
                      className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                                 border border-line text-muted hover:text-ink disabled:opacity-40">
                + Add
              </button>
            </li>
          </ul>
        </div>
      ))}

      {error && <p role="alert" className="text-xs text-danger mt-3">{error}</p>}
    </section>
  )
}
