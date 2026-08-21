// Appends whole PDF documents onto the end of an invoice PDF.
//
// WHY: a born-digital receipt (an emailed Uber Eats / airline / hotel PDF)
// carries vector text at full fidelity. lib/invoicePdf.ts already rasterizes
// its first page into a JPEG for the receipts section, which is fine as an
// at-a-glance thumbnail — but that rasterization is exactly the fuzzy,
// grayscale-looking page a client should never be the ONLY copy of. This
// module puts the original pages back, appended after the document the
// invoice PDF already is, so what the client ultimately holds is the vector
// original, not a scan of it.
//
// Every caller lazy-imports pdf-lib (`await import('pdf-lib')`), never at
// module scope — the same reasoning as the pdf.js precedent in
// components/ExpenseLog.tsx and the @react-pdf/renderer precedent in
// components/DownloadInvoiceButton.tsx: a library this size must not ride
// along with every bundle that merely imports this file.
//
// Pure: no database, no clock, no '@/' imports, no JSX — runs under plain
// node --test.

/**
 * Copies every page of every appendix onto the end of `base`, in order.
 *
 * One bad appendix — corrupt bytes, an encrypted PDF pdf-lib refuses to open
 * without a password — must never sink the whole invoice send: the
 * rasterized thumbnail page is still in the body either way, so a receipt
 * that cannot be merged is simply skipped, not a reason to fail the caller.
 */
export async function appendPdfs(base: Uint8Array, appendices: Uint8Array[]): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib')
  const out = await PDFDocument.load(base)

  for (const bytes of appendices) {
    try {
      const doc = await PDFDocument.load(bytes)
      const pages = await out.copyPages(doc, doc.getPageIndices())
      for (const page of pages) out.addPage(page)
    } catch {
      // Skip silently — see the header comment.
      continue
    }
  }

  return out.save()
}
