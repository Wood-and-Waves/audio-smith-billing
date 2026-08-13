import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Next 16 renames middleware.ts -> proxy.ts, exporting proxy().
//
// Everything is private except /login and /auth/*. Any route that must answer
// without a session — a cron endpoint, a public invoice link — has to be
// allowlisted HERE FIRST, or it silently gets a 307 to /login and the feature
// looks broken for reasons that never appear in its own logs. That trap cost
// CrewTracker a keepalive cron and a web manifest.
// /api/dev is the dev-login route, which by definition has no session yet —
// it is the thing that creates one. It guards itself (404s unless NODE_ENV is
// development AND the secret matches), so allowlisting it here is safe.
// /i is the public invoice link. It is a single page that reads through the
// public_invoice() function (migration 0006), which returns one invoice by
// unguessable token and nothing else — anon holds no table privileges.
const PUBLIC_PREFIXES = ['/login', '/auth', '/api/dev', '/i']

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  // Also refreshes the session cookie as a side effect. Don't remove.
  const { data: { user } } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  const isPublic = PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', path)
    return NextResponse.redirect(url)
  }

  if (user && path === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/invoices'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  // manifest.webmanifest is excluded BY NAME: the extension list below does
  // not cover it, and without this the middleware answers it with a 307.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|logo.png|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
