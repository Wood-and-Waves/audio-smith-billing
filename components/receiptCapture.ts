'use client'

import { createClient } from '@/lib/supabase/client'
import { scaleToFit, contrastBounds, buildLut, applyContrastStretch, JPEG_QUALITY } from '@/lib/receiptImage'
import {
  type Quad, type GrayImage, scaleQuad, clampQuad, quadUsable,
} from '@/lib/receiptQuad'
import { DETECT_MAX_EDGE, detectReceiptQuad } from '@/lib/receiptCorners'
import { warpOutputSize, warpGray } from '@/lib/receiptWarp'

/**
 * The receipt capture pipeline, shared.
 *
 * Two screens capture receipts: ExpenseLog (a show's expenses) and
 * MoneyRegister (the ledger register). Both need the exact same thing done
 * to a picked file — detect the paper's corners, flatten and contrast-
 * stretch it into a JPEG, upload the enhanced copy alongside the untouched
 * original — so this is the one pipeline both call. A fix to the warp, the
 * contrast stretch, or the upload's all-or-nothing cleanup lands in both
 * screens at once instead of drifting apart between two copies.
 *
 * Lives in components/, not lib/: every function here reaches for
 * `document.createElement('canvas')`, `createImageBitmap`, or Storage, none
 * of which `node --test` can run. The pure maths this leans on — the LUT,
 * the contrast bounds, the warp itself — stays in lib/receiptImage.ts,
 * lib/receiptQuad.ts, lib/receiptCorners.ts and lib/receiptWarp.ts, exactly
 * where it already was; this module is only the canvas/DOM wiring around it.
 */

/** Receipts arrive as photographs or as emailed PDFs. Both end up a JPEG. */
export const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)

/**
 * Draws the first page of a PDF onto a canvas.
 *
 * Airlines, hotels and Amazon email a PDF, and that is the receipt Dan has —
 * so it has to become an image somewhere. It has to be HERE because
 * @react-pdf cannot embed one PDF inside another, and the receipt's whole
 * purpose is to reach the client attached to the invoice.
 *
 * pdf.js is imported dynamically: it is by far the largest thing this screen
 * can pull, and a photographed receipt must not pay for it.
 */
async function pdfFirstPageToCanvas(file: File): Promise<HTMLCanvasElement> {
  // The LEGACY build, deliberately — both here and for the worker.
  //
  // pdf.js 6's default build calls Map.prototype.getOrInsertComputed, a 2025
  // proposal method Safari does not implement. Uploading a PDF in Safari died
  // on "this.#rZ.getOrInsertComputed is not a function" before the file was
  // even read. The legacy bundle ships the core-js polyfill for it; the modern
  // one only calls it. Both the module and the worker need the legacy variant,
  // since the worker parses the document in its own realm and would otherwise
  // hit the same missing method with no polyfill in scope.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url,
  ).toString()

  // Destroy the loading TASK, not the document — that is what releases the
  // worker, and leaking one per receipt would accumulate across a trip.
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const doc = await task.promise
  try {
    const page = await doc.getPage(1)
    // Render at the target size directly. Rasterising at full scale and then
    // shrinking would cost memory for detail the downscale throws away.
    const base = page.getViewport({ scale: 1 })
    const { width, height } = scaleToFit(base.width, base.height)
    const viewport = page.getViewport({ scale: width / base.width })

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot process PDFs.')
    // A PDF page has no background of its own; without this it rasterises onto
    // transparency, which JPEG renders as black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
    return canvas
  } finally {
    await task.destroy()
  }
}

/**
 * The warp resamples one grayscale plane from the source photo at this cap on
 * its long edge -- 1.5x lib/receiptImage.ts's 1600 output cap, high enough
 * that flattening down to the output size still has real detail to resample
 * from, bounded so a 48MP phone photo can't blow phone memory with
 * BATCH_CONCURRENCY 3 of these in flight at once.
 */
