'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/lib/cn'

// Replaces native <select> because the native control is the one piece of UI
// the browser draws in its own voice — a glossy rounded capsule and, worse,
// the macOS glass menu behind it — and that voice is not this one. Closed, it
// is a form field like any other. Open, it is a true overlay with a 2px ink
// border, hairline-ruled options, and a hard offset shadow.
//
// An option can carry a swatch so the menu itself says what the color means —
// color as information, in the picker.
//
// Keyboard: arrows move, Enter/Space picks, Esc closes, Home/End jump,
// typing seeks (type "v" in the role list, land on Video). Focus never leaves
// the trigger; the active option is announced via aria-activedescendant
// (the APG select-only combobox pattern).
//
// Replacing the native control also retires two documented Safari bugs with
// styled <option>s: invisible text against dark backgrounds, and the iPad
// hydration glitch that duplicated options in controlled selects.
//
// Ported verbatim from the sibling CrewTracker project.

export type SelectOption = {
  value: string
  label: string
  /** Tailwind bg-* class rendered as a small square before the label. */
  swatchClass?: string | null
}

export default function Select({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  size = 'md',
  className,
}: {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  ariaLabel?: string
  disabled?: boolean
  size?: 'md' | 'sm'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const seekRef = useRef({ text: '', at: 0 })
  const listboxId = useId()
  const selectedIndex = options.findIndex(o => o.value === value)
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined

  function openMenu() {
    setActive(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  function pick(index: number) {
    const opt = options[index]
    if (opt) onChange(opt.value)
    setOpen(false)
  }

  // Seek by typing: letters accumulate for a moment ("vi" → Video V1), then
  // the buffer resets. A repeated single letter cycles through its matches.
  function seek(char: string) {
    const now = Date.now()
    const prev = now - seekRef.current.at < 650 ? seekRef.current.text : ''
    const text = prev + char.toLowerCase()
    seekRef.current = { text, at: now }
    const from = text.length === 1 ? active + 1 : active
    for (let step = 0; step < options.length; step++) {
      const i = (from + step) % options.length
      if (options[i].label.toLowerCase().startsWith(text)) {
        setActive(i)
        return
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        openMenu()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive(i => Math.min(i + 1, options.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActive(i => Math.max(i - 1, 0))
        break
      case 'Home':
        e.preventDefault()
        setActive(0)
        break
      case 'End':
        e.preventDefault()
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        pick(active)
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          seek(e.key)
        }
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
    document.getElementById(`${listboxId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listboxId])

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        className={cn(
          'flex w-full items-center gap-2 rounded-field border border-line bg-surface-2 text-left text-ink',
          'outline-none focus:border-accent disabled:opacity-60',
          size === 'md' ? 'px-4 py-2.5 text-sm' : 'px-3 py-1.5 text-sm',
        )}
      >
        {current?.swatchClass && <span className={cn('h-2.5 w-2.5 shrink-0', current.swatchClass)} />}
        <span className={cn('min-w-0 flex-1 truncate', !current?.value && 'text-muted')}>
          {current?.label ?? '—'}
        </span>
        {/* A solid triangle, not the browser's rounded chevron: print, not gloss. */}
        <svg aria-hidden width="8" height="6" viewBox="0 0 8 6" className="shrink-0 fill-muted">
          <path d="M0 0h8L4 6z" />
        </svg>
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          // Keep focus (and onBlur) on the trigger while clicking options.
          onMouseDown={e => e.preventDefault()}
          className="absolute left-0 z-30 mt-1 max-h-72 min-w-full overflow-y-auto border-2 border-ink bg-surface shadow-edge"
        >
          {options.map((opt, i) => (
            <div
              key={opt.value || '∅'}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={i === selectedIndex}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
              className={cn(
                'flex cursor-pointer items-center gap-2 whitespace-nowrap border-b border-line px-3 py-2 text-sm last:border-b-0',
                i === active && 'bg-accent-wash',
                i === selectedIndex ? 'font-semibold text-ink' : 'text-ink',
                !opt.value && 'text-muted',
              )}
            >
              {opt.swatchClass && <span className={cn('h-2.5 w-2.5 shrink-0', opt.swatchClass)} />}
              <span>{opt.label}</span>
              {i === selectedIndex && <span className="ml-auto h-2 w-2 shrink-0 bg-accent" aria-hidden />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
