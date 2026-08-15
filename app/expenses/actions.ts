'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isPlainDate, todayInChicago } from '@/lib/dates'
import { CATEGORY_ORDER, type ExpenseCategory } from '@/lib/expenses'
import { readReceiptImage } from '@/lib/receiptOcr'
import type { ReceiptFields } from '@/lib/receiptExtraction'

type Fail = { error: string }

/** How long a receipt link lives. Longer than any render, shorter than a leak. */
const SIGNED_URL_SECONDS = 3600

/**
 * The bucket caps objects at 10MB and the enhanced JPEG this reads back is a
 * few hundred KB, so anything past this is already wrong — refused by its
 * declared `content-length` before a single byte of the body is read.
 */
const MAX_RECEIPT_DOWNLOAD_BYTES = 6 * 1024 * 1024

/**
 * Records an expense.
 *
 * The FILES ARE ALREADY UPLOADED by the time this runs — the browser puts them
 * straight into Storage, both because a phone photo exceeds Next's 1MB server
 * action body limit and because a row pointing at a failed upload is a receipt
 * that appears to exist and cannot be opened. Since a receipt is what makes an
 * expense billable, that would let a show bill with a broken attachment.
 */
export async function addExpense(input: {
  showId: string
  category: ExpenseCategory
  whereSpent: string
  amountCents: number
  spentOn: string
  receiptPath: string | null
  receiptOriginal: string | null
  note: string
}): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: show } = await supabase
    .from('shows').select('status').eq('id', input.showId).maybeSingle()
  if (!show) return { error: 'That show no longer exists.' }
  if (show.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  if (!CATEGORY_ORDER.includes(input.category)) {
    return { error: `"${input.category}" is not an expense category.` }
  }
  if (!input.whereSpent.trim()) return { error: 'Say where the money went.' }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { error: 'An expense needs an amount greater than zero.' }
  }
  if (!isPlainDate(input.spentOn)) return { error: 'Pick the date of the expense.' }

  // Storage RLS constrains writes to folder[1] = auth.uid() but says nothing
  // about the show id in folder[2] — a caller-supplied path pointing at a
  // DIFFERENT show's key would let deleteShow on that other show remove this
  // expense's own file, leaving a live row pointing at a deleted one, which
  // is the exact invariant receipts are built around. Both paths are
  // checked, before the insert.
  const prefix = `${user.id}/${input.showId}/`
  if (input.receiptPath !== null && !input.receiptPath.startsWith(prefix)) {
    return { error: 'That receipt was not uploaded to this show.' }
  }
  if (input.receiptOriginal !== null && !input.receiptOriginal.startsWith(prefix)) {
    return { error: 'That receipt was not uploaded to this show.' }
  }

  const { data, error } = await supabase.from('expenses').insert({
    owner_id: user.id,
    show_id: input.showId,
    category: input.category,
    where_spent: input.whereSpent.trim(),
    amount_cents: input.amountCents,
    spent_on: input.spentOn,
    receipt_path: input.receiptPath,
    receipt_original: input.receiptOriginal,
    note: input.note.trim() || null,
  }).select('id').single()
  if (error) return { error: error.message }

  revalidatePath(`/shows/${input.showId}`)
  return { ok: true, id: data.id }
}

/** Removes an expense and its receipt files. */
export async function deleteExpense(expenseId: string): Promise<Fail | { ok: true; warning?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Derive the lock from the expense's own show, never a caller-supplied id.
  const { data: expense } = await supabase
    .from('expenses')
    .select('show_id, receipt_path, receipt_original, shows(status)')
    .eq('id', expenseId).maybeSingle()
  if (!expense) return { error: 'That expense no longer exists.' }

  const row = expense as unknown as {
    show_id: string
    receipt_path: string | null
    receipt_original: string | null
    shows: { status: string } | null
  }
  if (row.shows?.status === 'billed') {
    return { error: 'This show is billed. Unlink it before editing.' }
  }

  const { error } = await supabase.from('expenses').delete().eq('id', expenseId)
  if (error) return { error: error.message }

  // Files after the row: an orphaned file costs storage, an orphaned row costs
  // a receipt that cannot be opened.
  const paths = [row.receipt_path, row.receipt_original].filter(Boolean) as string[]
  let warning: string | undefined
  if (paths.length) {
    const { error: storageError } = await supabase.storage.from('receipts').remove(paths)
    // The row is already gone by this point — there is nothing to roll back,
    // so a storage failure here is a warning about a leftover file, not a
    // reason to report the delete itself as failed.
    if (storageError) {
      warning = `The expense was deleted, but its receipt file${paths.length === 1 ? '' : 's'} ` +
        `could not be removed from storage: ${storageError.message}`
    }
  }

  revalidatePath(`/shows/${row.show_id}`)
  return warning ? { ok: true, warning } : { ok: true }
}

