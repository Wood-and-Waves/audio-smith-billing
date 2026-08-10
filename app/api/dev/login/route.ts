import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createAdminClient } from '@supabase/supabase-js'

// Mints a real session cookie so a browser (or an agent driving one) can see
// logged-in pages during local development WITHOUT anyone handling Dan's
// password.
//
// Two independent gates, both returning a bare 404 so the route's existence
// is never confirmed to a prober:
//
//   1. NODE_ENV must be development. Vercel builds every deployment —
//      preview included — as production, so this is dead in the cloud.
//   2. DEV_LOGIN_SECRET must be set locally and match the query string.
//      Absent secret means the route is off, not open.
//
// If this file ever needs a third gate, add it. Never remove one.

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return new NextResponse(null, { status: 404 })
  }

  const secret = process.env.DEV_LOGIN_SECRET
  if (!secret || request.nextUrl.searchParams.get('secret') !== secret) {
    return new NextResponse(null, { status: 404 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  const admin = createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: users, error: listError } = await admin.auth.admin.listUsers({ perPage: 2 })
  if (listError || !users?.users.length) {
    return NextResponse.json({ error: listError?.message ?? 'No user exists' }, { status: 500 })
  }
  const email = users.users[0].email!

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkError || !link?.properties?.hashed_token) {
    return NextResponse.json({ error: linkError?.message ?? 'No token' }, { status: 500 })
  }

  const next = request.nextUrl.searchParams.get('next') ?? '/invoices'
  const response = NextResponse.redirect(new URL(next, request.nextUrl.origin))

  // The SSR client writes the session cookies onto the redirect response, so
  // the browser is signed in the moment it follows the redirect.
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) =>
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        ),
    },
  })

  const { error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'email',
  })
  if (verifyError) {
    return NextResponse.json({ error: verifyError.message }, { status: 500 })
  }

  return response
}
