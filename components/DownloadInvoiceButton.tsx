'use client'

import { useState } from 'react'
import { buildInvoicePdf, invoiceFilename, type PdfParts } from '@/lib/invoicePdf'
import type { DocumentData } from '@/components/InvoiceDocument'

// @react-pdf/renderer is around 2MB, so it is imported on click rather than at
// module scope — no invoice page should pay for it just by being opened.
//
// Font.register is global to the library and only needs to happen once.
let fontReady = false

export default function DownloadInvoiceButton({ data }: { data: DocumentData }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setError(null)
    setBusy(true)
    try {
      const { Document, Page, Text, View, Image, Font, pdf } = await import('@react-pdf/renderer')

      if (!fontReady) {
        Font.register({ family: 'Oswald', src: '/fonts/Oswald-Bold.ttf', fontWeight: 700 })
        fontReady = true
      }

      const parts: PdfParts = { Document, Page, Text, View, Image }
      const blob = await pdf(buildInvoicePdf(parts, data, { logoSrc: '/logo.png' })).toBlob()

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = invoiceFilename(data)
      a.click()
      // Deferred, not inline: Firefox and some WebViews abort an in-flight
      // download if its blob URL is revoked before the click finishes
      // dispatching. The timeout still frees the memory, just not too early.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the PDF.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="text-xs font-semibold uppercase tracking-wider text-muted hover:text-ink
                   transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? 'Preparing…' : 'Download PDF'}
      </button>
    </div>
  )
}
