'use client'

import { useEffect, useState } from 'react'
import { pdfFirstPageImage } from '@/components/receiptCapture'

/**
 * Tapping a vendor name (ExpenseLog) or a receipt icon (MoneyRegister) opens
 * the ENHANCED receipt — the flattened, contrast-stretched one, what OCR read
 * and the invoice will embed — in this fullscreen lightbox. Extracted out of
 * ExpenseLog so the register's receipt column can reuse it unchanged; the
 * signed URL goes straight into the <img>, nothing is downloaded or revoked
 * here.
 *
 * A PDF receipt has no enhanced image to show, so its first page is drawn to
 * one here. That is the only dependable way to get a PDF into an overlay: an
 * <iframe> renders blank on iOS Safari, and a new tab is not an overlay. If the
 * drawing fails the anchor below still opens the file itself.
 */
export default function ReceiptLightbox({
  url, label, pdf = false, onClose,
}: {
  url: string
  label: string
  pdf?: boolean
  onClose: () => void
}) {
  const [drawn, setDrawn] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!pdf) return
    let live = true
    setDrawn(null)
    setFailed(false)
    pdfFirstPageImage(url)
      .then((dataUrl) => { if (live) setDrawn(dataUrl) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [pdf, url])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Receipt: ${label}`}
      // Focus lands here on open so Escape works without a click first —
      // same lesson as CornerAdjuster's panel. The contains-guard keeps
      // re-renders while open from yanking focus off the Close button
      // (an inline callback ref re-runs on every render).
      tabIndex={-1}
      ref={(el) => { if (el && !el.contains(document.activeElement)) el.focus() }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4
                 outline-none cursor-zoom-out"
      onClick={() => onClose()}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      {/* A tall receipt fills the screen, leaving no backdrop to tap —
          this is the always-reachable way out. */}
      <button
        type="button"
        onClick={() => onClose()}
        aria-label="Close receipt"
        className="absolute top-4 left-4 h-10 w-10 rounded-full border-2 border-white/80
                   text-white/90 text-xl leading-none flex items-center justify-center
                   bg-black/40 hover:bg-black/60"
      >
        ×
      </button>
      {pdf ? (
        <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
          {drawn !== null && (
            <img
              src={drawn}
              alt={`Receipt from ${label}`}
              className="max-h-[82vh] max-w-full object-contain rounded-field bg-white"
            />
          )}
          {drawn === null && !failed && <p className="text-white/80 text-sm">Opening the receipt…</p>}
          {failed && <p className="text-white/80 text-sm">This receipt could not be drawn here.</p>}
          <a
            href={url} target="_blank" rel="noopener noreferrer"
            className="text-sm text-white/90 underline hover:text-white"
          >
            Open the original PDF
          </a>
        </div>
      ) : (
        <img
          src={url}
          alt={`Receipt from ${label}`}
          className="max-h-[90vh] max-w-full object-contain rounded-field"
        />
      )}
    </div>
  )
}
