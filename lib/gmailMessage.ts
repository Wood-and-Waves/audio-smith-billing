// Gmail's message JSON, flattened into the four things a receipt needs.
//
// Kept separate from lib/gmail.ts (which does the network) because THIS is
// the fiddly part and the part worth pinning: Gmail returns a recursive
// payload tree whose shape depends on how the sending client built the mail.
// A plain-text receipt is one node; an Amazon receipt is multipart/alternative
// with text and html siblings; a forwarded receipt with a PDF is
// multipart/mixed wrapping that alternative plus an attachment. All three
// have to come out the same way.
//
// Pure: no network, no clock, no env. Everything here is decided by the JSON
// it is handed.

/** One part of a message, as the Gmail API returns it. */
export type GmailPart = {
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}

export type GmailApiMessage = {
  id: string
  threadId?: string
  internalDate?: string
  payload?: GmailPart
}

export type ParsedEmail = {
  id: string
  from: string
  subject: string
  /** Milliseconds since epoch, or null when Gmail omitted internalDate. */
  receivedAt: number | null
  /** Plain text if the mail carried any, else html stripped to text, else ''. */
  text: string
  attachments: { filename: string; mimeType: string; attachmentId: string; size: number }[]
}

/** Gmail encodes body data base64url — '-' and '_' for '+' and '/', no padding. */
export function decodeBody(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

/** A header by name, case-insensitively — senders capitalise inconsistently. */
export function headerValue(part: GmailPart | undefined, name: string): string {
  const wanted = name.toLowerCase()
  const found = part?.headers?.find((h) => h.name.toLowerCase() === wanted)
  return found?.value ?? ''
}

/**
 * HTML to something a language model can read.
 *
 * Not a parser and not trying to be: it drops script/style outright (their
 * CONTENT would otherwise become text and swamp a receipt's few real lines),
 * turns block-level ends into newlines so table rows do not run together into
 * one unreadable line, strips the remaining tags, and decodes the handful of
 * entities that actually appear in receipt mail. Whitespace is collapsed last
 * because marketing HTML is mostly indentation.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim()
}

/** Depth-first walk of the payload tree, parents before children. */
function walk(part: GmailPart | undefined, visit: (p: GmailPart) => void): void {
  if (!part) return
  visit(part)
  for (const child of part.parts ?? []) walk(child, visit)
}

/**
 * Flattens one Gmail message.
 *
 * Plain text WINS over html when a message carries both — that is the whole
 * point of multipart/alternative, and the text half is what the sender meant
 * a plain reader to see. Falling back to stripped html only when there is no
 * text part is what makes Amazon and Uber receipts (html-only, in practice)
 * readable at all.
 *
 * A part counts as an ATTACHMENT when it has a filename, regardless of mime
 * type: that is Gmail's own signal, and keying on mimeType instead would miss
 * a PDF sent as application/octet-stream, which happens.
 */
export function parseGmailMessage(msg: GmailApiMessage): ParsedEmail {
  const payload = msg.payload
  let text = ''
  let html = ''
  const attachments: ParsedEmail['attachments'] = []

  walk(payload, (p) => {
    const filename = p.filename ?? ''
    if (filename !== '' && p.body?.attachmentId) {
      attachments.push({
        filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        attachmentId: p.body.attachmentId,
        size: p.body.size ?? 0,
      })
      return
    }
    const data = p.body?.data
    if (!data) return
    // First of each kind wins: a forwarded mail can nest a second copy of the
    // same body further down, and the outermost is the one being forwarded.
    if (p.mimeType === 'text/plain' && text === '') text = decodeBody(data)
    else if (p.mimeType === 'text/html' && html === '') html = decodeBody(data)
  })

  const internal = msg.internalDate ? Number(msg.internalDate) : NaN

  return {
    id: msg.id,
    from: headerValue(payload, 'From'),
    subject: headerValue(payload, 'Subject'),
    receivedAt: Number.isFinite(internal) ? internal : null,
    text: text !== '' ? text.trim() : htmlToText(html),
    attachments,
  }
}
