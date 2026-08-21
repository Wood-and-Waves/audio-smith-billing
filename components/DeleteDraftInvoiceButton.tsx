'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteDraftInvoice } from '@/app/invoices/actions'

// The way out for a stranded draft (unlinked from its show to re-bill, never
// sent to anyone). Two-step control copied from DeleteShowButton: arm ->
// named confirm, auto-disarm on a stray click or a few seconds of silence.
// The page only renders this for a never-sent, unlinked draft; the server
// action re-checks all three conditions regardless.

const CONFIRM_TIMEOUT_MS = 4000

export default function DeleteDraftInvoiceButton({
  invoiceId, number,
}: {
  invoiceId: string
  number: number
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function disarm() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    setConfirming(false)
  }

  useEffect(() => {
    if (!confirming) return
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) disarm()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [confirming])

  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current) }, [])

  function arm() {
    setError(null)
    setConfirming(true)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(disarm, CONFIRM_TIMEOUT_MS)
  }

  function remove() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setError(null)
    start(async () => {
      const result = await deleteDraftInvoice(invoiceId)
      if ('error' in result) { setError(result.error); setConfirming(false); return }
      // This page 404s the instant the row is gone — leave first.
      router.push('/invoices')
      router.refresh()
    })
  }

  return (
    <div ref={containerRef} className="inline-flex items-baseline">
      {confirming ? (
        <button
          type="button"
          disabled={pending}
          onClick={remove}
          aria-label={`Confirm delete draft #${number}`}
          className="text-danger hover:opacity-80 transition-opacity text-xs font-semibold disabled:opacity-40"
        >
          {pending ? 'Deleting…' : `Confirm delete draft #${number}?`}
        </button>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={arm}
          aria-label={`Delete draft #${number}`}
          className="text-muted hover:text-danger transition-colors text-xs disabled:opacity-40"
        >
          Delete this draft
        </button>
      )}
      {error && <span role="alert" className="ml-2 text-xs text-danger">{error}</span>}
    </div>
  )
}