/**
 * Short-lived read URLs, keyed by storage path.
 *
 * `storageError` is true only for a genuine top-level failure from Storage
 * itself (down, unreachable, credentials rejected) — never for an individual
 * missing object. createSignedUrls returns HTTP 200 with a per-row result
 * for a deleted file: that row comes back with no `signedUrl` and the
 * top-level `error` stays null, indistinguishable from any other row except
 * by its own absence from `urls`. A caller that collapsed "zero urls came
 * back" into "Storage is down" would treat one deleted receipt exactly like
 * a bucket outage — see app/invoices/actions.ts, which used to.
 */
export async function signedReceiptUrls(
  paths: string[],
): Promise<{ urls: Record<string, string>; storageError: boolean }> {
  if (paths.length === 0) return { urls: {}, storageError: false }
  const supabase = await createClient()
  const { data, error } = await supabase.storage
    .from('receipts').createSignedUrls(paths, SIGNED_URL_SECONDS)
  if (error || !data) return { urls: {}, storageError: true }

  const urls: Record<string, string> = {}
  for (const row of data) {
    if (row.path && row.signedUrl) urls[row.path] = row.signedUrl
  }
  return { urls, storageError: false }
}

/**
 * Reads a receipt already sitting in Storage and returns Claude's best
 * guess at its four fields, for a human to confirm. Nothing is written and
 * no show is locked — there is no `showId` here, and the `user.id` prefix
 * check below is the entire authorization. The worst a caller-supplied
 * `receiptPath` outside that prefix could do is fail the check; the worst
 * one INSIDE it can do is spend a Claude call OCR-ing the caller's own
 * other receipt, which is not a security problem worth a second parameter.
 *
 * No `revalidatePath`: this reads, it never mutates.
 */
export async function extractReceipt(
  receiptPath: string,
): Promise<Fail | { ok: true; fields: ReceiptFields; unreadable: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!receiptPath.startsWith(`${user.id}/`)) {
    return { error: 'That receipt does not belong to you.' }
  }

  // Reuse signedReceiptUrls rather than a second signing path — it already
  // tells a genuine Storage outage apart from this one object simply being
  // missing (see its own doc comment above).
  const { urls, storageError } = await signedReceiptUrls([receiptPath])
  if (storageError) {
    return { error: 'That receipt could not be reached (Storage may be down). Try again.' }
  }
  const url = urls[receiptPath]
  if (!url) return { error: 'That receipt no longer exists.' }

  let res: Response
  try {
    res = await fetch(url)
  } catch {
    return { error: 'That receipt could not be downloaded.' }
  }
  if (!res.ok) return { error: 'That receipt could not be downloaded.' }

  // Refused off the declared length, before the body is ever read into
  // memory or base64'd into an API call — see MAX_RECEIPT_DOWNLOAD_BYTES.
  const declaredLength = Number(res.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RECEIPT_DOWNLOAD_BYTES) {
    return { error: 'That receipt file is too large to read.' }
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength > MAX_RECEIPT_DOWNLOAD_BYTES) {
    return { error: 'That receipt file is too large to read.' }
  }

  // readReceiptImage already returns { error } with its own message (e.g.
  // naming a missing ANTHROPIC_API_KEY by name) — passed through as-is
  // rather than wrapped, since the UI shows that string verbatim.
  const result = await readReceiptImage({ bytes, mediaType: 'image/jpeg', today: todayInChicago() })
  if ('error' in result) return result

  return { ok: true, fields: result.fields, unreadable: result.unreadable }
}

export type OriginalRef = {
  spentOn: string
  vendor: string | null
  amountCents: number
  originalPath: string
  signedUrl: string
}

/**
 * Every original still held for a show, with a signed URL each.
 *
 * The browser assembles the zip itself: an 80MB archive must not pass through a
 * serverless function, which has neither the memory budget nor the time.
 */
export async function listShowOriginals(
  showId: string,
): Promise<Fail | { originals: OriginalRef[]; showName: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: show, error: showError } = await supabase
    .from('shows').select('name').eq('id', showId).single()
  if (showError) return { error: showError.message }

  const { data, error } = await supabase
    .from('expenses')
    .select('spent_on, where_spent, amount_cents, receipt_original')
    .eq('show_id', showId)
    .not('receipt_original', 'is', null)
    .order('spent_on', { ascending: true })
  if (error) return { error: error.message }

  const rows = (data ?? []) as {
    spent_on: string; where_spent: string; amount_cents: number; receipt_original: string
  }[]
  if (rows.length === 0) return { originals: [], showName: show.name }

  // Reuse signedReceiptUrls rather than a second signing path — see its own
  // doc comment above for why a genuine Storage outage must be told apart
  // from one missing object.
  const { urls, storageError } = await signedReceiptUrls(rows.map((r) => r.receipt_original))
  if (storageError) return { error: 'Storage could not be reached. Try again.' }

  return {
    showName: show.name,
    originals: rows.flatMap((r) => {
      const signedUrl = urls[r.receipt_original]
      // A row whose object has already gone is skipped rather than failing the
      // export: the rest of the show is still worth saving.
      return signedUrl ? [{
        spentOn: r.spent_on,
        vendor: r.where_spent || null,
        amountCents: r.amount_cents,
        originalPath: r.receipt_original,
        signedUrl,
      }] : []
    }),
  }
}
