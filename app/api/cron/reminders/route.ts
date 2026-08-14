import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { todayInChicago } from '@/lib/dates'
import { sweep, isDigestDay, type ReminderInvoice } from '@/lib/reminders'
import {
  buildDigestEmail, buildOverdueAlertEmail, sendReminderEmail,
} from '@/lib/reminderEmail'

// The reminder sweep, called by Vercel Cron once a morning.
//
// THIS IS THE ONLY FILE PERMITTED TO READ SUPABASE_SERVICE_ROLE_KEY. That key
// bypasses every RLS policy in the database. It is here because the sweep has
// no user session and must read across all invoices; it is acceptable here
// because this route refuses anything without CRON_SECRET. Never move this
// read into a page, a component, or a server action.
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
  if (!url || !serviceKey || !appUrl) {
    return NextResponse.json({ error: 'Reminders are not configured.' }, { status: 500 })
  }

  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // This query is the keepalive. It runs whatever today is.
  const { data: rows, error } = await db
    .from('invoices')
    .select(`id, number, due_date, total_cents, status, owner_id,
             clients(name),
             reminder_log(kind)`)
    .eq('status', 'sent')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: settings } = await db
    .from('settings').select('email').eq('id', 1).maybeSingle()
  const to = settings?.email
  if (!to) return NextResponse.json({ error: 'No settings email to send to.' }, { status: 500 })

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

  return NextResponse.json({
    today,
    digestDay: isDigestDay(today),
    dueSoon: s.dueSoon.length,
    overdue: s.overdue.length,
    newlyOverdue: s.newlyOverdue.length,
    outstandingCents: s.totalOutstandingCents,
    sent,
    failed,
  })
}