const WARP_SOURCE_MAX_EDGE = 2400

/**
 * Draws `bitmap` onto a canvas capped to `maxEdge` on the long side and
 * converts it to a `GrayImage` via the same Rec. 601 luma expression -- and
 * the same Uint8ClampedArray-does-the-rounding treatment -- as the no-quad
 * path in `enhance` below; see the long comment there for why the array
 * store, not a separate Math.round, is what has to do the rounding.
 *
 * Sizing is `scaleToFit`'s never-enlarge math, just parameterized by
 * `maxEdge` instead of the fixed MAX_EDGE constant: detection wants a small
 * plane and the warp wants a much bigger one, and both need the same shape
 * of cap.
 */
function grayFromBitmap(bitmap: ImageBitmap, maxEdge: number): GrayImage {
  return planesFromBitmap(bitmap, maxEdge).gray
}

/**
 * Luma AND chroma from one decode.
 *
 * Detection needs both: luma to find what is bright, chroma to tell white
 * paper from a warm tabletop at the same brightness — the collision that had
 * the flood fill running off a receipt and across a hotel-room table. Built
 * together because they come from the same getImageData call, and reading
 * those pixels twice to build them separately would double the cost of the
 * one step that touches every pixel.
 *
 * Chroma is max(r,g,b) - min(r,g,b): zero for any grey, large for a saturated
 * colour, and indifferent to how brightly lit it is — which is the whole point,
 * since the table and the paper are equally lit and that is why luma alone
 * cannot separate them.
 */
function planesFromBitmap(
  bitmap: ImageBitmap, maxEdge: number,
): { gray: GrayImage; chroma: GrayImage } {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images.')
  ctx.drawImage(bitmap, 0, 0, width, height)

  const px = ctx.getImageData(0, 0, width, height).data
  const data = new Uint8ClampedArray(px.length / 4)
  const chroma = new Uint8ClampedArray(px.length / 4)
  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    const r = px[i], gr = px[i + 1], b = px[i + 2]
    data[g] = (r * 299 + gr * 587 + b * 114) / 1000
    chroma[g] = Math.max(r, gr, b) - Math.min(r, gr, b)
  }
  return {
    gray: { data, width, height },
    chroma: { data: chroma, width, height },
  }
}

/**
 * Encodes a `GrayImage` back to a JPEG blob -- the warp path's counterpart to
 * the RGBA canvas the no-quad path already has lying around. Same
 * Promise-wrapped toBlob and null-blob rejection as `enhance` uses below.
 */
function grayToJpeg(gray: GrayImage): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = gray.width
  canvas.height = gray.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images.')

  const image = ctx.createImageData(gray.width, gray.height)
  const px = image.data
  for (let i = 0, g = 0; g < gray.data.length; i += 4, g++) {
    const v = gray.data[g]
    px[i] = v
    px[i + 1] = v
    px[i + 2] = v
    px[i + 3] = 255
  }
  ctx.putImageData(image, 0, 0)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not process that photo.'))),
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
}

/**
 * Detects a receipt's four corners in `file`, normalized to 0..1 so the
 * result means the same thing regardless of which differently-sized gray
 * plane detection or the warp each end up working on -- see the quad path in
 * `enhance` below for the denormalize side of that trip. Photos only:
 * callers guarantee `file` isn't a PDF. Any thrown error (a browser declining
 * to decode the file) propagates for the caller to catch.
 */
export async function detectCorners(file: File): Promise<Quad | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const { gray, chroma } = planesFromBitmap(bitmap, DETECT_MAX_EDGE)
    const quad = detectReceiptQuad(gray, chroma)
    return quad ? scaleQuad(quad, 1 / gray.width, 1 / gray.height) : null
  } finally {
    bitmap.close()
  }
}

