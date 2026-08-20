// Perspective-flattens a receipt: given the four corners of the receipt in a
// photo, find the projective map from a unit square onto that quad, then
// resample the photo through its inverse to produce a straight, axis-aligned
// document. Pure and canvas-free, like `receiptQuad.ts` — testable without a
// browser, reused unchanged for both the automatic batch path and Dan's
// manual re-flatten-from-adjuster path.
//
// The homography itself uses Heckbert's closed-form unit-square-to-quad
// solution (a 2x2 linear solve for the two perspective terms, then four
// direct substitutions), not the textbook approach of writing out all eight
// correspondence equations (4 points x 2 coordinates) and Gaussian-eliminating
// an 8x8 matrix. Both derive the same homography, but the general 8x8 solve
// carries floating-point error across the whole matrix and needs a pivoting
// strategy to stay stable; here the unit square holds three of its four
// corners at exactly (0,0)/(1,0)/(0,1), which is precisely the structure
// Heckbert's derivation exploits to collapse the system to a single 2x2 solve
// (and to an even simpler affine case when the perspective terms vanish
// entirely — a parallelogram quad, e.g. a photo shot dead-on). Simpler code,
// fewer places for cancellation error to hide, exact for the shapes this
// feature actually produces.
//
// The warp always maps FROM the unit square TO the quad — `mapPoint` is used
// in the "inverse" direction by `warpGray`: for each pixel in the OUTPUT
// (rectangular) image, compute its position in the unit square, map it INTO
// the source photo, and bilinear-sample there. This inverse-mapping approach
// (walk the output, sample the source) is what keeps the output free of gaps;
// mapping forward (walk the source quad, scatter into the output) would leave
// holes wherever the projection stretches the source thin.

import type { Point, Quad, GrayImage } from './receiptQuad.ts'
import { scaleToFit } from './receiptImage.ts'

/** Below this magnitude, a determinant or perspective coefficient is treated as exactly zero. */
const EPSILON = 1e-9

/** Below this, an output dimension can't hold a usable warped receipt — same failure as no quad found. */
const MIN_OUTPUT_DIMENSION = 32

/** Coefficients mapping the unit square (s,t) to source coordinates (x,y); see `mapPoint`. */
export type Homography = {
  a: number; b: number; c: number
  d: number; e: number; f: number
  g: number; h: number
}

/**
 * Heckbert's closed-form solution for the homography taking the unit square
 * (0,0)/(1,0)/(1,1)/(0,1) onto `quad`'s tl/tr/br/bl. Returns null when the
 * quad is degenerate enough that no such homography exists (the 2x2 solve's
 * determinant vanishes) — collinear or near-collinear corners.
 */
export function rectToQuad(quad: Quad): Homography | null {
  const { tl, tr, br, bl } = quad

  const dx1x = tr.x - br.x
  const dx1y = tr.y - br.y
  const dx2x = bl.x - br.x
  const dx2y = bl.y - br.y
  const sx = tl.x - tr.x + br.x - bl.x
  const sy = tl.y - tr.y + br.y - bl.y

  let a: number, b: number, c: number
  let d: number, e: number, f: number
  let g: number, h: number

  if (Math.abs(sx) < EPSILON && Math.abs(sy) < EPSILON) {
    // Opposite sides are parallel (a parallelogram, e.g. a rectangle shot
    // dead-on): no perspective foreshortening, so the map is affine.
    g = 0
    h = 0
    a = tr.x - tl.x
    b = bl.x - tl.x
    c = tl.x
    d = tr.y - tl.y
    e = bl.y - tl.y
    f = tl.y
  } else {
    const det = dx1x * dx2y - dx2x * dx1y
    if (Math.abs(det) < EPSILON) return null

    g = (sx * dx2y - dx2x * sy) / det
    h = (dx1x * sy - sx * dx1y) / det

    a = tr.x - tl.x + g * tr.x
    b = bl.x - tl.x + h * bl.x
    c = tl.x
    d = tr.y - tl.y + g * tr.y
    e = bl.y - tl.y + h * bl.y
    f = tl.y
  }

  return { a, b, c, d, e, f, g, h }
}

