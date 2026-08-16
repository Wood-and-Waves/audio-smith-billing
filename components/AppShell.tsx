import Link from 'next/link'
import Image from 'next/image'

// The site's nav, carried over: charcoal bar closed by a 2px amber rule.
// Anyone who has seen theaudiosmith.com should recognise this immediately.

const NAV = [
  { href: '/invoices', label: 'Invoices', key: 'invoices' },
  { href: '/shows', label: 'Shows', key: 'shows' },
  { href: '/clients', label: 'Clients', key: 'clients' },
  { href: '/settings', label: 'Settings', key: 'settings' },
] as const

export default function AppShell({
  current,
  children,
}: {
  current: (typeof NAV)[number]['key']
  children: React.ReactNode
}) {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-50 bg-bg border-b-2 border-accent">
        <div className="mx-auto max-w-5xl px-5 flex items-center justify-between h-16">
          <Link href="/invoices" className="flex items-center gap-3 min-w-0">
            <Image src="/logo.png" alt="The Audio Smith" width={34} height={34} priority />
            {/* The wordmark truncates to "T…" on a phone and the nav needs the
                room, so below sm the mark carries the identity on its own. */}
            <span className="hidden sm:inline display font-bold text-lg tracking-wide">
              The Audio <span className="text-accent">Smith</span>
            </span>
          </Link>

          <nav className="flex items-center gap-1 sm:gap-2">
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

      <main className="mx-auto max-w-5xl px-5 py-10">{children}</main>
    </div>
  )
}
