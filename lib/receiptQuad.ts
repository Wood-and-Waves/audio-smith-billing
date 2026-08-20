// Geometry shared by automatic corner detection (`receiptCorners.ts`) and
// Dan's manual handle-dragging adjuster (`CornerAdjuster.tsx`): the `Quad`
// type, a canonical ordering for four loose points, and two sanity gates.
//
// Pure and canvas-free so it's testable without a browser. Hand-rolled
// shoelace/cross-product math rather than a computational-geometry package:
// every shape here has exactly four vertices, so the general-purpose library
// would bring transitive weight for zero capability we'd actually use — the
// same reasoning that ruled out OpenCV.js/jscanify for the feature overall.
//
// Two gates, not one, because "sane" means different things to a detector and
// to a person: `quadSane` is the automatic-detection gate — it enforces an
// area FLOOR because a plausible-looking quad covering 3% of the frame is far
// more likely a false positive (a corner of the table, a shadow) than a real
// receipt shot close-up. `quadUsable` is the manual-adjuster gate — no area
// floor, because a small crop Dan drags on purpose is a deliberate choice,
// not a detector mistake, and it isn't this code's place to second-guess it.
//
// Coordinates are screen space (x right, y down). "Clockwise" throughout
// means clockwise as a person looking at the screen would see it, which is
// the direction of INCREASING atan2(dy, dx) once y grows downward.

/** A single 2D point, in whatever coordinate space the caller is using. */
export type Point = { x: number; y: number }

/** Four corners of a quadrilateral, always in clockwise order starting top-left. */
export type Quad = { tl: Point; tr: Point; br: Point; bl: Point }

/** Grayscale image plane shared by detection, warp, and contrast-stretch libs. */
export type GrayImage = { data: Uint8ClampedArray; width: number; height: number }

/**
 * Below this fraction of the frame's area, a detected quad is more likely a
 * false positive (a table corner, a shadow edge) than a receipt shot close
 * enough to fill the photo the way Dan's phone habitually frames them.
 */
export const MIN_AREA_FRACTION = 0.15

/**
 * Above this fraction of the frame's area there is no visible border left to
 * distinguish "receipt" from "background" — treat it as nothing found rather
 * than trust a quad that is essentially the whole photo.
 */
export const MAX_AREA_FRACTION = 0.98

/**
 * Fraction of the frame diagonal. Below this, two corners have collapsed
 * onto nearly the same point — a sliver, not a receipt edge — and the warp
 * that follows would divide by something close to zero.
 */
export const MIN_CORNER_GAP = 0.08

/**
 * Fraction of the unit diagonal (manual gate only, normalized 0..1 quads).
 * Smaller than MIN_CORNER_GAP because a person dragging handles by hand is
 * expected to place them close to each other on a small receipt; this only
 * catches two handles dropped on top of one another, not a tight crop.
 */
const MIN_USABLE_CORNER_GAP = 0.02

const CORNERS: Array<keyof Quad> = ['tl', 'tr', 'br', 'bl']

/**
 * Canonicalizes four loose points into a `Quad`, regardless of what order
 * they arrived in. Sorts clockwise around the centroid, then rotates the
 * cycle so the point minimizing x+y lands on `tl`. Returns null if any two
 * of the four points are exactly coincident (a caller passing pixel or
 * normalized coordinates never legitimately produces that).
 */
export function orderQuad(pts: Point[]): Quad | null {
  if (pts.length !== 4) return null

  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (pts[i].x === pts[j].x && pts[i].y === pts[j].y) return null
    }
  }

  const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length
  const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length

  // y grows downward, so increasing atan2(dy, dx) sweeps clockwise as a
  // viewer sees it: right -> bottom -> left -> top -> right.
  const sorted = [...pts].sort((a, b) => {
    const angleA = Math.atan2(a.y - cy, a.x - cx)
    const angleB = Math.atan2(b.y - cy, b.x - cx)
    return angleA - angleB
  })

  let startIndex = 0
  let minSum = sorted[0].x + sorted[0].y
  for (let i = 1; i < sorted.length; i++) {
    const sum = sorted[i].x + sorted[i].y
    if (sum < minSum) {
      minSum = sum
      startIndex = i
    }
  }

  const quad = {} as Quad
  for (let i = 0; i < 4; i++) {
    quad[CORNERS[i]] = sorted[(startIndex + i) % 4]
  }
  return quad
}

