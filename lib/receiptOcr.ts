import 'server-only'
// Sending a receipt photo to Claude and reading back the extraction.
//
// SERVER ONLY — readReceiptImage reads ANTHROPIC_API_KEY. Never import this
// from a client component.
//
// The Anthropic client is constructed PER CALL, never at module scope: a
// top-level `new Anthropic(...)` throws during `next build` wherever the key
// is absent, which broke every CrewTracker preview deployment until
// 2026-07-27. Environment variables are read at call time for the same
// reason.
//
// This function returns { error } rather than throwing, so a failed read
// never destroys the record of what was being uploaded. The try block wraps
// base64 encoding, the SDK import, the call AND the parse — not just the
// network line — because this function's whole contract is to return
// { error } and never throw, and any of those steps can throw.
//
// No JSX and no '@/' imports — this module is exercised by node --test.

import { readExtraction, RECEIPT_PROMPT, RECEIPT_SCHEMA, type ReceiptFields } from './receiptExtraction.ts'

const MODEL = 'claude-sonnet-5'

const EMPTY_FIELDS: ReceiptFields = { vendor: null, amountCents: null, spentOn: null, category: null }

export async function readReceiptImage(input: {
  bytes: Uint8Array; mediaType: 'image/jpeg'; today: string
}): Promise<{ error: string } | { fields: ReceiptFields; unreadable: boolean }> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return { error: 'Reading receipts is not configured yet (ANTHROPIC_API_KEY is missing).' }

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: key, timeout: 25_000, maxRetries: 1 })

    const base64 = Buffer.from(input.bytes).toString('base64')

    // messages.parse, not messages.create: the SDK deserialises the structured
    // output into parsed_output, so there is no hand-written JSON.parse of
    // content[0].text and no chance of reading a text block that isn't there.
    const message = await client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: RECEIPT_PROMPT,
      output_config: { effort: 'low', format: RECEIPT_SCHEMA },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: input.mediaType, data: base64 } },
          { type: 'text', text: 'Extract the fields from this receipt.' },
        ],
      }],
    })

    // A refusal or a token cap comes back as HTTP 200 with unusable content.
    if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') {
      return { fields: EMPTY_FIELDS, unreadable: true }
    }

    return readExtraction(message.parsed_output, { today: input.today })
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'That receipt could not be read.' }
  }
}
