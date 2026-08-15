import { NextResponse, type NextRequest } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { todayInChicago } from '@/lib/dates'
import { sweep, isDigestDay, type ReminderInvoice } from '@/lib/reminders'
import {
  buildDigestEmail, buildOverdueAlertEmail, sendReminderEmail,
} from '@/lib/reminderEmail'
import { archiveNames, sanitizeSegment } from '@/lib/receiptArchiveName'
import { getAccessToken, uploadAndVerify } from '@/lib/dropbox'
import {
  deletable, deletionBlocker, settlementDate, toReclaimCandidates,
  GRACE_DAYS, type ReclaimCandidate, type ReclaimQueryRow,
} from '@/lib/receiptRetention'

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
//
// THIS ROUTE IS THE ONLY THING IN THE APP THAT DESTROYS A RECEIPT. The last
// stage removes receipt_original — the untouched upload — once it is proven to
// be in Dropbox and its invoice has been settled for 30 days. receipt_path, the
// enhanced copy that went on the invoice, is never touched by anything here.
// `?dryRun=1` reports what that stage would remove and returns before any of
// the rest of this route runs.

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

  // ?dryRun=1 — what the deletion stage WOULD destroy tonight, and why each
  // other candidate was spared. Nothing is removed from Storage and no row is
  // written.
  //
  // It returns HERE, ahead of everything below, and that placement is the point:
  // the sweep sends email and inserts reminder_log, and the archive stage
  // uploads to Dropbox. A switch that promises to touch nothing and then mails a
  // client digest is not one.
  //
  // THIS BRANCH IS PERMANENT. It is how a human confirms the guard before
  // trusting it with the only untouched copy of a financial record, and it costs
  // one query on a URL nobody without CRON_SECRET can reach. It shares
  // selectReclaimable with the real stage on purpose — a dry run with a query of
  // its own would prove nothing about the query that does the deleting.
  if (request.nextUrl.searchParams.get('dryRun') === '1') {
    const day = todayInChicago()
    const { considered, error: selectError } = await selectReclaimable(db, settings.owner_id)
    if (selectError) return NextResponse.json({ dryRun: true, error: selectError }, { status: 500 })

    const targets = deletable(considered, day)
    const targeted = new Set(targets.map((t) => t.expenseId))

    return NextResponse.json({
      dryRun: true,
      today: day,
      graceDays: GRACE_DAYS,
      // Only rows that still hold an original AND are already archived reach
      // here; the query cannot return an unarchived one. Every entry below
      // therefore carries an archivedAt, and it is printed rather than assumed
      // so the reader can see that for themselves.
      considered: considered.length,
      wouldDelete: targets.length,
      candidates: targets.map(describeCandidate),
      // The refusals, each with the rule that produced it. A dry run listing
      // nothing is ambiguous — a guard working correctly and a query matching
      // nothing at all look identical — and this is what tells them apart.
      spared: considered
        .filter((c) => !targeted.has(c.expenseId))
        .map((c) => ({ ...describeCandidate(c), reason: deletionBlocker(c, day) })),
    })
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
  //
  // The try is what makes "without disturbing them" true. archiveOriginals is
  // written to return its failures rather than throw, but it awaits things that
  // can reject on their own — a Blob whose body fails mid-read was reproduced
  // doing exactly this — and one of those escaping here 500s a run whose
  // reminders all sent and all logged. The catch turns that back into the
  // ordinary reported failure the stage already knows how to express, so the
  // reasoning below about archive.failed keeps holding.
  let archive: ArchiveResult
  try {
    archive = await archiveOriginals(db, settings.owner_id)
  } catch (e) {
    archive = { archived: 0, paths: [], failed: [e instanceof Error ? e.message : 'Archive stage failed.'] }
  }

  // AFTER the archive, and last of everything, because this is the only stage
  // in the route that destroys anything.
  //
  // Wrapped exactly as the archive is, and for the same reason: reclaimOriginals
  // returns its failures rather than throwing, but it awaits Storage and
  // Postgres, either of which can reject on its own. One of those escaping here
  // 500s a run whose reminders all sent and all logged. A deletion that fails is
  // a deletion that simply happens tomorrow — the row keeps its receipt_original
  // and its receipt_archived_at, so nothing has been lost and nothing is stuck.
  let reclaimed: ReclaimResult
  try {
    reclaimed = await reclaimOriginals(db, settings.owner_id, today)
  } catch (e) {
    reclaimed = {
      deleted: 0, bytesFreed: 0,
      failed: [e instanceof Error ? e.message : 'Deletion stage failed.'],
    }
  }

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
  //
  // `reclaimed.failed` is excluded on the same reasoning, which holds here only
  // because of the ordering inside the stage. A failed delete leaves the file
  // and the column alone. A delete that succeeded and then failed to null the
  // column leaves a row pointing at an object that is already gone, which the
  // next run fixes: it re-selects the row, remove() no-ops on the missing
  // object, and the update is retried. Neither outcome loses anything, so
  // neither is worth spending the one alarm this route has.
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
    reclaimed,
  }, { status: failed.length > 0 ? 500 : 200 })
}

