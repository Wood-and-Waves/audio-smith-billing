'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD, parseUSD } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'
import { FIELD_FULL } from '@/components/ui/field'
import Select from '@/components/ui/Select'
import { saveEnvelope, moveEnvelopeMoney } from '@/app/money/actions'

export type EnvelopeRow = {
  id: string
  name: string
  hidden: boolean
  balanceCents: number
}

export type EnvelopeMoveRow = {
  id: string
  amountCents: number
  /** "Available" or an envelope name — already resolved server-side. */
  fromName: string
  toName: string
  movedOn: string
  note: string | null
}

/**
 * The whole budget screen below the page's own h1: Available to allocate,
 * the editable envelope list, the move-money form, and the immutable move
 * history. Rows come straight from the server page — nothing here keeps its
 * own copy (same idiom as CategoryEditor/MoneyRegister): a save just calls
 * router.refresh() and the next render is the new truth. The rename inputs
 * are the one exception, same as CategoryEditor's own `names` buffer — they
 * need somewhere to hold what's being typed before it's saved.
 */
export default function BudgetPanel({
  availableCents, envelopes, moves,
}: {
  availableCents: number
  envelopes: EnvelopeRow[]
  moves: EnvelopeMoveRow[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')

  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  function rename(row: EnvelopeRow) {
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
      const result = await saveEnvelope({ id: row.id, name, hidden: row.hidden })
      if ('error' in result) { setError(result.error); return }
      setNames((prev) => { const next = { ...prev }; delete next[row.id]; return next })
      router.refresh()
    })
  }

  // The checkbox is disabled outright whenever the envelope carries a
  // balance — not just for the hide direction — because a funded-and-hidden
  // row only ever appears here in the first place when it's stuck that way
  // (the page's own filter keeps a hidden envelope visible exactly while its
  // balance is nonzero). Emptying it is what makes both directions safe
  // again, so there's nothing this toggle could correctly do until then.
  function toggleHidden(row: EnvelopeRow) {
    setError(null)
    start(async () => {
      const result = await saveEnvelope({ id: row.id, name: row.name, hidden: !row.hidden })
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  function addEnvelope() {
    setError(null)
    const name = newName.trim()
    if (!name) { setError('Give the envelope a name.'); return }
    start(async () => {
      const result = await saveEnvelope({ id: null, name, hidden: false })
      if ('error' in result) { setError(result.error); return }
      setNewName('')
      router.refresh()
    })
  }

  // Available plus every envelope currently listed, balance in the label —
  // the same set the envelope list above shows, so a hidden-but-funded
  // envelope (still listed) can be picked as a source to empty it out, same
  // as any other.
  const moveOptions = [
    { value: '', label: `Available · ${formatUSD(availableCents)}` },
    ...envelopes.map((e) => ({ value: e.id, label: `${e.name} · ${formatUSD(e.balanceCents)}` })),
  ]

  // Only the obvious in-UI guard (from === to, caught by the submit button's
  // own disabled state below) — everything else (amount > 0, ownership) is
  // left to moveEnvelopeMoney itself, same "guard the obvious, trust the
  // server" split the rest of this app uses. A blank amount field parses to
  // null (lib/money's parseUSD), coerced to 0 here rather than treated as a
  // client-side error, so the server's own "Enter an amount to move." is the
  // one message Dan ever sees for that case.
  function moveMoney() {
    setError(null)
    const amountCents = parseUSD(amount) ?? 0
    start(async () => {
      const result = await moveEnvelopeMoney({
        fromEnvelopeId: fromId || null,
        toEnvelopeId: toId || null,
        amountCents,
        note,
      })
      if ('error' in result) { setError(result.error); return }
      setFromId('')
      setToId('')
      setAmount('')
      setNote('')
      router.refresh()
    })
  }

  return (
    <div>
      <section className="mb-10">
        <h2 className="eyebrow mb-3">Available to allocate</h2>
        <p
          className={`tabular text-4xl font-bold ${
            availableCents > 0 ? 'text-good' : availableCents < 0 ? 'text-danger' : 'text-muted'
          }`}
        >
          {formatUSD(availableCents)}
        </p>
        {availableCents < 0 && (
          <p className="text-xs text-danger mt-2">
            Over-allocated — more assigned than the account holds.
          </p>
        )}
      </section>

      <section className="mb-10">
        <h2 className="eyebrow mb-3">Envelopes</h2>
        {envelopes.length === 0 ? (
          <p className="text-muted border-l-2 border-line pl-4 py-1">No envelopes yet.</p>
        ) : (
          <ul className="border-t border-line">
            {envelopes.map((row) => {
              const locked = row.balanceCents !== 0
              return (
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
                  <span className="tabular text-sm font-semibold ml-auto sm:ml-0">
                    {formatUSD(row.balanceCents)}
                  </span>
                  <label
                    className="flex items-center gap-1.5 text-xs text-muted"
                    title={locked ? 'Empty it before hiding' : undefined}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={row.hidden}
                      disabled={pending || locked}
                      onChange={() => toggleHidden(row)}
                    />
                    Hidden
                  </label>
                </li>
              )
            })}
            <li className="py-3 flex items-center gap-3">
              <input
                aria-label="New envelope"
                placeholder="New envelope"
                className={`${FIELD_FULL} max-w-xs`}
                value={newName}
                disabled={pending}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addEnvelope() }}
              />
              <button type="button" onClick={addEnvelope} disabled={pending}
                      className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                                 border border-line text-muted hover:text-ink disabled:opacity-40">
                + Add
              </button>
            </li>
          </ul>
        )}
      </section>

      <section className="mb-10">
        <h2 className="eyebrow mb-3">Move money</h2>
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-[1fr_1fr_8rem_1fr_auto] items-center">
          <Select ariaLabel="From" value={fromId} disabled={pending} onChange={setFromId} options={moveOptions} />
          <Select ariaLabel="To" value={toId} disabled={pending} onChange={setToId} options={moveOptions} />
          <input aria-label="Amount" inputMode="decimal" placeholder="0.00"
                 className={`${FIELD_FULL} tabular text-right`} value={amount} disabled={pending}
                 onChange={(e) => setAmount(e.target.value)} />
          <input aria-label="Note" placeholder="Note (optional)" className={FIELD_FULL} value={note}
                 disabled={pending} onChange={(e) => setNote(e.target.value)} />
          <button
            type="button"
            onClick={moveMoney}
            disabled={pending || fromId === toId}
            className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                       border border-line text-muted hover:text-ink disabled:opacity-40"
          >
            {pending ? 'Moving…' : 'Move'}
          </button>
        </div>
      </section>

      {error && <p role="alert" className="text-xs text-danger mb-6">{error}</p>}

      <section>
        <h2 className="eyebrow mb-3">Recent moves</h2>
        {/* No edit/delete anywhere in this list — moves are IMMUTABLE
            (migration 0030, and moveEnvelopeMoney's own doc comment). This is
            the audit trail: a mistaken move is corrected by entering the
            opposite move as a new row, not by rewriting this one. */}
        {moves.length === 0 ? (
          <p className="text-muted border-l-2 border-line pl-4 py-1">No moves yet.</p>
        ) : (
          <ul className="border-t border-line">
            {moves.map((m) => (
              <li key={m.id} className="border-b border-line py-2 text-xs text-muted tabular">
                {formatDateShort(m.movedOn)} · {formatUSD(m.amountCents)} · {m.fromName} → {m.toName}
                {m.note && ` · ${m.note}`}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
