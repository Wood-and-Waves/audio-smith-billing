import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { displayStatus, daysUntilDue, todayInChicago } from '@/lib/status'
import InvoiceDocument, { type DocumentData } from '@/components/InvoiceDocument'

// The public copy of one invoice.
//
// PUBLIC — this answers without a session, so /i is allowlisted in proxy.ts.
// It reads through public_invoice() (migration 0006), a security-definer
// function that returns exactly the invoice matching an unguessable token, with
// only the seven settings columns the document needs. anon has no table
// privileges, so nothing else in the database is reachable from here.
//
// It renders the same InvoiceDocument as the app and the PDF, so a client
// looking at this page and a client looking at the attachment see one document.

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function PublicInvoicePage(
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  // Guard the shape before it reaches Postgres: a malformed uuid is an error
  // from the driver, not a null result, and a 500 would tell a prober that the
  // parameter is a uuid. A bad token is simply "not found".
  if (!UUID.test(token)) notFound()

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('public_invoice', { p_token: token })
  if (error || !data) notFound()

  const invoice = data as DocumentData & { status: 'draft' | 'sent' | 'paid' | 'void' }
  const today = todayInChicago()
  const shown = displayStatus(
    { status: invoice.status, due_date: invoice.due_date, total_cents: invoice.total_cents },
    today,
  )
  const days = daysUntilDue(invoice.due_date, today)

  return (
    <main className="min-h-screen bg-bg px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <p className="eyebrow mb-3 text-center">
          {shown === 'paid'
            ? 'Paid — thank you'
            : shown === 'overdue'
              ? `Overdue by ${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'}`
              : `Due in ${days} ${days === 1 ? 'day' : 'days'}`}
        </p>
        <InvoiceDocument data={invoice} />
        <p className="mt-6 text-center text-xs text-muted">
          Questions about this invoice? Reply to the email it came with.
        </p>
      </div>
    </main>
  )
}
