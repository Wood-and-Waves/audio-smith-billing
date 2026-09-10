'use client'

/**
 * Tapping a vendor name (ExpenseLog) or a receipt icon (MoneyRegister) opens
 * the ENHANCED receipt — the flattened, contrast-stretched one, what OCR read
 * and the invoice will embed — in this fullscreen lightbox. Extracted out of
 * ExpenseLog so the register's receipt column can reuse it unchanged; the
 * signed URL goes straight into the <img>, nothing is downloaded or revoked
 * here.
 */
export default function ReceiptLightbox({
  url, label, onClose,
}: {
  url: string
  label: string
  onClose: () => void
}) {
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
      <img
        src={url}
        alt={`Receipt from ${label}`}
        className="max-h-[90vh] max-w-full object-contain rounded-field"
      />
    </div>
  )
}
