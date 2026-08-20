// Automatic corner detection: given a full grayscale photo, find the four
// corners of the receipt in it, or decide none can be found with confidence.
// Pure and canvas-free like `receiptQuad.ts`/`receiptWarp.ts` — testable with
// synthetic images built in-test, no fixtures.
//
// The pipeline: downscale for speed -> blur to suppress paper texture and
// JPEG noise -> Otsu-threshold into "receipt" (bright) vs "table" (dark) ->
// flood-fill the largest bright blob -> convex hull of its boundary ->
// reduce the hull to a manageable vertex count -> exhaustively choose the 4
// hull vertices that maximize enclosed area. Every step is deterministic:
// same input, same output, no RNG and no iteration limit to tune.
//
// Rejected: simplifying the hull with Douglas-Peucker at a tuned epsilon —
// the textbook way to turn "here's a blob outline" into "here's its 4
// corners." It needs a distance threshold hand-picked against the downscale
// resolution, and it does NOT guarantee exactly 4 output points — a noisy
// edge can leave 5, or leave 3, pushing the tuning problem onto whatever
// consumes its output. The exhaustive max-area-quad search below has no
// epsilon to tune, always returns exactly 4 points once the hull has >= 4,
// and directly optimizes the property that actually matters (the quad most
// likely to BE the receipt is the one enclosing the most area) — affordable
// because `reduceHull` caps the hull at 24 vertices first, and
// C(24,4) = 10,626 evaluations is nothing next to the flood fill before it.

import {
  type Point, type Quad, type GrayImage,
  orderQuad, quadArea, quadSane, scaleQuad, MIN_AREA_FRACTION,
} from './receiptQuad.ts'

/**
 * Detection runs on a copy downscaled to this long edge — geometry only
 * needs a coarse outline, and this keeps the flood-fill/hull/max-area-quad
 * search cheap regardless of the source photo's resolution.
 */
export const DETECT_MAX_EDGE = 400

/**
 * Otsu class means (0-255 luminance) closer together than this mean no
 * reliable receipt/background contrast — mirrors `receiptImage.ts`'s
 * MIN_SPAN=16, but larger, because the 3x3 blur that runs before Otsu here
 * compresses contrast further than a raw per-pixel histogram does.
 */
export const MIN_CLASS_SEPARATION = 24

/**
 * The detected blob must occupy at least this fraction of its own
 * max-area quad — catches merged blobs and L-shapes (two overlapping
 * bright regions) whose convex hull is much bigger than the actual
 * receipt silhouette.
 */
export const MIN_FILL_RATIO = 0.8

/**
 * Box-averages `src` down so its long edge is at most `maxEdge`. Never
 * enlarges: if the long edge is already within the cap, returns `src`
 * unchanged. Each destination pixel is the mean of the (possibly
 * multi-pixel) block of source pixels that maps onto it — same
 * never-zero-dimension spirit as `scaleToFit` in `receiptImage.ts`.
 */
export function downscaleGray(src: GrayImage, maxEdge: number): GrayImage {
  const longEdge = Math.max(src.width, src.height)
  if (longEdge <= maxEdge) return src

  const scale = maxEdge / longEdge
  const width = Math.max(1, Math.round(src.width * scale))
  const height = Math.max(1, Math.round(src.height * scale))

  const data = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y++) {
    const srcY0 = Math.floor((y * src.height) / height)
    const srcY1 = Math.max(srcY0 + 1, Math.floor(((y + 1) * src.height) / height))
    for (let x = 0; x < width; x++) {
      const srcX0 = Math.floor((x * src.width) / width)
      const srcX1 = Math.max(srcX0 + 1, Math.floor(((x + 1) * src.width) / width))

      let sum = 0
      let count = 0
      for (let sy = srcY0; sy < srcY1; sy++) {
        for (let sx = srcX0; sx < srcX1; sx++) {
          sum += src.data[sy * src.width + sx]
          count++
        }
      }
      data[y * width + x] = Math.round(sum / count)
    }
  }
  return { data, width, height }
}

/**
 * A 3x3 box blur. Edge and corner pixels use a clamped (smaller)
 * neighborhood — averaged only over the neighbors that actually exist —
 * rather than reading past the image bounds or wrapping.
 */
export function boxBlur3(img: GrayImage): GrayImage {
  const { width, height, data } = img
  const out = new Uint8ClampedArray(width * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          sum += data[ny * width + nx]
          count++
        }
      }
      out[y * width + x] = Math.round(sum / count)
    }
  }
  return { data: out, width, height }
}

