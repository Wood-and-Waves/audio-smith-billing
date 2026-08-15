import { NextResponse, type NextRequest } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { todayInChicago } from '@/lib/dates'
import { sweep, isDigestDay, type ReminderInvoice } from '@/lib/reminders'
import {
  buildDigestEmail, buildOverdueAlertEmail, sendReminderEmail,
} from '@/lib/reminderEmail'
import { archiveNames, sanitizeSegment } from '@/lib/receiptArchiveName'
import { getAccessToken, uploadAndVerify } from '@/lib/dropbox'

// The reminder sweep, called by Vercel Cron once a morning.
//
// THIS IS THE ONLY FILE PERMITTED TO READ SUPABASE_SERVICE_ROLE_KEY, and the
// only one permitted to read DROPBOX_APP_KEY, DROPBOX_APP_SECRET and
// DROPBOX_REFRESH_TOKEN. The service key bypasses every RLS policy in the
// database; the Dropbox refresh token is a standing grant on Dan's account.
// They are here because the sweep has no user session and must read across all
// invoices; it is acceptable here because this route refuses anything without
// CRON_SECRET. Never move these reads into a page, a component, or a server
// action — and no NEXT_PUBLIC_ prefix, which would ship the value to the
// browser.
//
// The route runs EVERY DAY even though the digest is weekly. Supabase pauses a
// free project after 7 days of inactivity, and a weekly cron has no margin —
// the query below is the keepalive.
//
// /api/cron is allowlisted in proxy.ts. Without that it would 307 to /login and
// the cron would look like it was working while doing nothing.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // Bare 404, never 401: a prober learns nothing about whether this exists.
  const secret = process.env.CRON_SECRET
  if (!secret) return new NextResponse(null, { status: 404 })
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 404 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appUrl = process.env.APP_URL

  // The condition stays a direct check of the three so TypeScript still
  // narrows them to string below. Naming which one is absent matters: this is
  // past the secret gate, so the only reader already holds CRON_SECRET, and a
  // bare "not configured" turns setup into guesswork across three variables.
  // Names only — values are never echoed.
  if (!url || !serviceKey || !appUrl) {
    const missing = [
      !url && 'NEXT_PUBLIC_SUPABASE_URL',
      !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY',
      !appUrl && 'APP_URL',
    ].filter(Boolean) as string[]

    return NextResponse.json(
      {
        error: `Reminders are not configured. Missing in this deployment: ${missing.join(', ')}.`,
        hint: 'Add them in Vercel for Production, then REDEPLOY — a variable binds to a deployment when that deployment is created.',
        missing,
      },
      { status: 500 },
    )
  }

  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // settings.owner_id scopes the query below. This route bypasses RLS to read
  // across all invoices, and with a second auth user that would mail their
  // client names and amounts into Dan's digest — one owner today, but nothing
  // stops a second, so the filter has to be here regardless.
  const { data: settings } = await db
    .from('settings').select('email, owner_id').eq('id', 1).maybeSingle()
  const to = settings?.email
  if (!to) return NextResponse.json({ error: 'No settings email to send to.' }, { status: 500 })
  if (!settings?.owner_id) {
    return NextResponse.json({ error: 'No settings owner_id to scope invoices to.' }, { status: 500 })
  }

  // This query is the keepalive. It runs whatever today is.
  const { data: rows, error } = await db
    .from('invoices')
    .select(`id, number, due_date, total_cents, status, owner_id,
             clients(name),
             reminder_log(kind)`)
    .eq('status', 'sent')
    .eq('owner_id', settings.owner_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const invoices: ReminderInvoice[] = (rows ?? []).map((r) => {
    const row = r as unknown as {
      id: string; number: number; due_date: string; total_cents: number
      status: 'draft' | 'sent' | 'paid' | 'void'; owner_id: string
      clients: { name: string } | null
      reminder_log: { kind: string }[] | null
    }
    return {
      id: row.id,
      number: row.number,
      due_date: row.due_date,
      total_cents: Number(row.total_cents),
      status: row.status,
      client_name: row.clients?.name ?? 'Unknown client',
      alerted_overdue: (row.reminder_log ?? []).some((l) => l.kind === 'overdue_alert'),
    }
  })

  const ownerById = new Map((rows ?? []).map((r) => {
    const row = r as unknown as { id: string; owner_id: string }
    return [row.id, row.owner_id]
  }))

  const today = todayInChicago()
  const s = sweep(invoices, today)

  const sent: string[] = []
  const failed: string[] = []

  if (isDigestDay(today)) {
    const { subject, text, html } = buildDigestEmail(s, appUrl)
    const r = await sendReminderEmail({ to, subject, text, html })
    if (r.error) failed.push(`digest: ${r.error}`)
    else sent.push('digest')
  }

  for (const inv of s.newlyOverdue) {
    const { subject, text, html } = buildOverdueAlertEmail(inv, appUrl)
    const r = await sendReminderEmail({ to, subject, text, html })
    if (r.error) { failed.push(`#${inv.number}: ${r.error}`); continue }

    // Only after the send succeeds. Recording first would silence a future
    // alert for a message that never went — the same ordering rule the
    // invoice send follows.
    const { error: logErr } = await db.from('reminder_log').insert({
      owner_id: ownerById.get(inv.id),
      invoice_id: inv.id,
      kind: 'overdue_alert',
      sent_to: to,
    })
    if (logErr) failed.push(`#${inv.number} logged: ${logErr.message}`)
    else sent.push(`overdue #${inv.number}`)
  }

  // Last, and deliberately so: the reminders are the job people notice, and
  // this stage is allowed to take its time or fail without disturbing them.
  const archive = await archiveOriginals(db)

  // A non-empty `failed` must not come back as 200: Vercel's cron dashboard
  // reads the status code, not this body, to decide whether a run succeeded.
  // A 200 here — even with failures listed inside — buries a failed send or a
  // failed log insert (which, pre-migration-0009, used to mean the same alert
  // firing again every morning) somewhere nobody is looking.
  //
  // `archive.failed` is deliberately NOT part of that condition. A receipt that
  // could not be copied tonight is copied tomorrow — its row still has
  // receipt_archived_at null, so nothing can delete it in the meantime — and
  // turning that into a red cron run would train Dan to ignore the one signal
  // that means a reminder never reached a client.
  return NextResponse.json({
    today,
    digestDay: isDigestDay(today),
    dueSoon: s.dueSoon.length,
    overdue: s.overdue.length,
    newlyOverdue: s.newlyOverdue.length,
    outstandingCents: s.totalOutstandingCents,
    sent,
    failed,
    archive,
  }, { status: failed.length > 0 ? 500 : 200 })
}