/**
 * The adjuster's starting quad when detection finds nothing. Detection
 * failing means "not found with confidence", not "nothing to mark" -- a
 * generous 12% inset still lets Dan hand-drag the four handles onto a real
 * receipt, and "Use full photo" is one tap away if that's not worth doing.
 */
export const INSET_QUAD: Quad = {
  tl: { x: 0.12, y: 0.12 },
  tr: { x: 0.88, y: 0.12 },
  br: { x: 0.88, y: 0.88 },
  bl: { x: 0.12, y: 0.88 },
}

/**
 * Downscale, grayscale and contrast-stretch, entirely in the browser.
 *
 * Done here rather than on the server for two reasons: a phone photo is 3-5MB
 * and exceeds Next's 1MB server-action body limit, and twelve untouched photos
 * make a PDF most mail servers reject. The maths lives in lib/receiptImage.ts
 * where it can be tested; this is only the canvas wiring.
 *
 * A born-digital PDF already spans the full range from white paper to black
 * text, so the contrast stretch computes to roughly the identity and leaves it
 * alone. The same path serves both without a special case.
 *
 * `quadNorm` is the corner tri-state: `undefined` auto-detects (the batch
 * path, which never confirms with Dan first and never passes an argument
 * here at all); `null` skips the warp outright (Dan picked "Use full photo",
 * or detection found nothing); a `Quad` is used only if `quadUsable`, else
 * treated as `null`. PDFs never see any of this -- the PDF branch below is
 * untouched -- and a warp that fails for its own reasons (degenerate quad,
 * output too small) falls through to the same no-quad path, so "corners not
 * confidently found" can never produce anything worse than today's plain
 * downscale.
 */
export async function enhance(file: File, quadNorm?: Quad | null): Promise<Blob> {
  let canvas: HTMLCanvasElement
  let width: number
  let height: number

  if (isPdf(file)) {
    canvas = await pdfFirstPageToCanvas(file)
    width = canvas.width
    height = canvas.height
  } else {
    const bitmap = await createImageBitmap(file)
    try {
      let quad: Quad | null
      if (quadNorm === undefined) {
        // Auto-detect (the batch path): run detection on THIS bitmap's own
        // downscale rather than calling detectCorners(file), which would
        // decode the file a second time for no reason.
        const { gray: detectGray, chroma: detectChroma } =
          planesFromBitmap(bitmap, DETECT_MAX_EDGE)
        const detected = detectReceiptQuad(detectGray, detectChroma)
        quad = detected ? scaleQuad(detected, 1 / detectGray.width, 1 / detectGray.height) : null
      } else {
        quad = quadNorm && quadUsable(quadNorm) ? quadNorm : null
      }

      if (quad) {
        const gray = grayFromBitmap(bitmap, WARP_SOURCE_MAX_EDGE)
        const pixelQuad = clampQuad(scaleQuad(quad, gray.width, gray.height), gray.width, gray.height)
        const warped = warpGray(gray, pixelQuad, warpOutputSize(pixelQuad))
        if (warped) {
          applyContrastStretch(warped)
          return grayToJpeg(warped)
        }
        // Degenerate quad or too-small output -- fall through to the
        // no-quad path below exactly as if nothing had been detected.
      }

      ;({ width, height } = scaleToFit(bitmap.width, bitmap.height))
      canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const c = canvas.getContext('2d')
      if (!c) throw new Error('This browser cannot process images.')
      c.drawImage(bitmap, 0, 0, width, height)
    } finally {
      bitmap.close()
    }
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images.')

  const image = ctx.getImageData(0, 0, width, height)
  const px = image.data

  // Rec. 601 luma, then a histogram of it.
  //
  // The histogram counts grey[g] AFTER the store, not a separately rounded copy
  // of the same float. Uint8ClampedArray rounds half-to-even and Math.round
  // rounds half-up, so counting Math.round(v) filed a pixel ending in .5 one
  // bucket away from the value the LUT is later indexed by on line 191. The
  // histogram is only read to find the contrast bounds, and MIN_SPAN absorbs a
  // single bucket, so this never showed — but a histogram that does not describe
  // the pixels it is derived from is a trap for whoever tunes this next.
  const histogram = new Array(256).fill(0)
  const grey = new Uint8ClampedArray(px.length / 4)
  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    grey[g] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
    histogram[grey[g]]++
  }

  const { lo, hi } = contrastBounds(histogram)
  const lut = buildLut(lo, hi)

  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    const v = lut[grey[g]]
    px[i] = v
    px[i + 1] = v
    px[i + 2] = v
  }
  ctx.putImageData(image, 0, 0)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not process that photo.'))),
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
}

