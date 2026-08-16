import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { safeNext } from '@/lib/safeNext'

// Exchanges a one-time code for a session cookie. This is the landing point
// for magic links and password-reset links.
//
// Allowlisted in proxy.ts under /auth — it must answer without a session, or
// it gets redirected to /login and the link silently never works.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  // safeNext guarantees a leading single '/', so `${origin}${next}` can only ever
  // resolve on this origin. Without it, ?next=@evil.com concatenates to
  // https://origin@evil.com (host evil.com, origin parsed as userinfo) and
  // ?next=.evil.com to an attacker subdomain — both off-site redirects.
  const next = safeNext(searchParams.get('next'))

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`)
  }

  return NextResponse.redirect(`${origin}${next}`)
}
