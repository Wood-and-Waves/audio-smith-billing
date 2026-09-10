import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'
import MoneyNav from '@/components/MoneyNav'
import ReceiptInbox, { type InboxItem } from '@/components/ReceiptInbox'
import { proposeReceiptMatches, type ReceiptCandidateTxn } from '@/lib/receiptMatch'

export const dynamic = 'force-dynamic'

/**
 * How far back to read bank rows for matching.
 *
 * Bounded because this page does not need the whole ledger: a receipt can only
 * pair with a charge within RECEIPT_MATCH_DAYS of it, and nothing older than
 * the oldest waiting receipt can ever be proposed. 180 days is generous cover
 * for a receipt Dan labels long after the fact.
 */
const CANDIDATE_DAYS = 180

/**
 * How long a document link stays good.
 *
 * The links are signed HERE, on the server, and rendered as ordinary anchors.
 * They used to be buttons that signed on click and then called window.open —
 * which never worked, because the open happens after an await and is no longer
 * inside the user's gesture, so every browser blocks it as a popup. Silently:
 * no error, no tab, nothing.
 *
 * An hour is long enough for any session on this page; the page is
 * force-dynamic, so a refresh signs fresh ones.
 */
const LINK_TTL_SECONDS = 3600

export default async function ReceiptInboxPage() {
  const supabase = await createClient()

  const since = new Date(Date.now() - CANDIDATE_DAYS * 86_400_000).toISOString().slice(0, 10)

  const [inboxRes, txnRes] = await Promise.all([
    supabase
      .from('receipt_inbox')
      .select('id, from_email, subject, received_at, vendor, amount_cents, spent_on, attachments, primary_path')
      .eq('status', 'new')
      .order('received_at', { ascending: false, nullsFirst: false }),
    supabase
      .from('ledger_transactions')
      .select('id, date, amount_cents, payee, receipt_path')
      .lt('amount_cents', 0)
      .gte('date', since)
      .order('date', { ascending: false }),
  ])

  if (inboxRes.error) {
    return (
      <AppShell current="money" wide>
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          Couldn&rsquo;t load the receipt inbox: {inboxRes.error.message}
        </p>
      </AppShell>
    )
  }

  const txns = (txnRes.data ?? []) as unknown as ReceiptCandidateTxn[]

  // Matching happens here, not in the browser: the candidate rows are money
  // Every document, signed once, in one round trip rather than one per file.
  const rawRows = (inboxRes.data ?? []) as unknown as { attachments: { path: string }[] }[]
  const paths = [...new Set(rawRows.flatMap((r) => (r.attachments ?? []).map((a) => a.path)))]
  const signed = new Map<string, string>()
  if (paths.length > 0) {
    const { data: urls } = await supabase.storage
      .from('receipts').createSignedUrls(paths, LINK_TTL_SECONDS)
    for (const u of urls ?? []) {
      if (u.signedUrl && u.path) signed.set(u.path, u.signedUrl)
    }
  }

  // data and there is no reason to ship several hundred of them to the client
  // when only the handful that match need to be seen.
  const items: InboxItem[] = ((inboxRes.data ?? []) as unknown as {
    id: string; from_email: string; subject: string; received_at: string | null
    vendor: string | null; amount_cents: number | null; spent_on: string | null
    attachments: { filename: string; mimeType: string; path: string; size: number }[]
    primary_path: string | null
  }[]).map((r) => ({
    id: r.id,
    subject: r.subject,
    fromEmail: r.from_email,
    receivedAt: r.received_at,
    vendor: r.vendor,
    amountCents: r.amount_cents,
    spentOn: r.spent_on,
    // A url of null means the file is gone from storage. Rendering the name
    // as dead text says so; a link that goes nowhere does not.
    attachments: (r.attachments ?? []).map((a) => ({ ...a, url: signed.get(a.path) ?? null })),
    primaryPath: r.primary_path,
    matches:
      r.amount_cents !== null && r.spent_on !== null
        ? proposeReceiptMatches({ amountCents: r.amount_cents, spentOn: r.spent_on }, txns).slice(0, 5)
        : [],
  }))

  return (
    <AppShell current="money" wide>
      <MoneyNav current="receipts" />
      <h1 className="display text-3xl font-bold mb-6">Receipts</h1>
      <ReceiptInbox items={items} />
    </AppShell>
  )
}
