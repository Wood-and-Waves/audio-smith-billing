'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/cn'
import { formatUSD } from '@/lib/money'

// YNAB's category dropdown (Wave B Task 3, Dan's screenshot) — a real
// combobox, not the select-only listbox components/ui/Select.tsx renders:
// the trigger is a text input that filters the grouped list as you type,
// because "every category, every group" is long enough that typing a few
// letters beats scanning. Everything else is deliberately Select.tsx's own
// visual language and keyboard idiom, ported rather than reinvented — the
// 2px-ink-border overlay, the hairline-ruled rows, the accent-wash active
// row, the accent-dot selected marker, and the Escape-stops-propagation fix
// (Select.tsx's own comment, 2026-08-24) so this picker's Escape can never
// close an enclosing dialog by mistake.
//
// Each row carries this month's budget Available (lib/budget.ts's
// buildBudget, run once by the page and handed down as a plain {id: cents}
// map — this component does no budget arithmetic of its own), colored
// text-good/text-danger by sign, plain at zero. A category buildBudget never
// scores a row for (an income-role category — see its own `spending`
// filter) simply carries no `availableCents`, which renders as no figure at
// all rather than a fabricated "$0.00".
//
// `extraOption` and `blankOption` are both caller-supplied rather than baked
// in here, on purpose: this same component is meant to become Task 3b's own
// "To"/"From" picker inside the directional move popover, and Task 5's home
// for a pinned Payment/Transfer row — neither built yet, both meant to land
// as pure prop additions once they do, never a rework of this file.
// `blankOption` is how MoneyRegister's three call sites keep today's
// "clear back to —" behavior (labeled "Uncategorized" there) without this
// component knowing that word; a future caller offering "Ready to Assign"
// instead just passes a different label. `extraOption` is how the edit
// row's since-hidden-category fallback rides through — see that call site's
// own comment for why one is sometimes needed.
export type CategoryPickerOption = {
  id: string
  name: string
  grp: string
  availableCents?: number
}

function balanceClass(cents: number | undefined): string {
  if (cents === undefined) return ''
  if (cents > 0) return 'text-good'
  if (cents < 0) return 'text-danger'
  return ''
}