/** Bounded per run: Vercel's Hobby plan caps a function at 60s, and each file is a download plus an upload. */
const ARCHIVE_BATCH = 8

/**
 * How many failed nights make a receipt worth naming in the response.
 *
 * Small on purpose. Three consecutive failures is no longer a Dropbox hiccup or
 * a slow night — it is a row that needs looking at, and the counter below is
 * only useful if the number it reports crosses a threshold a human would act on.
 */
const ARCHIVE_STUCK_AFTER = 3

type ArchiveResult = {
  archived: number
  /** Where each archived file actually landed — see uploadAndVerify on autorename. */
  paths: string[]
  failed: string[]
  /** Waiting rows that have now failed ARCHIVE_STUCK_AFTER times or more. */
  stuck?: number
  skipped?: string
}

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
  receipt_archive_attempts: number | null
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
 *
 * REQUIRES MIGRATION 0020, which adds receipt_archive_attempts. The column is
 * selected, ordered by and written below; deploying this ahead of the migration
 * makes every night's select fail with an unknown column.
 */
async function archiveOriginals(db: SupabaseClient, ownerId: string): Promise<ArchiveResult> {
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
    return { archived: 0, paths: [], failed: [], skipped: `Not configured: ${missing.join(', ')}.` }
  }

  // needsArchiving's rule, written as SQL so migration 0020's partial index on
  // (receipt_archive_attempts, created_at) where receipt_original is not null
  // and receipt_archived_at is null can serve it — the alternative is dragging
  // every expense ever recorded across the wire each night to filter eight rows
  // out of it.
  //
  // owner_id, for the reason the invoice query 150 lines above gives: this
  // client bypasses RLS. Without the filter a second auth user's receipts would
  // be uploaded into DAN'S Dropbox and marked archived — which then licenses the
  // deletion stage to destroy originals belonging to someone else entirely. One
  // owner today, but that is not a property the code should depend on.
  //
  // ATTEMPTS FIRST, then age. Ordering by created_at alone meant a row that
  // could never succeed — a storage object that has gone missing, a path Dropbox
  // refuses — was re-selected at the head of the batch every night forever,
  // because a failure changes no state. Simulated over five nights with forty
  // waiting receipts: eight poisoned rows archived NOTHING, ever; three poisoned
  // rows cut throughput to five a night permanently. Counting the failures and
  // sorting by them lets a bad row drift to the back instead of blocking
  // everything behind it, and the count is what makes it visible rather than
  // merely slow.
  const { data, error } = await db
    .from('expenses')
    .select(`id, spent_on, where_spent, amount_cents, receipt_original,
             receipt_archive_attempts, shows(name, dates:show_days(date))`)
    .eq('owner_id', ownerId)
    .not('receipt_original', 'is', null)
    .is('receipt_archived_at', null)
    .order('receipt_archive_attempts', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(ARCHIVE_BATCH)
  if (error) return { archived: 0, paths: [], failed: [error.message] }

  const rows = (data ?? []) as unknown as ArchiveRow[]
  // Nothing waiting: return before exchanging the refresh token, so the steady
  // state costs one query a night rather than a needless round trip to Dropbox.
  // Nothing waiting also means nothing stuck — a stuck row is a waiting row.
  if (rows.length === 0) return { archived: 0, paths: [], failed: [] }

  let accessToken: string
  try {
    accessToken = await getAccessToken({ appKey, appSecret, refreshToken })
  } catch (e) {
    return { archived: 0, paths: [], failed: [e instanceof Error ? e.message : 'Dropbox auth failed.'] }
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
  const paths: string[] = []
  const failed: string[] = []

  /**
   * Records a failed attempt against the row, then reports it.
   *
   * The increment is the whole point: a failure used to change no state at all,
   * so tomorrow's query saw exactly the same row in exactly the same place. The
   * update is deliberately not checked for its own error — if the counter cannot
   * be written the archive is no worse off than it was before this existed, and
   * a second failure message about the first failure helps nobody.
   */
  async function noteFailure(row: ArchiveRow, name: string, reason: string) {
    failed.push(`${name}: ${reason}`)
    await db
      .from('expenses')
      .update({ receipt_archive_attempts: (row.receipt_archive_attempts ?? 0) + 1 })
      .eq('id', row.id)
  }

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
      await noteFailure(row, names[i], downloadError?.message ?? 'could not download')
      continue
    }

    // Reading the body is its own try. download() resolves as soon as it has a
    // Blob, so a connection that dies mid-body rejects HERE instead — reproduced
    // escaping archiveOriginals entirely and 500ing the cron. The route's outer
    // catch would now hold it, but that would abandon the seven other receipts
    // in the batch for one bad read.
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await blob.arrayBuffer())
    } catch (e) {
      await noteFailure(row, names[i], e instanceof Error ? e.message : 'could not read the downloaded file')
      continue
    }

    const result = await uploadAndVerify(accessToken, path, bytes)
    // ok only when Dropbox's stored size AND content hash both match what went
    // out. Anything less and the mark below must not happen, because the mark
    // is the whole licence for Task 8 to delete the Supabase copy.
    if (!result.ok) { await noteFailure(row, names[i], result.error); continue }

    const { error: markError } = await db
      .from('expenses')
      .update({ receipt_archived_at: new Date().toISOString() })
      .eq('id', row.id)
    if (markError) {
      // The file IS in Dropbox but the mark failed. Safe: the next run
      // re-uploads it, and mode:'add' with autorename means a duplicate lands
      // beside it rather than overwriting anything. Counted as an attempt all
      // the same — a row whose mark can never be written is exactly the kind
      // that used to sit at the head of the queue forever.
      await noteFailure(row, names[i], `uploaded but not marked — ${markError.message}`)
      continue
    }
    archived++
    // Where it actually landed, which with autorename is not always where it was
    // asked to go. Nothing stores this, and nothing should yet; this line is the
    // only record that a collision happened at all.
    paths.push(result.storedPath)
  }

  // Counted after the loop so tonight's increments are included. A number that
  // stays above zero across runs is a receipt that will never archive on its
  // own, which the ordering above has otherwise made invisible: it drifts to the
  // back of the queue and stops showing up in `failed` at all.
  const { count } = await db
    .from('expenses')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId)
    .not('receipt_original', 'is', null)
    .is('receipt_archived_at', null)
    .gte('receipt_archive_attempts', ARCHIVE_STUCK_AFTER)

  return { archived, paths, failed, stuck: count ?? 0 }
}