/** Bounded per run: Vercel's Hobby plan caps a function at 60s, and each file is a download plus an upload. */
const ARCHIVE_BATCH = 8

/**
 * The columns the archive needs, and nothing else.
 *
 * Cast rather than inferred: this client is created without a generated
 * Database type, so the embedded `shows` / `show_days` shape is not something
 * TypeScript can know on its own.
 */
type ArchiveRow = {
  id: string
  spent_on: string
  where_spent: string | null
  amount_cents: number
  receipt_original: string
  shows: { name: string | null; dates: { date: string }[] | null } | null
}

/**
 * Copies originals to Dropbox, oldest first.
 *
 * Runs before the deletion stage and is entirely independent of it: this only
 * ever SETS receipt_archived_at. It never nulls it, never removes a file, and
 * never touches receipt_path. Every failure path leaves the column null, which
 * is what makes the later delete safe — an original with no verified copy is
 * never touched, it is simply retried tomorrow.
 *
 * Missing credentials skip the stage rather than failing the request. The cron
 * still has reminders to send, and a receipt archive is not worth losing those.
 */
async function archiveOriginals(db: SupabaseClient): Promise<{
  archived: number; failed: string[]; skipped?: string
}> {
  const appKey = process.env.DROPBOX_APP_KEY
  const appSecret = process.env.DROPBOX_APP_SECRET
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN

  // Names only, exactly as the block above does for its own three. A value here
  // would land in a JSON response and in Vercel's log retention — a refresh
  // token printed once is a refresh token that has to be rotated.
  if (!appKey || !appSecret || !refreshToken) {
    const missing = [
      !appKey && 'DROPBOX_APP_KEY',
      !appSecret && 'DROPBOX_APP_SECRET',
      !refreshToken && 'DROPBOX_REFRESH_TOKEN',
    ].filter(Boolean) as string[]
    return { archived: 0, failed: [], skipped: `Not configured: ${missing.join(', ')}.` }
  }

  // needsArchiving's rule, written as SQL so migration 0019's partial index on
  // (created_at) where receipt_original is not null and receipt_archived_at is
  // null can serve it — the alternative is dragging every expense ever recorded
  // across the wire each night to filter eight rows out of it.
  const { data, error } = await db
    .from('expenses')
    .select('id, spent_on, where_spent, amount_cents, receipt_original, shows(name, dates:show_days(date))')
    .not('receipt_original', 'is', null)
    .is('receipt_archived_at', null)
    .order('created_at', { ascending: true })
    .limit(ARCHIVE_BATCH)
  if (error) return { archived: 0, failed: [error.message] }

  const rows = (data ?? []) as unknown as ArchiveRow[]
  // Nothing waiting: return before exchanging the refresh token, so the steady
  // state costs one query a night rather than a needless round trip to Dropbox.
  if (rows.length === 0) return { archived: 0, failed: [] }

  let accessToken: string
  try {
    accessToken = await getAccessToken({ appKey, appSecret, refreshToken })
  } catch (e) {
    return { archived: 0, failed: [e instanceof Error ? e.message : 'Dropbox auth failed.'] }
  }

  // Named as a batch, not one at a time: two $6 coffees at the same airport
  // Starbucks on the same day produce the same stem, and only a batch-wide pass
  // can tell the second one to become "… (2)".
  const names = archiveNames(rows.map((r) => ({
    spentOn: r.spent_on,
    vendor: r.where_spent || null,
    // amount_cents is a bigint; Number() matches what the invoice sweep above
    // does rather than trusting the JSON encoder to have handed back a number.
    amountCents: Number(r.amount_cents),
    originalPath: r.receipt_original,
  })))

  let archived = 0
  const failed: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    // The year comes from the show's FIRST day, so a trip spanning New Year
    // does not split across two folders. An expense with no show falls back to
    // its own date, which is the only date it has.
    const days: string[] = (row.shows?.dates ?? []).map((d) => d.date)
    const year = (days.length ? days.reduce((a, b) => (a < b ? a : b)) : row.spent_on).slice(0, 4)
    // Both segments go through sanitizeSegment: a show called "Q1/Q2 Tour"
    // would otherwise silently write into a folder nobody asked for.
    const folder = sanitizeSegment(row.shows?.name ?? '', 'Unfiled')
    const path = `/receipts/${sanitizeSegment(year, 'unknown-year')}/${folder}/${names[i]}`

    const { data: blob, error: downloadError } = await db.storage
      .from('receipts').download(row.receipt_original)
    if (downloadError || !blob) {
      failed.push(`${names[i]}: ${downloadError?.message ?? 'could not download'}`)
      continue
    }

    const result = await uploadAndVerify(accessToken, path, new Uint8Array(await blob.arrayBuffer()))
    // ok only when Dropbox's stored size AND content hash both match what went
    // out. Anything less and the mark below must not happen, because the mark
    // is the whole licence for Task 8 to delete the Supabase copy.
    if (!result.ok) { failed.push(`${names[i]}: ${result.error}`); continue }

    const { error: markError } = await db
      .from('expenses')
      .update({ receipt_archived_at: new Date().toISOString() })
      .eq('id', row.id)
    if (markError) {
      // The file IS in Dropbox but the mark failed. Safe: the next run
      // re-uploads it, and mode:'add' with autorename means a duplicate lands
      // beside it rather than overwriting anything.
      failed.push(`${names[i]}: uploaded but not marked — ${markError.message}`)
      continue
    }
    archived++
  }

  return { archived, failed }
}
