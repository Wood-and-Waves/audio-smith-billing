import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Signs the operator out. POST only: a GET sign-out is CSRF-able and would be
// tripped by link prefetchers. Server-side so signOut() revokes the refresh
// token at Supabase — the session cookie otherwise lives 400 days, and this is
// an installable phone app used on show floors.
//
// Allowlisted in proxy.ts under /auth — it must answer without depending on the
// redirect that follows, and the sign-out itself clears the session cookie.
export async function POST(request: NextRequest) {
  const { origin } = request.nextUrl
  const supabase = await createClient()
  await supabase.auth.signOut()

  // 303: turn the form POST into a GET of /login, so the browser does not
  // re-POST to the login page.
  return NextResponse.redirect(`${origin}/login`, { status: 303 })
}
