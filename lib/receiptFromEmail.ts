import 'server-only'
// Reading a FORWARDED receipt — the email's text, or a PDF it carried.
//
// Shares RECEIPT_PROMPT, RECEIPT_SCHEMA and readExtraction with the camera
// path (lib/receiptOcr.ts) on purpose: a receipt must not produce different
// data depending on whether Dan photographed it or forwarded it. Only the
// content block differs — text or a PDF document instead of a JPEG.
//
// The prompt is reused VERBATIM, including its "photograph of a receipt"
// framing. Rewording it would change behaviour for the camera path too, which
// works and has no evals behind it; the schema and the field rules are what
// actually direct the extraction, and they are input-agnostic.

import {
  readExtraction, RECEIPT_PROMPT, RECEIPT_SCHEMA, type ReceiptFields,
} from './receiptExtraction.ts'

const MODEL = 'claude-sonnet-5'
const EMPTY: ReceiptFields = { vendor: null, amountCents: null, spentOn: null, category: null }

export type EmailReadResult =
  | { error: string }
  | { fields: ReceiptFields; unreadable: boolean; source: 'text' | 'pdf' | 'none' }

async function extract(
  content: Array<Record<string, unknown>>, today: string,
): Promise<{ error: string } | { fields: ReceiptFields; unreadable: boolean }> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return { error: 'Reading receipts is not configured yet (ANTHROPIC_API_KEY is missing).' }
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: key, timeout: 25_000, maxRetries: 1 })
    const message = await client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: RECEIPT_PROMPT,
      output_config: { effort: 'low', format: RECEIPT_SCHEMA },
      messages: [{ role: 'user', content: content as never }],
    })
    if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') {
      return { fields: EMPTY, unreadable: true }
    }
    return readExtraction(message.parsed_output, { today })
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'That receipt could not be read.' }
  }
}

/**
 * Reads a forwarded receipt: BODY FIRST, then the PDF.
 *
 * That order comes from Dan's own mail rather than from theory. An earlier
 * plan assumed body-receipts and attachment-receipts were two kinds of message
 * wanting two paths. They are not: his ElevenLabs receipt carries $5.00 in the
 * body AND two PDFs, while his Google Workspace invoice carries no figure at
 * all in the body — every number lives inside the attachment. Choosing a path
 * from the message's shape would read the wrong half of one of them.
 *
 * So the body is tried when there is one, and the PDF is read only when the
 * body yields no AMOUNT. The amount is the test because it is the field that
 * makes a receipt worth filing; a vendor name alone (which the Google mail has)
 * is not enough to book anything.
 *
 * Text is also much cheaper than a document, so the common case costs less —
 * but that is a consequence of the ordering, not the reason for it.
 */
export async function readReceiptFromEmail(input: {
  text: string
  /** The primary attachment's bytes, when it is a PDF. */
  pdfBytes?: Uint8Array | null
  today: string
}): Promise<EmailReadResult> {
  const text = input.text.trim()

  if (text !== '') {
    const fromText = await extract([
      { type: 'text', text: `Extract the fields from this receipt email.\n\n${text}` },
    ], input.today)
    if ('error' in fromText) return fromText
    // An amount is the bar. Anything less and the PDF is worth the call.
    if (fromText.fields.amountCents !== null) return { ...fromText, source: 'text' }
  }

  if (input.pdfBytes && input.pdfBytes.byteLength > 0) {
    // The PDF goes to the model AS a PDF — not rasterised first, the way the
    // camera path must do it. That keeps the real text instead of a picture of
    // it, and reads every page rather than only the first, which matters for a
    // billing PDF whose first page is a cover.
    const base64 = Buffer.from(input.pdfBytes).toString('base64')
    const fromPdf = await extract([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      },
      { type: 'text', text: 'Extract the fields from this receipt.' },
    ], input.today)
    if ('error' in fromPdf) return fromPdf
    return { ...fromPdf, source: 'pdf' }
  }

  return { fields: EMPTY, unreadable: true, source: 'none' }
}
