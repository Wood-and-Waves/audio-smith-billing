'use client'

import { useState } from 'react'
import { buildInvoicePdf, invoiceFilename, type PdfParts } from '@/lib/invoicePdf'
import type { DocumentData } from '@/components/InvoiceDocument'

// @react-pdf/renderer is around 2MB, so it is imported on click rather than at
// module scope — no invoice page should pay for it just by being opened.
//
// Font.register is global to the library and only needs to happen once.
let fontReady = false

/**
 * The browser-side render of the exact document the email attaches — shared
 * by this download button and SendInvoicePanel's pre-send preview, so what
 * Dan checks, what he saves, and what the client receives can never diverge.
 */
export async function buildInvoicePdfBlob(data: DocumentData): Promise<Blob> {
  const { Document, Page, Text, View, Image, Font, pdf } = await import('@react-pdf/renderer')

  if (!fontReady) {
    Font.register({ family: 'Oswald', src: '/fonts/Oswald-Bold.ttf', fontWeight: 700 })
    fontReady = true
  }

  const parts: PdfParts = { Document, Page, Text, View, Image }
  const blob = await pdf(buildInvoicePdf(parts, data, { logoSrc: '/logo.png' })).toBlob()

  // Original PDF receipts (born-digital — an emailed Uber Eats/airline/hotel
  // PDF) ride along at the end, at full vector fidelity: the receipts
  // section the document above already has only ever carries a rasterized
  // JPEG thumbnail of each one. app/invoices/[id]/page.tsx is the assembly
  // point that signs a URL for every PDF original onto
  // data.backup.expenses[].receiptOriginalPdfUrl — this is purely the
  // browser-side merge on top of that, so a fetch failure or a corrupt file
  // just leaves the un-merged download; it never blocks it, and this
  // signature is unchanged so SendInvoicePanel's preview gets the same
  // appendix for free.
  const originalUrls = (data.backup?.expenses ?? [])
    .map((e) => e.receiptOriginalPdfUrl)
    .filter((u): u is string => Boolean(u))
  if (originalUrls.length === 0) return blob

  // Mirrors sendInvoice's server-side cap: a runaway object must not be
  // buffered into the browser's memory any more than a function's.
  const MAX_APPENDIX_BYTES = 6 * 1024 * 1024
  const fetched: Uint8Array[] = []
  for (const url of originalUrls) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_APPENDIX_BYTES) continue
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength > MAX_APPENDIX_BYTES) continue
      fetched.push(bytes)
    } catch {
      continue
    }
  }
  if (fetched.length === 0) return blob

  try {
    // Lazy-imported for the same reason @react-pdf/renderer is above: a
    // download this page's byte size must not be paid by every page that
    // merely imports this module's exported type.
    const { appendPdfs } = await import('@/lib/mergePdfAppendices')
    const merged = await appendPdfs(new Uint8Array(await blob.arrayBuffer()), fetched)
    // The cast, and only a cast — same reasoning as ExpenseLog.tsx's zip
    // Blob: BlobPart rejects Uint8Array<ArrayBufferLike> because that admits
    // a SharedArrayBuffer backing store, and nothing here is shared.
    return new Blob([merged] as BlobPart[], { type: 'application/pdf' })
  } catch {
    // pdf-lib itself choking on a base document should not happen — this
    // blob just rendered cleanly above — but if it does, the un-merged
    // download is still a complete, correct invoice.
    return blob
  }
}

export default function DownloadInvoiceButton({ data }: { data: DocumentData }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setError(null)
    setBusy(true)
    try {
      const blob = await buildInvoicePdfBlob(data)

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
