// Which attachment on a forwarded receipt is the one worth reading.
//
// Pure: no network, no clock. Called by the poller before it spends an API
// call, and by the inbox screen to decide what to show.

export type MailAttachment = {
  filename: string
  mimeType: string
  attachmentId: string
  size: number
}

/** PDFs and images. Anything else on a receipt email is a logo or a signature. */
export function isReadable(a: MailAttachment): boolean {
  const name = a.filename.toLowerCase()
  return a.mimeType === 'application/pdf'
    || a.mimeType.startsWith('image/')
    || name.endsWith('.pdf')
    || /\.(jpe?g|png|heic|webp)$/.test(name)
}

/**
 * Is this attachment a PDF?
 *
 * By mime type OR extension, for the same reason isReadable is: senders
 * mislabel PDFs as application/octet-stream, and a strict equality check on
 * the mime type silently skipped Netlify's invoice — the extractor reported
 * "nothing readable" about a message that plainly carried a PDF.
 */
export function isPdf(a: MailAttachment): boolean {
  return a.mimeType === 'application/pdf' || a.filename.toLowerCase().endsWith('.pdf')
}

/**
 * The attachment to read first, or null when none is readable.
 *
 * A RECEIPT beats an INVOICE. ElevenLabs sends both — `Invoice-….pdf` and
 * `Receipt-….pdf` — and for bookkeeping the receipt is the one that matters:
 * proof money left, not a request for it (Dan, 2026-09-07: "One is an invoice,
 * one is a receipt").
 *
 * This only ORDERS them. Nothing is discarded, because that naming is
 * Stripe's convention and not a standard — plenty of vendors send
 * `document.pdf`, and a wrong guess must cost a second look rather than a lost
 * document. The caller stores every attachment and uses this to pick which to
 * extract from and show.
 *
 * Ties keep the order the mail carried, which is the order the sender chose.
 */
export function pickPrimaryAttachment(attachments: readonly MailAttachment[]): MailAttachment | null {
  const readable = attachments.filter(isReadable)
  if (readable.length === 0) return null

  const rank = (a: MailAttachment): number => {
    const name = a.filename.toLowerCase()
    if (name.includes('receipt')) return 0
    if (name.includes('invoice')) return 2
    return 1 // unnamed: better than an invoice, worse than an explicit receipt
  }

  let best = readable[0]
  for (const a of readable.slice(1)) if (rank(a) < rank(best)) best = a
  return best
}

/**
 * The content type to STORE this attachment as.
 *
 * The receipts bucket accepts image/jpeg, image/png and application/pdf and
 * rejects everything else (0010, widened by 0011). Senders do not respect
 * that: Netlify labels its invoice PDF `application/octet-stream`, storage
 * refused the upload, and three receipts landed with no document at all while
 * the extraction that had already READ those PDFs looked like it worked.
 *
 * So the sender's label is corrected to what the bytes actually are, by the
 * same extension test the rest of this file trusts. Anything still unknown is
 * returned as-is and will be refused by the bucket — which is the right
 * outcome for a file we cannot identify.
 */
export function storageContentType(a: MailAttachment): string {
  if (isPdf(a)) return 'application/pdf'
  const name = a.filename.toLowerCase()
  if (a.mimeType === 'image/jpeg' || /\.jpe?g$/.test(name)) return 'image/jpeg'
  if (a.mimeType === 'image/png' || name.endsWith('.png')) return 'image/png'
  return a.mimeType
}
