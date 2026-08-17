import { createClient } from '@/lib/supabase/server'
import { renderInvoicePdf } from '@/lib/renderInvoicePdf'
import { publicBackup } from '@/lib/publicInvoiceBackup'
import { invoiceFilename } from '@/lib/invoicePdf'
import type { DocumentData } from '@/components/InvoiceDocument'

// The public Download-PDF endpoint. Same capability model as /i/[token]: gated
// only by the unguessable token, no session, no service role, no storage
// access. It reads the document (public_invoice) and the frozen backup
// (public_invoice_backup), strips receipt images/paths via publicBackup, renders
// with the shared renderInvoicePdf, and streams the file. Node runtime: the
// render reads the font/logo off the filesystem.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A malformed uuid is a driver error, not a null row; guard the shape so a bad
// token is a 404, never a 500 that would confirm the parameter is a uuid.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  if (!UUID.test(token)) return new Response('Not found', { status: 404 })

  const supabase = await createClient()
  const [{ data: doc, error: docErr }, { data: backup, error: backErr }] = await Promise.all([
    supabase.rpc('public_invoice', { p_token: token }),
    supabase.rpc('public_invoice_backup', { p_token: token }),
  ])

  // A DB error and a token that matches nothing are different answers: 500 for a
  // real failure (generic body — never error.message, which can carry schema
  // detail), 404 for a miss (so a stranger cannot tell a real token from a fake
  // one).
  if (docErr || backErr) {
    console.error('[public-invoice-pdf] rpc failed', {
      docCode: docErr?.code, backCode: backErr?.code,
    })
    return new Response('This invoice could not be loaded right now.', { status: 500 })
  }
  if (!doc) return new Response('Not found', { status: 404 })

  const data: DocumentData = {
    ...(doc as DocumentData),
    backup: publicBackup(backup),
  }

  let pdf: Buffer
  try {
    pdf = await renderInvoicePdf(data)
  } catch (e) {
    console.error('[public-invoice-pdf] render failed', e)
    return new Response('This invoice could not be rendered right now.', { status: 500 })
  }

  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoiceFilename(data)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
