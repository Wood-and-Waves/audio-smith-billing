import 'server-only'
import { buildInvoicePdf } from '@/lib/invoicePdf'
import type { DocumentData } from '@/components/InvoiceDocument'

// The one place an invoice PDF is rendered — shared by the email send
// (lib/invoiceEmail via app/invoices/actions.ts) and the public download route
// (app/i/[token]/pdf), so the attachment and the link can never render
// differently for the same invoice.
//
// SERVER ONLY: it reads the Oswald font and the logo off the serverless
// filesystem. Absolute paths from process.cwd(), never relative — the working
// directory is not something to depend on, and next.config must trace these
// files into every route bundle that calls this (see outputFileTracingIncludes).
//
// It THROWS on failure rather than swallowing: each caller has its own
// contract for a render error (the action returns { error }; the route returns
// a 500), so the catch lives at the call site, not here.
export async function renderInvoicePdf(data: DocumentData): Promise<Buffer> {
  const { join } = await import('node:path')
  const { Document, Page, Text, View, Image, Font, renderToBuffer } =
    await import('@react-pdf/renderer')
  Font.register({
    family: 'Oswald',
    src: join(process.cwd(), 'public', 'fonts', 'Oswald-Bold.ttf'),
    fontWeight: 700,
  })
  return renderToBuffer(
    buildInvoicePdf(
      { Document, Page, Text, View, Image },
      data,
      { logoSrc: join(process.cwd(), 'public', 'logo.png') },
    ),
  )
}
