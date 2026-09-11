'use client'

import { useState } from 'react'
import { buildCashflowPdf, cashflowFilename, type CashflowDocumentData } from '@/lib/cashflowPdf'

// @react-pdf/renderer is around 2MB, so it is imported on click rather than at
// module load — the same reason DownloadPlButton defers it.
export default function DownloadCashflowButton({ data }: { data: CashflowDocumentData }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setBusy(true)
    setError(null)
    try {
      const { Document, Page, Text, View, Image, pdf } = await import('@react-pdf/renderer')
      const blob = await pdf(
        buildCashflowPdf({ Document, Page, Text, View, Image }, data) as any,
      ).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = cashflowFilename(
        data.months[0]?.month ?? 'start',
        data.months[data.months.length - 1]?.month ?? 'end',
      )
      a.click()
      // Deferred, not inline — Firefox and some WebViews abort an in-flight
      // download if its blob URL is revoked before the click finishes
      // dispatching. See components/DownloadInvoiceButton.tsx.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      setError('Could not build the PDF.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider
                   text-muted hover:text-ink transition-colors disabled:opacity-40"
      >
        {busy ? 'Building…' : 'Download PDF'}
      </button>
      {error && <p className="text-xs text-danger mt-1">{error}</p>}
    </>
  )
}