export default function CategoryPicker({
  value,
  onChange,
  options,
  ariaLabel,
  disabled,
  size = 'md',
  className,
  extraOption,
  blankOption,
}: {
  value: string
  onChange: (id: string) => void
  options: readonly CategoryPickerOption[]
  ariaLabel?: string
  disabled?: boolean
  size?: 'md' | 'sm'
  className?: string
  /** An off-list id/label the current `value` points at (a hidden or
   *  deleted category) — rendered as its own checked row under "Selected"
   *  so the picker never lies about there being nothing there. Only ever
   *  meaningful when `extraOption.id === value`. */
  extraOption?: { id: string; label: string } | null
  /** A pinned row, above "+ New Category", that clears the selection back
   *  to `''` — labeled by the caller. Omit entirely to not offer one. */
  blankOption?: { label: string } | null
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  const q = query.trim().toLowerCase()
  const filtered = q === '' ? options : options.filter((o) => o.name.toLowerCase().includes(q))

  // Grouped in whatever order the groups first appear in `options` — the
  // caller (app/money/page.tsx) already sorts by grp/sort, so this only
  // buckets, it never re-sorts.
  const groups: { grp: string; items: CategoryPickerOption[] }[] = []
  const groupIndex = new Map<string, number>()
  for (const o of filtered) {
    let idx = groupIndex.get(o.grp)
    if (idx === undefined) {
      idx = groups.length
      groupIndex.set(o.grp, idx)
      groups.push({ grp: o.grp, items: [] })
    }
    groups[idx].items.push(o)
  }
  // Arrow-key traversal walks only the real, filtered categories — the
  // pinned rows around them (blankOption, "+ New Category", the Selected
  // echo) are reachable by Tab or click, the same split Select.tsx draws
  // between its trigger and its own options.
  const flatIds = groups.flatMap((g) => g.items.map((o) => o.id))

  const selectedFromOptions = options.find((o) => o.id === value)
  const selected: CategoryPickerOption | undefined =
    value === '' ? undefined :
    selectedFromOptions ??
    (extraOption && extraOption.id === value
      ? { id: extraOption.id, name: extraOption.label, grp: '' }
      : undefined)

  // `value === ''` with a `blankOption` offered is a REAL selected state
  // (MoveMoneyDialog's own Ready to Assign sentinel — now MovePopover's,
  // Wave B Task 3b — and MoneyRegister's own "Uncategorized"), not merely
  // "nothing chosen yet": the closed trigger showing the placeholder glyph
  // instead of that state's own label would read as blank/unset when it
  // isn't. `blankOption.label` only fills in here, on the CLOSED display —
  // the open listbox's own blank-row button (below) already carries the
  // accent-dot "selected" marker independent of this.
  const displayLabel = selected?.name ?? (value === '' ? blankOption?.label ?? '' : '')

  function openMenu() {
    setQuery('')
    const idx = options.findIndex((o) => o.id === value)
    setActive(idx >= 0 ? idx : 0)
    setOpen(true)
  }

  function pick(id: string) {
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  function onQueryChange(v: string) {
    setQuery(v)
    setActive(0)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) {
        e.preventDefault()
        openMenu()
        return
      }
      // A printable key while closed-but-focused (right after Escape, most
      // often) seeds the query directly rather than letting the browser
      // append it to the CLOSED display value (the selected name) — there
      // is no native onChange left to fix that up after the fact, since the
      // input's value only swaps from that name to `query` once `open` is
      // already true.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setQuery(e.key)
        setActive(0)
        setOpen(true)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive((i) => Math.min(i + 1, flatIds.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
        break
      case 'Home':
        e.preventDefault()
        setActive(0)
        break
      case 'End':
        e.preventDefault()
        setActive(flatIds.length - 1)
        break
      case 'Enter':
        e.preventDefault()
        if (flatIds[active]) pick(flatIds[active])
        break
      case 'Escape':
        e.preventDefault()
        // Select.tsx's own fixed idiom (2026-08-24): stop the key here so it
        // never bubbles into an enclosing dialog's own Escape handler —
        // MovePopover's, SnapReceipt's — when the user only meant to
        // close this listbox.
        e.stopPropagation()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        break
    }
  }

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  useEffect(() => {
    if (!open) return
    const id = flatIds[active]
    if (id) document.getElementById(`${listboxId}-${id}`)?.scrollIntoView({ block: 'nearest' })
    // flatIds is rebuilt every render (it's cheap — one pass over `options`)
    // and would otherwise retrigger this on every keystroke's filter change
    // even when active/open/listboxId didn't move; those three are the only
    // real dependencies of "which row needs scrolling into view."
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, listboxId])

  function OptionRow({ option }: { option: CategoryPickerOption }) {
    const isActive = flatIds[active] === option.id
    const isSelected = option.id === value
    return (
      <div
        id={`${listboxId}-${option.id}`}
        role="option"
        aria-selected={isSelected}
        onMouseEnter={() => setActive(flatIds.indexOf(option.id))}
        onClick={() => pick(option.id)}
        className={cn(
          'flex cursor-pointer items-center justify-between gap-2 whitespace-nowrap border-b border-line px-3 py-2 text-sm last:border-b-0 hover:bg-accent-wash',
          isActive && 'bg-accent-wash',
          isSelected ? 'font-semibold text-ink' : 'text-ink',
        )}
      >
        <span className="truncate">{option.name}</span>
        <span className="flex shrink-0 items-center gap-2">
          {option.availableCents !== undefined && (
            <span className={cn('tabular text-xs', balanceClass(option.availableCents))}>
              {formatUSD(option.availableCents)}
            </span>
          )}
          {isSelected && <span className="h-2 w-2 shrink-0 bg-accent" aria-hidden />}
        </span>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <input
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && flatIds[active] ? `${listboxId}-${flatIds[active]}` : undefined}
        disabled={disabled}
        placeholder="—"
        value={open ? query : displayLabel}
        onFocus={openMenu}
        onClick={() => { if (!open) openMenu() }}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        className={cn(
          'w-full rounded-field border border-line bg-surface-2 text-left text-ink placeholder:text-muted',
          'outline-none focus:border-accent disabled:opacity-60',
          size === 'md' ? 'pl-4 pr-7 py-2.5 text-sm' : 'pl-3 pr-7 py-1.5 text-sm',
        )}
      />
      {/* A solid triangle, not the browser's rounded chevron — Select.tsx's
          own trigger glyph, ported verbatim. */}
      <svg
        aria-hidden width="8" height="6" viewBox="0 0 8 6"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 shrink-0 fill-muted"
      >
        <path d="M0 0h8L4 6z" />
      </svg>

      {open && (
        <div
          className="absolute left-0 z-30 mt-1 max-h-80 min-w-full overflow-y-auto border-2 border-ink bg-surface shadow-edge"
          // Keep focus (and onBlur) on the trigger while clicking a row —
          // Select.tsx's own idiom.
          onMouseDown={(e) => e.preventDefault()}
        >
          {blankOption && (
            <button
              type="button"
              onClick={() => pick('')}
              className={cn(
                'flex w-full items-center justify-between gap-2 border-b border-line px-3 py-2 text-left text-sm text-muted hover:bg-accent-wash hover:text-ink',
                value === '' && 'font-semibold text-ink',
              )}
            >
              <span>{blankOption.label}</span>
              {value === '' && <span className="h-2 w-2 shrink-0 bg-accent" aria-hidden />}
            </button>
          )}
          <Link
            href="/money/categories"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-semibold text-accent hover:opacity-80"
          >
            ＋ New Category
          </Link>

          <div id={listboxId} role="listbox" aria-label={ariaLabel}>
            {selected && (
              <div>
                <div className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-muted">
                  Selected
                </div>
                <OptionRow option={selected} />
              </div>
            )}
            {groups.length === 0 && <div className="px-3 py-2 text-sm text-muted">No matches</div>}
            {groups.map((g) => (
              <div key={g.grp}>
                <div className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-muted">
                  {g.grp}
                </div>
                {g.items.map((o) => <OptionRow key={o.id} option={o} />)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
