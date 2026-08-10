// Turn a Supabase auth error into something a person can act on.
//
// Plain module (no 'use client') so client components can import it freely.
//
// WHY
// ---
// Supabase's client does not always populate `message`. A server-side failure —
// SMTP misconfigured, for instance — arrives as an AuthError whose message is
// empty or serialises to "{}", and printing it verbatim puts a red `{}` on the
// screen with no indication of what went wrong.
//
// This happened for real on 2026-07-28, on the login page's "Forgot password?".
// The API was returning a perfectly clear
//     {"code":500,"error_code":"unexpected_failure","msg":"Error sending recovery email"}
// and none of it reached the user, because the SDK maps `msg` to nothing useful
// for that shape. Diagnosing it needed a raw HTTP call from a terminal, which is
// not a thing a customer can do.
//
// So: keep a real message when there is one, and otherwise say something honest
// while logging the whole object for the console.

export function readableAuthError(e: unknown): string {
  const raw = (e as { message?: string } | null)?.message
  const useless =
    !raw || raw.trim() === '' || raw.trim() === '{}' || raw.trim() === '[object Object]'

  if (!useless) return raw

  // The detail is still worth having; it just doesn't belong on screen.
  console.error('Auth error with no usable message:', e)
  return 'Something went wrong on our side. Please try again, or contact support if it keeps happening.'
}
