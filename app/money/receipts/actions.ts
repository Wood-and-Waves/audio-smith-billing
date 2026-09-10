'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import {
  gmailCredsFromEnv, getAccessToken, findLabelId, listLabelledMessageIds,
  getMessage, getAttachment,
} from '@/lib/gmail'
import { parseGmailMessage } from '@/lib/gmailMessage'
import { pickPrimaryAttachment, isPdf, isReadable, storageContentType } from '@/lib/receiptAttachment'
import { readReceiptFromEmail } from '@/lib/receiptFromEmail'
import { renderReceiptBodyPdf } from '@/lib/renderReceiptBodyPdf'
import { todayInChicago } from '@/lib/dates'

type Fail = { error: string }

/**
 * The Gmail label Dan files receipts into.
 *
 * A constant rather than a setting: there is one of him, he named it once, and
 * a settings row for a string he will never change again is machinery without
 * a purpose. It becomes a column the day a second user exists — see the
 * sharing plan in docs/BACKLOG.md.
 */
const RECEIPT_LABEL = 'audiosmith_receipts'

/** Newest first, and bounded — this walks the whole label on every run. */
const MAX_MESSAGES = 50

/**
 * Pulls newly labelled receipts into the inbox.
 *
 * Re-reads the WHOLE label every run rather than tracking a cursor: the label
 * is something Dan edits by hand and can add an old receipt to at any time, so
 * a cursor would step straight past it. `receipt_inbox`'s unique
 * (owner_id, gmail_message_id) is what makes the second pass a no-op, and the
 * already-seen set below is what stops it costing an extraction each time.
 *
 * Partial failure is normal and survivable: one unreadable message must not
 * cost the other nine. Anything that fails is counted and skipped, and the
 * next run tries it again — it was never recorded, so it is still "new".
 */
export async function syncReceiptInbox(): Promise<
  Fail | { ok: true; added: number; skipped: number; failed: number }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const creds = gmailCredsFromEnv()
  if ('error' in creds) return { error: creds.error }
  const token = await getAccessToken(creds.creds)
  if ('error' in token) return { error: token.error }

  const labelId = await findLabelId(token.token, RECEIPT_LABEL)
  if (!labelId) return { error: `No Gmail label named "${RECEIPT_LABEL}".` }

  const listed = await listLabelledMessageIds(token.token, labelId, MAX_MESSAGES)
  if ('error' in listed) return { error: listed.error }
  if (listed.ids.length === 0) return { ok: true, added: 0, skipped: 0, failed: 0 }

  // Which of these we already hold. Scoped by .in() to the ids in hand rather
  // than reading the whole table — the same fetch-then-filter idiom the rest
  // of /money uses.
  const { data: seenRows, error: seenError } = await supabase
    .from('receipt_inbox')
    .select('gmail_message_id')
    .in('gmail_message_id', listed.ids)
  if (seenError) return { error: seenError.message }
  const seen = new Set((seenRows ?? []).map((r) => r.gmail_message_id as string))

  const today = todayInChicago()
  let added = 0
  let failed = 0

  for (const id of listed.ids) {
    if (seen.has(id)) continue
    try {
      const raw = await getMessage(token.token, id)
      if (raw && typeof raw === 'object' && 'error' in raw) { failed += 1; continue }
      const mail = parseGmailMessage(raw as Parameters<typeof parseGmailMessage>[0])

      // Every readable attachment is stored, not just the one worth reading:
      // ElevenLabs sends an invoice AND a receipt, and the naming that tells
      // them apart is Stripe's convention rather than a standard.
      const keep = mail.attachments.filter(isReadable)
      const primary = pickPrimaryAttachment(mail.attachments)
      const stored: { filename: string; mimeType: string; path: string; size: number }[] = []
      let primaryPath: string | null = null

      for (const a of keep) {
        const got = await getAttachment(token.token, id, a.attachmentId)
        if ('error' in got) continue
        // {owner}/inbox/ — the receipts bucket scopes on the first segment, so
        // this inherits owner-only access with no new policy.
        const safe = a.filename.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)
        const path = `${user.id}/inbox/${id}-${safe}`
        // The sender's label is corrected to what the bytes are: the bucket
        // accepts only jpeg/png/pdf, and Netlify's `application/octet-stream`
        // PDF was refused outright — three receipts stored no document while
        // extraction, which had already read those same PDFs, looked fine.
        const { error: upErr } = await supabase.storage
          .from('receipts')
          .upload(path, got.bytes, { contentType: storageContentType(a), upsert: true })
        if (upErr) continue
        stored.push({ filename: a.filename, mimeType: a.mimeType, path, size: a.size })
        if (primary && a.attachmentId === primary.attachmentId) primaryPath = path
      }

      // No attachment at all: the receipt IS the body, so render it to a PDF
      // and file that. Without this the amount reads perfectly and then has
      // nothing to attach, leaving a charge that looks unreceipted while the
      // proof sits in Gmail (Butter's Burgers and United both arrive this
      // way). Failing to render is not fatal — the item still lands with its
      // extracted fields, just with no document.
      if (keep.length === 0 && mail.text.trim() !== '') {
        try {
          const pdf = await renderReceiptBodyPdf({
            subject: mail.subject, from: mail.from,
            receivedAt: mail.receivedAt ? new Date(mail.receivedAt).toISOString().slice(0, 10) : null,
            text: mail.text,
          })
          const path = `${user.id}/inbox/${id}-email.pdf`
          const { error: upErr } = await supabase.storage
            .from('receipts')
            .upload(path, pdf, { contentType: 'application/pdf', upsert: true })
          if (!upErr) {
            stored.push({ filename: 'email.pdf', mimeType: 'application/pdf', path, size: pdf.byteLength })
            primaryPath = path
          }
        } catch { /* the item is still worth having without a document */ }
      }

      // A message whose attachments ALL failed to store is a failure, not an
      // item. Recording it would be worse than dropping it: the dedupe key
      // would mark it seen forever, and it would sit in the inbox with an
      // amount, no document, and no way to retry — which is exactly what
      // happened to three Netlify receipts when storage refused their
      // mislabelled PDFs. Left unrecorded, the next run picks it up again,
      // the same way any other failure here is retried.
      if (keep.length > 0 && stored.length === 0) { failed += 1; continue }

      const pdfBytes = primary && isPdf(primary)
        ? await getAttachment(token.token, id, primary.attachmentId)
        : null
      const read = await readReceiptFromEmail({
        text: mail.text,
        pdfBytes: pdfBytes && !('error' in pdfBytes) ? pdfBytes.bytes : null,
        today,
      })
      const fields = 'error' in read ? null : read.fields

      const { error: insErr } = await supabase.from('receipt_inbox').insert({
        owner_id: user.id,
        gmail_message_id: id,
        from_email: mail.from.slice(0, 300),
        subject: mail.subject.slice(0, 300),
        received_at: mail.receivedAt ? new Date(mail.receivedAt).toISOString() : null,
        vendor: fields?.vendor ?? null,
        amount_cents: fields?.amountCents ?? null,
        spent_on: fields?.spentOn ?? null,
        attachments: stored,
        primary_path: primaryPath,
      })
      // 23505 is the unique constraint: a concurrent run got there first, which
      // is exactly what that constraint is for. Not a failure.
      if (insErr && insErr.code !== '23505') { failed += 1; continue }
      if (!insErr) added += 1
    } catch {
      failed += 1
    }
  }

  revalidatePath('/money/receipts')
  return { ok: true, added, skipped: seen.size, failed }
}

