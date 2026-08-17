// Turns the invoice email's To field — a comma-separated string Dan types —
// into validated addresses. Pure and dependency-free: the client panel uses
// it for live feedback and the server action uses it as the authoritative
// gate on who an invoice reaches, so both sides agree on exactly one parse.
//
// The pattern is deliberately loose: one "@", no whitespace on either side,
// and a dot-bearing domain. This is not RFC 5322 — it is the check that
// catches the mistakes a human actually makes (a name with no address, a
// missing domain) without rejecting valid addresses it doesn't understand.
// The real delivery verdict comes from Resend; this only stops the obvious.
//
// No '@/' imports and no server-only anything — it is exercised by
// node --test and imported into the browser bundle.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseRecipients(raw: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>()
  const emails: string[] = []
  const invalid: string[] = []
  for (const part of raw.split(',')) {
    const addr = part.trim()
    if (!addr) continue
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (EMAIL_RE.test(addr)) emails.push(addr)
    else invalid.push(addr)
  }
  return { emails, invalid }
}