/** Bounded like the archive stage — a delete is cheap, but the query behind it is not free. */
const DELETE_BATCH = 50

type ReclaimResult = {
  deleted: number
  /** What the run gave back to the 1GB free tier. Reporting only. */
  bytesFreed: number
  failed: string[]
}

/** One candidate, flattened into something readable without the database in front of you. */
function describeCandidate(c: ReclaimCandidate) {
  return {
    expenseId: c.expenseId,
    showName: c.showName,
    invoiceNumber: c.invoiceNumber,
    invoiceStatus: c.invoiceStatus,
    /** The date the grace period is counted from — max(payments.paid_on), or updated_at. */
    settledOn: settlementDate(c),
    archivedAt: c.receiptArchivedAt,
    originalPath: c.receiptOriginal,
  }
}

/**
 * Everything the deletion stage will consider tonight — NOT everything it will
 * delete. Deciding that is `deletable`'s job and nothing here duplicates it.
 *
 * Shared by the real stage and by ?dryRun=1, deliberately. The dry run exists to
 * let a human confirm the guard before it is trusted with the only untouched
 * copy of a financial record; confirming a different query than the one that
 * deletes would confirm nothing.
 */
async function selectReclaimable(
  db: SupabaseClient, ownerId: string,
): Promise<{ considered: ReclaimCandidate[]; error: string | null }> {
  // Both `.not(...)` clauses restate rules that deletionBlocker enforces again
  // on every row that comes back. That repetition is wanted: it keeps the batch
  // limit from being spent on rows that were never eligible, and it means an
  // unarchived original is refused by the database as well as by the code.
  //
  // owner_id, for the reason the invoice query and the archive stage both give:
  // this client bypasses RLS. Unscoped, a second auth user's receipts would be
  // judged against Dan's invoices and destroyed.
  const { data, error } = await db
    .from('expenses')
    .select(`id, receipt_original, receipt_archived_at,
             shows!inner(name, invoices(number, status, updated_at, payments(paid_on)))`)
    .eq('owner_id', ownerId)
    .not('receipt_original', 'is', null)
    .not('receipt_archived_at', 'is', null)
    .order('created_at', { ascending: true })
    .limit(DELETE_BATCH)
  if (error) return { considered: [], error: error.message }

  // Cast for the same reason the archive stage casts: no generated Database
  // type, so the embedded shape is not something TypeScript can know. What the
  // shape actually is at runtime is handled inside toReclaimCandidates.
  return { considered: toReclaimCandidates((data ?? []) as unknown as ReclaimQueryRow[]), error: null }
}

