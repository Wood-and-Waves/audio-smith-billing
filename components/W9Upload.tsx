'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { setW9 } from '@/app/settings/actions'

/**
 * The W-9 on file, and the control that replaces it.
 *
 * New clients ask for a W-9 before they will pay a first invoice, and the form
 * is reissued yearly — so this is a replace-in-place control, not an archive.
 * One W-9 is current; the send panel offers that one.
 *
 * The FILE goes browser -> Storage directly (the receipts idiom, for the same
 * reason: no point routing megabytes through a server action). Only the
 * resulting path goes to `setW9`, which verifies the owner prefix before
 * trusting it and deletes the file it replaced.
 *
 * The uploaded date is shown rather than a bare "on file" because the fact Dan
 * actually needs is whether it is THIS year's form — a stale W-9 is worse than
 * none, since a client will file it and not ask again.
 */
export default function W9Upload({ uploadedAt }: { uploadedAt: string | null }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const when = uploadedAt
    ? new Date(uploadedAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : null

  function onPick(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setError(null)

    // Type checked here as well as by `accept`, which is only a Finder filter
    // and is trivially bypassed by dragging or by a browser that ignores it.
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('A W-9 has to be a PDF.')
      return
    }

    setBusy(true)
    void (async () => {
      try {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) throw new Error('Not signed in.')

        // {owner_id}/w9/… — the first segment is what the receipts bucket's
        // RLS scopes on, and what setW9 re-checks before trusting the path.
        // Timestamped rather than a fixed name so a replace can never race a
        // send that is mid-download of the old one.
        const path = `${user.id}/w9/${Date.now()}-w9.pdf`
        const { error: uploadError } = await supabase.storage
          .from('receipts').upload(path, file, { contentType: 'application/pdf' })
        if (uploadError) throw new Error(uploadError.message)

        start(async () => {
          const result = await setW9(path)
          if ('error' in result) {
            // The row still names the OLD file, so the upload just made an
            // orphan. Clear it rather than leave a stray W-9 in the bucket.
            await supabase.storage.from('receipts').remove([path])
            setError(result.error)
            return
          }
          router.refresh()
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That file could not be uploaded.')
      } finally {
        setBusy(false)
        if (inputRef.current) inputRef.current.value = ''
      }
    })()
  }

  const working = busy || pending

  return (
    <div className="mb-8">
      <h2 className="eyebrow mb-3">W-9</h2>
      <p className="text-xs text-muted mb-3">
        {when
          ? `On file — uploaded ${when}. Attach it to an invoice from the send panel.`
          : 'None on file. Upload one and the send panel will offer to attach it.'}
      </p>
      <label className={working ? undefined : 'cursor-pointer'}>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          disabled={working}
          onChange={(e) => onPick(e.target.files)}
          className="sr-only peer"
        />
        <span className="inline-block px-3 py-1.5 rounded-field border border-line
                         text-xs font-bold uppercase tracking-wider text-muted
                         peer-disabled:opacity-50 peer-focus-visible:outline-2
                         peer-focus-visible:outline-accent hover:text-ink">
          {working ? 'Uploading…' : when ? 'Replace W-9' : 'Upload W-9'}
        </span>
      </label>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  )
}
