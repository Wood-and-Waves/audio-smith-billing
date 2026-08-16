// Where a post-login redirect is allowed to send you.
//
// The `?next=` parameter on /login and /auth/callback is attacker-controllable:
// a phished /login?next=<somewhere> link renders the real password form, and on
// success sends the browser wherever `next` says. For an app whose whole
// security is one password, a redirect into a lookalike right after sign-in is a
// credential-phishing amplifier. So `next` may only ever be a path on this
// origin, never another site.
//
// The rejections that matter, all of which reach a foreign origin if let through:
//   //evil.com        -> a protocol-relative URL; the browser reads it as a host
//   /\evil.com        -> some parsers treat backslash as a slash
//   https://evil.com  -> absolute URL
//   @evil.com         -> becomes userinfo when concatenated after an origin,
//                        so `${origin}${next}` resolves to host evil.com
//   .evil.com         -> concatenated onto the origin host, an attacker subdomain
//
// A safe value is exactly: begins with a single '/', and the second character is
// not '/' or '\'. Everything else falls back to the app's home.

const HOME = '/invoices'

export function safeNext(next: string | null | undefined): string {
  if (!next) return HOME
  // Must start with '/', and the next char must not turn it into a host or a
  // path on another scheme. This also rejects '@...' and '.evil.com', which do
  // not start with '/' at all.
  if (next[0] !== '/') return HOME
  if (next[1] === '/' || next[1] === '\\') return HOME
  return next
}
