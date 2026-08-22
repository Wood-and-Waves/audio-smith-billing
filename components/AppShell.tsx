import Link from 'next/link'
import Image from 'next/image'
import MobileNav from '@/components/MobileNav'
import SnapReceipt from '@/components/SnapReceipt'
import { createClient } from '@/lib/supabase/server'
import { todayInChicago } from '@/lib/dates'
import type { PickableShow } from '@/lib/showPicker'

// The site's nav, carried over: charcoal bar closed by a 2px amber rule.
// Anyone who has seen theaudiosmith.com should recognise this immediately.

const NAV = [
  { href: '/invoices', label: 'Invoices', key: 'invoices' },
  { href: '/shows', label: 'Shows', key: 'shows' },
  { href: '/calendar', label: 'Calendar', key: 'calendar' },
  { href: '/money', label: 'Money', key: 'money' },
  { href: '/clients', label: 'Clients', key: 'clients' },
  { href: '/settings', label: 'Settings', key: 'settings' },
] as const

export default async function AppShell({
  current,
  children,
  wide = false,
}: {
  current: (typeof NAV)[number]['key']
  children: React.ReactNode
  /** The register earns a wider canvas (nine columns on a big monitor);
   *  everything else reads better constrained. Header stays put either way
   *  so navigation doesn't jump between pages. */
  wide?: boolean
}) {
  // Feeds the mobile header's "snap a receipt" button (components/SnapReceipt.tsx):
  // which of the owner's shows count as "today" or belong in its picker.
  // AppShell renders on EVERY page in the app, so this query runs on every
  // render — deliberately kept to the three columns and the one join
  // SnapReceipt actually needs (no punches, no expenses, no PM entries).
  // Auth relies on RLS + the same "no user, no rows" fallback every read in
  // this file's sibling actions uses — there is no redirect here because
  // AppShell itself is not the place any page currently gates sign-in.
  const supabase = await createClient()
  const { data: showRows } = await supabase
    .from('shows')
    .select('id, name, status, show_days(date)')
  const shows: PickableShow[] = (showRows ?? []).map((s) => ({
    id: s.id as string,
    name: s.name as string,
    status: s.status as 'open' | 'billed',
    dates: ((s.show_days ?? []) as { date: string }[]).map((d) => d.date),
  }))
  const today = todayInChicago()

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-50 bg-bg border-b-2 border-accent">
        <div className="mx-auto max-w-5xl px-6 flex items-center justify-between h-16">
          <Link href="/shows" className="flex items-center gap-3 min-w-0">
            <Image src="/logo.png" alt="The Audio Smith" width={34} height={34} priority />
            {/* On a phone the mark carries the identity on its own — with the
                menu now behind a button there is room for the wordmark again,
                but the collapse point stays at sm to keep the bar calm. */}
            <span className="hidden sm:inline display font-bold text-lg tracking-wide">
              The Audio <span className="text-accent">Smith</span>
            </span>
          </Link>

          {/* Below sm the links collapse into a hamburger; the inline bar is
              desktop-only. Snap-a-receipt sits beside it — under Dan's thumb
              the moment the app opens on his phone — and is mobile-only for
              the same reason as the design doc: receipts aren't photographed
              at a desk. */}
          <div className="sm:hidden flex items-center gap-1">
            <SnapReceipt shows={shows} today={today} />
            <MobileNav items={NAV} current={current} />
          </div>

          <nav className="hidden sm:flex items-center gap-1 sm:gap-2">
            {NAV.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                aria-current={item.key === current ? 'page' : undefined}
                // text-[12px] rather than text-xs, deliberately: the phone type
                // scale raises text-xs, and this bar is the tightest thing in
                // the app — four uppercase labels plus the logo inside 335px,
                // already tight enough that the wordmark is hidden below sm. It
                // is the first thing that would overflow, and nav labels are
                // found by position more than by reading. Tracking tightens on
                // a phone for the same reason.
                className={`px-2.5 sm:px-3 py-2 text-[12px] font-semibold uppercase
                            tracking-wide sm:tracking-wider rounded-field
                            transition-colors ${
                              item.key === current
                                ? 'text-accent'
                                : 'text-muted hover:text-ink'
                            }`}
              >
                {item.label}
              </Link>
            ))}
            {/* Sign-out is a POST form, not a link: a GET sign-out is CSRF-able
                and prefetchable. Styled as a nav item so it reads as one. */}
            <form action="/auth/signout" method="post" className="contents">
              <button
                type="submit"
                className="px-2.5 sm:px-3 py-2 text-[12px] font-semibold uppercase
                           tracking-wide sm:tracking-wider rounded-field
                           transition-colors text-muted hover:text-ink"
              >
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>

      <main className={`mx-auto ${wide ? 'max-w-[96rem]' : 'max-w-5xl'} px-6 py-10`}>{children}</main>
    </div>
  )
}