/**
 * Classic Otsu's method: the threshold `t` splitting `histogram` into
 * "at or below t" / "above t" that maximizes between-class variance.
 * `separation` is the absolute difference between the two classes' means
 * at that split, a direct measure of how confidently bimodal the image is.
 * An empty or single-valued histogram (no split possible) returns
 * `{ threshold: 127, separation: 0 }`.
 */
export function otsu(histogram: number[]): { threshold: number; separation: number } {
  const total = histogram.reduce((a, b) => a + b, 0)
  if (total === 0) return { threshold: 127, separation: 0 }

  let sumAll = 0
  for (let v = 0; v < histogram.length; v++) sumAll += v * histogram[v]

  let weightBelow = 0
  let sumBelow = 0
  let bestVariance = -1
  let bestThreshold = 127
  let bestSeparation = 0

  for (let t = 0; t < histogram.length; t++) {
    weightBelow += histogram[t]
    if (weightBelow === 0) continue

    const weightAbove = total - weightBelow
    if (weightAbove === 0) break

    sumBelow += t * histogram[t]
    const meanBelow = sumBelow / weightBelow
    const meanAbove = (sumAll - sumBelow) / weightAbove

    const variance = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2
    if (variance > bestVariance) {
      bestVariance = variance
      bestThreshold = t
      bestSeparation = Math.abs(meanAbove - meanBelow)
    }
  }

  if (bestVariance <= 0) return { threshold: 127, separation: 0 }
  return { threshold: bestThreshold, separation: bestSeparation }
}

/**
 * The largest 4-connected component of pixels strictly brighter than
 * `threshold`, found via iterative BFS with an explicit queue (recursion
 * would blow the stack on a ~120k-pixel downscaled image). Returns the
 * component's pixel area and a full-image mask (1 = in component, 0
 * otherwise); null when no pixel qualifies at all.
 */
export function largestComponent(img: GrayImage, threshold: number): { area: number; mask: Uint8Array } | null {
  const { width, height, data } = img
  const total = width * height
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)

  let bestArea = 0
  let bestMask: Uint8Array | null = null

  for (let start = 0; start < total; start++) {
    if (visited[start] || data[start] <= threshold) continue

    let head = 0
    let tail = 0
    visited[start] = 1
    queue[tail++] = start

    while (head < tail) {
      const idx = queue[head++]
      const x = idx % width
      const y = (idx - x) / width

      if (x > 0 && !visited[idx - 1] && data[idx - 1] > threshold) {
        visited[idx - 1] = 1
        queue[tail++] = idx - 1
      }
      if (x < width - 1 && !visited[idx + 1] && data[idx + 1] > threshold) {
        visited[idx + 1] = 1
        queue[tail++] = idx + 1
      }
      if (y > 0 && !visited[idx - width] && data[idx - width] > threshold) {
        visited[idx - width] = 1
        queue[tail++] = idx - width
      }
      if (y < height - 1 && !visited[idx + width] && data[idx + width] > threshold) {
        visited[idx + width] = 1
        queue[tail++] = idx + width
      }
    }

    if (tail > bestArea) {
      bestArea = tail
      const mask = new Uint8Array(total)
      for (let i = 0; i < tail; i++) mask[queue[i]] = 1
      bestMask = mask
    }
  }

  if (!bestMask) return null
  return { area: bestArea, mask: bestMask }
}

/** Twice the signed area of the turn at `b` going a -> b -> c; sign gives turn direction. */
function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/**
 * Andrew's monotone chain: the convex hull of `points`, with no duplicated
 * endpoint. Points strictly on a hull edge (collinear with their
 * neighbors) are dropped, leaving only true extreme points.
 *
 * Returned order is clockwise as a viewer sees the screen (x right, y
 * down) — the same sense `Quad`'s tl->tr->br->bl walk uses — though the
 * starting point is whichever the x/y sort happens to reach first, not
 * necessarily the top-left corner.
 */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return [...points]

  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)

  const lower: Point[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }

  const upper: Point[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }

  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/**
 * Shrinks `hull` to at most `maxVertices` points by repeatedly deleting
 * the vertex whose triangle with its current (post-deletion) neighbors has
 * the least area — the point contributing the least to the hull's shape.
 * Order is preserved. Recomputes every triangle's area from scratch on
 * each pass, so a removal is always judged against the neighbors it
 * actually has left, not stale ones from before the previous deletion.
 */
