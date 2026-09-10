'use client'

import { useState } from 'react'
import { buildProfitLossPdf, plFilename, type PlDocumentData } from '@/lib/profitLossPdf'

// @react-pdf/renderer is around 2MB, so it is imported on click rather than at
// module scope — the same rule DownloadInvoiceButton follows. Someone only
// reading the Reports page never pays for it.
export default function DownloadPlButton({ data }: { data: PlDocumentData }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setBusy(true)
    setError(null)
    try {
      const { Document, Page, Text, View, Image, pdf } = await import('@react-pdf/renderer')
      const blob = await pdf(
        buildProfitLossPdf({ Document, Page, Text, View, Image }, data) as any,
      ).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = plFilename(data.from, data.to)
      a.click()
      // Deferred, not inline — see components/DownloadInvoiceButton.tsx:
      // Firefox and some WebViews abort an in-flight download if its blob
      // URL is revoked before the click finishes dispatching. The timeout
      // still frees the memory, just not too early.
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
        {busy ? 'Building…' : 'Download P&L'}
      </button>
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
    </>
  )
}