/**
 * Enhances and uploads both receipt copies, all-or-nothing.
 *
 * This block is UNCHANGED from what used to run inside add() — only moved.
 * It now runs at file-pick time rather than at Add time, so that by the time
 * Add is clicked the receipt already exists in Storage (or the pick already
 * failed and said so), instead of the upload racing the save.
 *
 * Both files BEFORE the row: a row pointing at a failed upload is a receipt
 * that looks present and cannot be opened, and a receipt is what makes an
 * expense billable.
 *
 * Together, not one after the other. The original is the untouched 3-5MB
 * capture and the enhanced copy a few hundred KB; uploaded in sequence the
 * wait is their sum, which on hotel wifi is long enough to look like the
 * page has hung.
 *
 * `quadNorm` passes straight through to `enhance` -- see its doc comment for
 * the tri-state. Batch callers pass nothing, which auto-detects.
 *
 * Callers pass a show id (expenses) or 'ledger' (the register) as
 * `subfolder`; the receipts bucket's RLS policy keys only on the first path
 * segment, so this second one is free to name either use.
 */
export async function uploadReceiptPair(
  supabase: ReturnType<typeof createClient>,
  subfolder: string,
  file: File,
  onStep: (s: string) => void,
  quadNorm?: Quad | null,
): Promise<{ error: string } | { enhancedPath: string; originalPath: string }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const base = `${user.id}/${subfolder}/${stamp}`

  onStep(isPdf(file) ? 'Reading the PDF…' : 'Processing the photo…')
  const enhanced = await enhance(file, quadNorm)

  // The original keeps its own type. A PDF stored as .jpg downloads
  // with an extension that lies about its contents.
  const ext = isPdf(file) ? 'pdf' : 'jpg'
  const enhancedPath = `${base}-enhanced.jpg`
  const originalPath = `${base}-original.${ext}`

  onStep('Uploading the receipt…')
  const [up1, up2] = await Promise.all([
    supabase.storage.from('receipts')
      .upload(enhancedPath, enhanced, { contentType: 'image/jpeg' }),
    supabase.storage.from('receipts')
      .upload(originalPath, file, { contentType: file.type || 'image/jpeg' }),
  ])

  // Either failing means neither is kept: a half-uploaded pair would
  // leave a receipt that cannot be opened behind a billable expense.
  if (up1.error || up2.error) {
    await supabase.storage.from('receipts').remove(
      [up1.error ? null : enhancedPath, up2.error ? null : originalPath]
        .filter(Boolean) as string[],
    )
    return { error: (up1.error ?? up2.error)!.message }
  }

  return { enhancedPath, originalPath }
}

/**
 * Best-effort removal of a receipt pair nobody will ever attach to a row —
 * a superseded pick, or a pair whose OCR read lost the token race.
 *
 * An orphaned file in Storage costs nothing but a few hundred KB; this
 * project's established safe direction (see deleteExpense's own comment in
 * app/expenses/actions.ts) is to risk that over ever blocking on, or
 * surfacing, a cleanup failure.
 */
export function removeSuperseded(paths: string[]) {
  const supabase = createClient()
  void supabase.storage.from('receipts').remove(paths).catch(() => {})
}