/**
 * Files an inbox item onto the bank row it belongs to.
 *
 * Writes `receipt_original` always and `receipt_path` only for an IMAGE.
 * receipt_path is the flattened picture the register renders inline, and most
 * forwarded receipts are PDFs — the camera path rasterises those in the
 * browser with pdf.js, which is not available here and cannot be replaced
 * server-side without a system dependency. Dan's call (2026-09-07): keep the
 * true document and lose the inline thumbnail. A PDF-backed row shows that it
 * has a receipt and opens the real file.
 */
export async function fileReceiptToTransaction(
  inboxId: string, txnId: string,
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: item, error: itemErr } = await supabase
    .from('receipt_inbox')
    .select('id, status, primary_path')
    .eq('id', inboxId).eq('owner_id', user.id).maybeSingle()
  if (itemErr) return { error: itemErr.message }
  if (!item) return { error: 'That receipt is no longer in the inbox.' }
  if (item.status !== 'new') return { error: 'That receipt has already been filed.' }
  const path = (item.primary_path as string | null)?.trim() || null
  if (!path) return { error: 'That receipt has no document to attach.' }

  // Owner prefix checked here, not left to RLS alone — the same doctrine
  // attachLedgerReceipt states for its own writes.
  if (!path.startsWith(`${user.id}/`)) return { error: 'That receipt was not uploaded by you.' }

  const { data: txn, error: txnErr } = await supabase
    .from('ledger_transactions')
    .select('id, receipt_path, receipt_original')
    .eq('id', txnId).eq('owner_id', user.id).maybeSingle()
  if (txnErr) return { error: txnErr.message }
  if (!txn) return { error: 'That transaction no longer exists.' }
  if (txn.receipt_path || txn.receipt_original) {
    return { error: 'That transaction already has a receipt.' }
  }

  const isImage = /\.(jpe?g|png|webp)$/i.test(path)
  const { error: updErr } = await supabase
    .from('ledger_transactions')
    .update({ receipt_original: path, receipt_path: isImage ? path : null })
    .eq('id', txnId)
  if (updErr) return { error: updErr.message }

  // The transaction points at the file BEFORE the inbox row is closed, so a
  // failure here leaves an item Dan can file again rather than a receipt
  // nothing references.
  const { error: markErr } = await supabase
    .from('receipt_inbox')
    .update({ status: 'filed', filed_transaction_id: txnId })
    .eq('id', inboxId)
  if (markErr) return { error: markErr.message }

  revalidatePath('/money/receipts')
  revalidatePath('/money')
  return { ok: true }
}

/** Sets an item aside without filing it. The message stays labelled in Gmail. */
export async function dismissReceipt(inboxId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { error } = await supabase
    .from('receipt_inbox')
    .update({ status: 'dismissed' })
    .eq('id', inboxId).eq('owner_id', user.id).eq('status', 'new')
  if (error) return { error: error.message }

  revalidatePath('/money/receipts')
  return { ok: true }
}

