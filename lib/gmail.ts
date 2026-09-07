import 'server-only'
// Gmail, over plain fetch.
//
// No SDK, for the same reason lib/dropbox.ts has none: this needs four
// endpoints and googleapis would be a large runtime dependency for the sake of
// them.
//
// The grant is READ-ONLY (gmail.readonly, see scripts/gmail-auth.mjs). Nothing
// here can label, archive or delete anything in Dan's mailbox — "already
// filed" is recorded in receipt_inbox instead, keyed on the message id.
//
// Credentials never appear in a log line. The only thing ever reported is
// whether a variable was PRESENT, by name.

export type GmailCreds = {
  clientId: string
  clientSecret: string
  refreshToken: string
}

/** Reads the three GMAIL_* vars, or names the ones that are missing. */
export function gmailCredsFromEnv(): { creds: GmailCreds } | { error: string } {
  const clientId = process.env.GMAIL_CLIENT_ID ?? ''
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN ?? ''
  const missing = [
    ['GMAIL_CLIENT_ID', clientId],
    ['GMAIL_CLIENT_SECRET', clientSecret],
    ['GMAIL_REFRESH_TOKEN', refreshToken],
  ].filter(([, v]) => v === '').map(([n]) => n)
  if (missing.length > 0) {
    return { error: `Gmail is not configured yet (missing ${missing.join(', ')}).` }
  }
  return { creds: { clientId, clientSecret, refreshToken } }
}

/**
 * A short-lived access token from the long-lived refresh token.
 *
 * Google's access tokens last about an hour, far shorter than the gap between
 * nightly runs, so every run starts by exchanging — same shape as Dropbox's.
 *
 * The refresh token itself does not expire, because the OAuth app's audience
 * is INTERNAL. An External/Testing app's would die after seven days; that is
 * recorded here as well as in the auth script because it is the failure that
 * would look like a bug months from now.
 */
export async function getAccessToken(creds: GmailCreds): Promise<{ token: string } | { error: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  // Never surface the body: on the success path it carries a token.
  if (!res.ok) return { error: `Gmail auth failed (HTTP ${res.status}).` }
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) return { error: 'Gmail auth returned no access token.' }
  return { token: json.access_token }
}

/** The user-created label with this exact name, or null if there is none. */
export async function findLabelId(token: string, name: string): Promise<string | null> {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const json = (await res.json()) as { labels?: { id: string; name: string; type?: string }[] }
  return json.labels?.find((l) => l.name === name)?.id ?? null
}

/**
 * Message ids carrying a label, newest first.
 *
 * Deliberately re-reads the WHOLE label every run rather than tracking a
 * cursor. Gmail's history API needs a starting point that expires, and a
 * label is something Dan edits by hand — he can add an old receipt at any
 * time, and a cursor would step straight past it. Re-reading is cheap at this
 * volume, and `receipt_inbox`'s unique (owner_id, gmail_message_id) is what
 * makes the second pass a no-op.
 */
export async function listLabelledMessageIds(
  token: string, labelId: string, max = 50,
): Promise<{ ids: string[] } | { error: string }> {
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'
    + `?labelIds=${encodeURIComponent(labelId)}&maxResults=${max}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return { error: `Gmail list failed (HTTP ${res.status}).` }
  const json = (await res.json()) as { messages?: { id: string }[] }
  return { ids: (json.messages ?? []).map((m) => m.id) }
}

/** One message, full payload — the shape lib/gmailMessage.ts parses. */
export async function getMessage(token: string, id: string): Promise<unknown | { error: string }> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) return { error: `Gmail fetch failed for ${id} (HTTP ${res.status}).` }
  return res.json()
}

/**
 * One attachment's bytes.
 *
 * Gmail returns attachment data base64url-encoded in JSON rather than as a
 * binary body, so this decodes rather than streaming. Fine at receipt sizes —
 * the largest real one so far is an 83KB PDF.
 */
export async function getAttachment(
  token: string, messageId: string, attachmentId: string,
): Promise<{ bytes: Buffer } | { error: string }> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/`
    + `${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return { error: `Gmail attachment fetch failed (HTTP ${res.status}).` }
  const json = (await res.json()) as { data?: string }
  if (!json.data) return { error: 'Gmail returned an attachment with no data.' }
  return { bytes: Buffer.from(json.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64') }
}