/** Shoelace area of the quad. Always non-negative, whatever the winding. */
export function quadArea(q: Quad): number {
  const pts = [q.tl, q.tr, q.br, q.bl]
  let sum = 0
  for (let i = 0; i < 4; i++) {
    const p = pts[i]
    const next = pts[(i + 1) % 4]
    sum += p.x * next.y - next.x * p.y
  }
  return Math.abs(sum) / 2
}

/**
 * True only for a strictly convex quad: every interior turn angle bends the
 * same way, and none of them is zero. Three collinear corners (a zero turn)
 * count as NOT convex — a real quad, not a degenerate triangle wearing a
 * fourth vertex. A self-crossing (bowtie) quad fails too, because its turns
 * don't all bend the same way.
 */
export function isConvex(q: Quad): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl]
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    const c = pts[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (cross === 0) return false
    const crossSign = cross > 0 ? 1 : -1
    if (sign === 0) sign = crossSign
    else if (crossSign !== sign) return false
  }
  return true
}

/** The smallest distance between any two of the four corners (all 6 pairs, not just adjacent ones). */
export function minCornerGap(q: Quad): number {
  const pts = [q.tl, q.tr, q.br, q.bl]
  let min = Infinity
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x
      const dy = pts[i].y - pts[j].y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < min) min = dist
    }
  }
  return min
}

/** Multiplies every corner's coordinates by (sx, sy) — e.g. denormalizing a 0..1 quad onto a pixel-sized image. */
export function scaleQuad(q: Quad, sx: number, sy: number): Quad {
  const scale = (p: Point): Point => ({ x: p.x * sx, y: p.y * sy })
  return { tl: scale(q.tl), tr: scale(q.tr), br: scale(q.br), bl: scale(q.bl) }
}

/** Clamps every corner's coordinates into [0, width] / [0, height]. */
export function clampQuad(q: Quad, width: number, height: number): Quad {
  const clamp = (p: Point): Point => ({
    x: Math.min(width, Math.max(0, p.x)),
    y: Math.min(height, Math.max(0, p.y)),
  })
  return { tl: clamp(q.tl), tr: clamp(q.tr), br: clamp(q.br), bl: clamp(q.bl) }
}

/**
 * The automatic-detection gate: strictly convex, area within
 * [MIN_AREA_FRACTION, MAX_AREA_FRACTION] of the frame, and no two corners
 * closer than MIN_CORNER_GAP of the frame diagonal. Any failure here means
 * "found nothing" to the caller, not "found something odd" — see the
 * detectReceiptQuad pipeline in receiptCorners.ts.
 */
export function quadSane(q: Quad, width: number, height: number): boolean {
  if (!isConvex(q)) return false

  const frameArea = width * height
  const area = quadArea(q)
  if (area < MIN_AREA_FRACTION * frameArea) return false
  if (area > MAX_AREA_FRACTION * frameArea) return false

  const diagonal = Math.sqrt(width * width + height * height)
  if (minCornerGap(q) < MIN_CORNER_GAP * diagonal) return false

  return true
}

/**
 * The manual-adjuster gate for a normalized (0..1) quad: strictly convex,
 * nonzero area (implied by convexity, checked explicitly anyway since it's
 * the gate a caller actually reasons about), and no two handles closer than
 * MIN_USABLE_CORNER_GAP of the unit diagonal. Deliberately has NO area
 * floor — a tight manual crop is Dan's call, not a defect to reject.
 */
export function quadUsable(q: Quad): boolean {
  if (!isConvex(q)) return false
  if (quadArea(q) <= 0) return false

  const unitDiagonal = Math.SQRT2
  if (minCornerGap(q) < MIN_USABLE_CORNER_GAP * unitDiagonal) return false

  return true
}
