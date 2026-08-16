'use client'

import Link from 'next/link'
import { useState, useEffect, useRef } from 'react'

// The phone nav. The top bar could not hold five uppercase labels plus the
// logo inside ~335px — "Sign out" tipped it into wrapping — so below sm the
// links collapse behind this button. Desktop keeps the full inline bar; this
// renders only under sm (see AppShell).

type Item = { href: string; label: string; key: string }

export default function MobileNav({
  items, current,
}: {
  items: readonly Item[]
  current: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Escape and a tap outside close it — the two gestures a menu is expected to
  // honour. Only wired while open, so the listeners aren't live for nothing.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((o) => !o)}
        className="p-2 -mr-2 text-ink"
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {open
            ? <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            : <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
        </svg>
      </button>

      {open && (
        <div
          id="mobile-menu"
          className="absolute right-0 top-full mt-2 w-52 py-1 z-50
                     bg-surface border border-line rounded-card shadow-lg"
        >
          {items.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.key === current ? 'page' : undefined}
              onClick={() => setOpen(false)}
              className={`block px-4 py-3 text-sm font-semibold uppercase tracking-wide ${
                item.key === current ? 'text-accent' : 'text-ink hover:bg-bg'
              }`}
            >
              {item.label}
            </Link>
          ))}
          {/* Sign-out stays a POST form even in the menu: a GET sign-out is
              CSRF-able and can be tripped by a link prefetcher. */}
          <form action="/auth/signout" method="post" className="border-t border-line">
            <button
              type="submit"
              className="block w-full text-left px-4 py-3 text-sm font-semibold
                         uppercase tracking-wide text-muted hover:bg-bg"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