export function reduceHull(hull: Point[], maxVertices: number): Point[] {
  const pts = [...hull]

  while (pts.length > maxVertices) {
    const n = pts.length
    let minArea = Infinity
    let minIndex = 0

    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n]
      const v = pts[i]
      const next = pts[(i + 1) % n]
      const area = Math.abs(cross(prev, v, next)) / 2
      if (area < minArea) {
        minArea = area
        minIndex = i
      }
    }

    pts.splice(minIndex, 1)
  }

  return pts
}

/** Shoelace area of an arbitrary (already ordered, non-self-crossing) point cycle. */
function cycleArea(pts: Point[]): number {
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const next = pts[(i + 1) % pts.length]
    sum += p.x * next.y - next.x * p.y
  }
  return Math.abs(sum) / 2
}

/**
 * The 4 vertices of `hull` (which must already be in hull/perimeter
 * order) that enclose the most area, exhaustively: with hull capped at 24
 * vertices by `reduceHull`, that's C(24,4) = 10,626 evaluations — cheap,
 * deterministic, no epsilon. Any 4 points taken in their hull-cyclic order
 * form a valid (non-self-crossing) quad, so the winning 4 are simply
 * canonicalized with `orderQuad`. Null if `hull` has fewer than 4 points.
 */
export function maxAreaQuad(hull: Point[]): Quad | null {
  const n = hull.length
  if (n < 4) return null

  let bestArea = -1
  let bestPts: Point[] | null = null

  for (let i = 0; i < n - 3; i++) {
    for (let j = i + 1; j < n - 2; j++) {
      for (let k = j + 1; k < n - 1; k++) {
        for (let l = k + 1; l < n; l++) {
          const pts = [hull[i], hull[j], hull[k], hull[l]]
          const area = cycleArea(pts)
          if (area > bestArea) {
            bestArea = area
            bestPts = pts
          }
        }
      }
    }
  }

  return bestPts ? orderQuad(bestPts) : null
}

/** Pixels of `mask` that touch a non-component neighbor or the image edge — the component's outline. */
function boundaryPoints(mask: Uint8Array, width: number, height: number): Point[] {
  const points: Point[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (!mask[idx]) continue

      const onBorder = x === 0 || x === width - 1 || y === 0 || y === height - 1
      const hasBackgroundNeighbor =
        (x > 0 && !mask[idx - 1]) ||
        (x < width - 1 && !mask[idx + 1]) ||
        (y > 0 && !mask[idx - width]) ||
        (y < height - 1 && !mask[idx + width])

      if (onBorder || hasBackgroundNeighbor) points.push({ x, y })
    }
  }
  return points
}

/**
 * Finds the receipt's four corners in a full-resolution grayscale photo,
 * or null if nothing can be found with confidence. Runs the whole pipeline
 * (blur, Otsu, flood fill, hull, reduce, max-area quad, sanity gates) on a
 * `DETECT_MAX_EDGE` downscale for speed, then scales the winning quad back
 * up so it's returned in `gray`'s own pixel coordinates. Any pipeline step
 * failing — low contrast, no bright blob, too small/large, non-convex,
 * a hull with a corner pinched shut, a blob that doesn't fill its quad —
 * means "nothing found," never a partial or guessed result.
 */
export function detectReceiptQuad(gray: GrayImage): Quad | null {
  const small = downscaleGray(gray, DETECT_MAX_EDGE)
  const scaleX = gray.width / small.width
  const scaleY = gray.height / small.height

  const blurred = boxBlur3(small)

  const histogram = new Array(256).fill(0)
  for (let i = 0; i < blurred.data.length; i++) histogram[blurred.data[i]]++

  const { threshold, separation } = otsu(histogram)
  if (separation < MIN_CLASS_SEPARATION) return null

  const component = largestComponent(blurred, threshold)
  if (!component) return null

  const frameArea = blurred.width * blurred.height
  if (component.area < MIN_AREA_FRACTION * frameArea) return null

  const boundary = boundaryPoints(component.mask, blurred.width, blurred.height)
  const hull = convexHull(boundary)
  if (hull.length < 4) return null

  const reduced = reduceHull(hull, 24)
  const quad = maxAreaQuad(reduced)
  if (!quad) return null

  if (!quadSane(quad, blurred.width, blurred.height)) return null
  if (component.area / quadArea(quad) < MIN_FILL_RATIO) return null

  return scaleQuad(quad, scaleX, scaleY)
}
