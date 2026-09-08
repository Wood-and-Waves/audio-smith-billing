import 'server-only'
// An emailed receipt that has no attachment, turned into one.
//
// Butter's Burgers and United send the receipt AS the message body — there is
// no PDF to file, and without this the amount is read perfectly and then has
// nothing to attach to the bank row (Dan, 2026-09-07). Rendering the body
// gives every receipt a document, so a charge is never left looking
// unreceipted when the proof exists.
//
// SERVER ONLY, and deliberately font-free: it uses @react-pdf's built-in
// Helvetica rather than registering Oswald the way renderInvoicePdf does. That
// keeps this off the outputFileTracingIncludes list — nothing to trace, and no
// route can fail because a font file did not follow it into the bundle. This
// is a filing document, not a client-facing one; it needs to be legible and
// nothing more.

// NOT UNIT-TESTABLE HERE, and that is a property of the runner rather than a
// gap. `npm test` passes --conditions=react-server, which resolves React to
// the server-components build; @react-pdf's reconciler needs the full one and
// dies inside its own minified source with "Cannot read properties of
// undefined (reading 'S')" — a message that names nothing. The same tree
// renders a valid PDF under default conditions, and renderInvoicePdf has
// shipped on this exact footing for months. If this ever needs a test, run it
// in its own process without that flag.

/** Beyond this the mail is a newsletter, not a receipt. Keeps one PDF sane. */
const MAX_CHARS = 20_000

export async function renderReceiptBodyPdf(input: {
  subject: string
  from: string
  receivedAt: string | null
  text: string
}): Promise<Buffer> {
  const { createElement: h } = await import('react')
  const { Document, Page, Text, View, renderToBuffer } = await import('@react-pdf/renderer')

  const body = input.text.length > MAX_CHARS
    ? `${input.text.slice(0, MAX_CHARS)}\n\n[truncated]`
    : input.text

  // One Text per line. @react-pdf collapses whitespace inside a single Text,
  // so a receipt's columns would run together into a paragraph — the line
  // structure IS the receipt.
  const lines = body.split('\n')

  return renderToBuffer(
    h(Document, {},
      h(Page, { size: 'LETTER', style: { padding: 40, fontSize: 9, fontFamily: 'Helvetica' } },
        // borderBottomWidth + borderBottomColor, not the `borderBottom`
        // shorthand: react-pdf does not parse the shorthand and dies inside
        // its own style resolver with "Cannot read properties of undefined",
        // which names nothing useful. Children are filtered rather than left
        // null for the same reason — an undefined child is not worth debugging
        // through a minified reconciler.
        h(View, {
          style: {
            marginBottom: 14, paddingBottom: 8,
            borderBottomWidth: 1, borderBottomColor: '#999',
          },
        },
          ...[
            h(Text, { key: 'subj', style: { fontSize: 12, fontFamily: 'Helvetica-Bold' } },
              input.subject || 'Receipt'),
            h(Text, { key: 'from', style: { fontSize: 8, color: '#555555', marginTop: 3 } },
              input.from),
            input.receivedAt
              ? h(Text, { key: 'date', style: { fontSize: 8, color: '#555555' } }, input.receivedAt)
              : null,
          ].filter(Boolean),
        ),
        h(View, {},
          ...lines.map((line, i) =>
            // A blank line still needs height, or the spacing the receipt used
            // to separate its total from its items disappears.
            h(Text, { key: String(i), style: { lineHeight: 1.35 } }, line === '' ? ' ' : line)),
        ),
      ),
    ),
  )
}