/**
 * Removes originals whose copy is verified and whose invoice has been settled
 * for GRACE_DAYS. `receipt_path` — the enhanced copy that went on the invoice
 * and into the client's inbox — is never read, never nulled and never removed.
 *
 * The ORDER matters and is not the obvious one: the file goes first, THEN the
 * column is nulled. Nulling first and failing the delete would leave an object
 * whose path is recorded nowhere — an orphan that can never be found again, and
 * never freed. This way a failed null is retried tomorrow, where the delete is a
 * harmless no-op against an object that is already gone.
 */
async function reclaimOriginals(
  db: SupabaseClient, ownerId: string, today: string,
): Promise<ReclaimResult> {
  const { considered, error } = await selectReclaimable(db, ownerId)
  if (error) return { deleted: 0, bytesFreed: 0, failed: [error] }

  // The guard. Every rule lives in deletionBlocker, which is tested against all
  // of them, rather than being spelled out again here where a second copy could
  // drift from the first.
  const targets = deletable(considered, today).filter((t) => t.receiptOriginal !== null)
  if (targets.length === 0) return { deleted: 0, bytesFreed: 0, failed: [] }

  // The last gate, and yes it duplicates deletionBlocker's second clause. That
  // is exactly why it is here: the query refuses an unarchived row, and
  // deletable refuses it again, which means a mistake in either one would be
  // invisible. An original with no verified copy in Dropbox is the ONLY copy of
  // that receipt. If one ever reaches this line the whole batch stops rather
  // than the code finding out afterwards.
  if (targets.some((t) => t.receiptArchivedAt === null)) {
    return {
      deleted: 0, bytesFreed: 0,
      failed: ['refused: a selected row had no receipt_archived_at — nothing was deleted'],
    }
  }

  const paths = targets.map((t) => t.receiptOriginal as string)

  // Size is read BEFORE the delete, purely so the run can report what it
  // reclaimed. A failure here must not stop the delete, hence the try and the
  // empty catch — a byte count nobody acts on is not worth holding up the one
  // job this stage has.
  let bytesFreed = 0
  try {
    for (const path of paths) {
      const slash = path.lastIndexOf('/')
      const dir = slash < 0 ? '' : path.slice(0, slash)
      const file = path.slice(slash + 1)
      const { data: listed } = await db.storage
        .from('receipts')
        .list(dir, { search: file })
      // Matched by exact name: `search` is a substring match, so a receipt whose
      // stem is a prefix of another's would otherwise be reported at the wrong
      // file's size.
      bytesFreed += listed?.find((o) => o.name === file)?.metadata?.size ?? 0
    }
  } catch { /* reporting only */ }

  const { error: removeError } = await db.storage.from('receipts').remove(paths)
  // An object that is already missing is not an error here — that is what makes
  // the stage idempotent, and it is what lets a failed null be retried.
  if (removeError) return { deleted: 0, bytesFreed: 0, failed: [removeError.message] }

  // Only now is the column cleared — see the note on ordering above. Note what
  // is NOT in this update: receipt_path is not mentioned, so no failure mode of
  // this statement can reach it.
  const { error: nullError } = await db
    .from('expenses')
    .update({ receipt_original: null })
    .in('id', targets.map((t) => t.expenseId))
  if (nullError) {
    return {
      deleted: 0, bytesFreed,
      failed: [`files removed, rows not updated: ${nullError.message}`],
    }
  }

  return { deleted: targets.length, bytesFreed, failed: [] }
}