/** Maps a unit-square point (s,t) through the homography to a source-space point. */
export function mapPoint(hom: Homography, s: number, t: number): Point {
  const denom = hom.g * s + hom.h * t + 1
  return {
    x: (hom.a * s + hom.b * t + hom.c) / denom,
    y: (hom.d * s + hom.e * t + hom.f) / denom,
  }
}

/**
 * Target size for the flattened output: the average of each pair of opposite
 * edge lengths (the quad is rarely a perfect rectangle), capped and rounded
 * by the same `scaleToFit` the rest of the pipeline uses for the long edge.
 */
export function warpOutputSize(quad: Quad): { width: number; height: number } {
  const { tl, tr, br, bl } = quad

  const topWidth = Math.hypot(tr.x - tl.x, tr.y - tl.y)
  const bottomWidth = Math.hypot(br.x - bl.x, br.y - bl.y)
  const width0 = (topWidth + bottomWidth) / 2

  const leftHeight = Math.hypot(bl.x - tl.x, bl.y - tl.y)
  const rightHeight = Math.hypot(br.x - tr.x, br.y - tr.y)
  const height0 = (leftHeight + rightHeight) / 2

  return scaleToFit(width0, height0)
}

/**
 * Samples `img` at a possibly-fractional (x,y) via bilinear interpolation,
 * clamping the coordinate to the image bounds first — so a point just
 * outside the source (from a quad corner that's a hair past the true edge)
 * reads as the nearest edge pixel rather than an out-of-bounds read.
 */
export function bilinearSample(img: GrayImage, x: number, y: number): number {
  const cx = Math.min(img.width - 1, Math.max(0, x))
  const cy = Math.min(img.height - 1, Math.max(0, y))

  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(img.width - 1, x0 + 1)
  const y1 = Math.min(img.height - 1, y0 + 1)

  const fx = cx - x0
  const fy = cy - y0

  const p00 = img.data[y0 * img.width + x0]
  const p10 = img.data[y0 * img.width + x1]
  const p01 = img.data[y1 * img.width + x0]
  const p11 = img.data[y1 * img.width + x1]

  const top = p00 * (1 - fx) + p10 * fx
  const bottom = p01 * (1 - fx) + p11 * fx
  return top * (1 - fy) + bottom * fy
}

/**
 * Perspective-flattens `quad` out of `src` into a new `out`-sized image.
 * Null if the quad is degenerate (see `rectToQuad`) or `out` is too small to
 * be a usable receipt (see `MIN_OUTPUT_DIMENSION`) — both are "detection
 * failure", the same as never having found a quad at all.
 */
export function warpGray(
  src: GrayImage,
  quad: Quad,
  out: { width: number; height: number }
): GrayImage | null {
  const hom = rectToQuad(quad)
  if (!hom) return null
  if (out.width < MIN_OUTPUT_DIMENSION || out.height < MIN_OUTPUT_DIMENSION) return null

  const data = new Uint8ClampedArray(out.width * out.height)

  // mapPoint is inlined here: an {x, y} allocation per pixel is ~2M objects
  // on a full-size warp, and this loop is the one hot path in the module.
  for (let v = 0; v < out.height; v++) {
    const t = (v + 0.5) / out.height
    for (let u = 0; u < out.width; u++) {
      const s = (u + 0.5) / out.width
      const w = hom.g * s + hom.h * t + 1
      const x = (hom.a * s + hom.b * t + hom.c) / w
      const y = (hom.d * s + hom.e * t + hom.f) / w
      data[v * out.width + u] = Math.round(bilinearSample(src, x, y))
    }
  }

  return { data, width: out.width, height: out.height }
}
