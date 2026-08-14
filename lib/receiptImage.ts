// The arithmetic that makes a phone photo look like a scan.
//
// Two jobs, both pure so they can be tested without a canvas: work out the
// target size, and work out the contrast curve. The component does the drawing.
//
// This is a contrast STRETCH, never a binary threshold. Thresholding is what
// produces the crispest-looking scan and it is exactly wrong here: thermal
// receipts fade, and a hard cutoff erases a faint total — the single number a
// client is most likely to query. The original is kept regardless.

/** Long edge, in pixels. Twelve of these must fit in one emailable PDF. */
export const MAX_EDGE = 1600

/** Enough for receipt text; small enough that a trip's worth stays sendable. */
export const JPEG_QUALITY = 0.8

/** Ignored at each end when choosing the contrast range. */
const TAIL_FRACTION = 0.02

/** Scale so the LONG edge is at most MAX_EDGE. Never enlarges. */
export function scaleToFit(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

/**
 * The luminance range actually occupied by the receipt.
 *
 * Uses the 2nd and 98th percentile rather than the true min and max: one black
 * speck and one glare highlight would otherwise pin the range to 0–255 and the
 * stretch would do nothing at all, which is the common case for a photo taken
 * on a table under a lamp.
 */
export function contrastBounds(histogram: number[]): { lo: number; hi: number } {
  const total = histogram.reduce((a, b) => a + b, 0)
  if (total === 0) return { lo: 0, hi: 255 }

  const cut = total * TAIL_FRACTION
  let lo = 0
  let hi = 255

  let seen = 0
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]
    if (seen > cut) { lo = v; break }
  }

  seen = 0
  for (let v = 255; v >= 0; v--) {
    seen += histogram[v]
    if (seen > cut) { hi = v; break }
  }

  return { lo, hi }
}

/** A 256-entry lookup mapping [lo, hi] onto the full 0–255 scale. */
export function buildLut(lo: number, hi: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256)
  // A flat image collapses lo and hi. Guard the division rather than letting
  // every pixel become NaN and the receipt vanish.
  const span = Math.max(1, hi - lo)
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.round(((v - lo) / span) * 255)
  }
  return lut
}
