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

// `$` here means end of input and nothing else. JavaScript is not Perl or
// Python: without the `m` flag `$` does NOT also match before a trailing line
// terminator, so `<uuid>%0A` — which arrives decoded as "<uuid>\n" — fails this
// test and is turned away as not-found rather than reaching Postgres. Checked
// against \n, \r and \r\n; stated because the claim below depends on it.
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

  // A database error and a token that matches nothing are NOT the same answer,
  // and collapsing both into notFound() made a Supabase outage indistinguishable
  // from a dead link: the client saw "invoice not found", assumed Dan had pulled
  // it, and nothing was logged for anyone to notice. Separate them.
  //
  // The error branch says only that something broke — never error.message, which
  // can carry schema detail, and never anything that would confirm the token
  // exists. The miss branch stays a 404 for exactly that reason: a stranger
  // guessing tokens must not be able to tell a real one from a fake one.
  if (error) {
    console.error('[public-invoice] public_invoice() failed', {
      code: error.code, message: error.message,
    })
    return (
      <main className="min-h-screen bg-bg px-4 py-10">
        <div className="mx-auto max-w-3xl text-center">
          <p role="alert" className="text-danger">
            This invoice couldn&rsquo;t be loaded right now.
          </p>
          <p className="mt-3 text-xs text-muted">
            It&rsquo;s a problem on our side, not a broken link. Please try again in a
            few minutes, or reply to the email this link came with.
          </p>
        </div>
      </main>
    )
  }
  if (!data) notFound()

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
        <div className="mt-6 text-center">
          <a
            href={`/i/${token}/pdf`}
            className="inline-block px-5 py-2.5 bg-accent-surface text-accent-ink font-bold
                       uppercase tracking-wider text-sm rounded-field hover:opacity-90
                       transition-opacity"
          >
            Download PDF
          </a>
        </div>
        <p className="mt-6 text-center text-xs text-muted">
          Questions about this invoice? Reply to the email it came with.
        </p>
      </div>
    </main>
  )
}
