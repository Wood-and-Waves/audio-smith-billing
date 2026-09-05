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
 * How separated the two chroma classes must be before colour is trusted to
 * tell paper from table.
 *
 * The chroma cap is NOT a constant, and an early version of this that used one
 * was wrong in a way worth recording: 32 looked right on three photos, and on
 * two others the RECEIPT'S OWN median chroma was 35 and 38 — warm light casts
 * colour onto white paper — so the cap rejected the receipt and the detector
 * lost photos it used to get. Across Dan's twenty test shots paper ranges from
 * 8 to 38 depending on the lamp, while the wood table that started all this
 * sits at 87. No single number separates those.
 *
 * So chroma is split by Otsu, exactly as luma is, and each photo calibrates
 * itself. This gate is the "is there really a split here?" check: on a receipt
 * lying on a DARK table every bright pixel is paper, there are no two classes,
 * and forcing a threshold would slice the receipt in half. Below this
 * separation the chroma gate is skipped entirely and brightness alone decides,
 * which is what that photo needs.
 *
 * The test is the UPPER TAIL, not Otsu's class separation. Separation was
 * tried first and mis-fired: on a dim shot of two receipts it reported a solid
 * split where there was only one material faintly tinted, cut into the paper,
 * and returned a fragment of one slip where luma alone had found both. The
 * gap between the median and the ninth decile says plainly whether a SECOND,
 * markedly more colourful material is present: the wood table that started
 * this reads 12 -> 87, while that dim pair reads 38 -> 47 and a photo on a
 * dark table 25 -> 29. Only the first has a table in the bright set.
 */
export const MIN_CHROMA_SPREAD = 35

export const SIBLING_AREA_RATIO = 0.5

/**
 * Fill ratio required when the quad spans more than one blob.
 *
 * A quad around two separated slips necessarily contains the gap between them,
 * so it can never reach MIN_FILL_RATIO — that gate assumes one solid sheet.
 * Kept as high as the geometry allows: his two-slip photo fills about 0.72.
 */
export const MIN_UNION_FILL_RATIO = 0.55

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

/**
 * Every connected run of paper pixels, largest first.
 *
 * `largestComponent` above is unchanged and still used when no colour is
 * available; this is its multi-blob sibling, working from a precomputed
 * boolean mask so the caller decides what "paper" means (bright, or bright AND
 * neutral) rather than baking a luma threshold in here.
 */
export function paperComponents(
  mask: Uint8Array, width: number, height: number,
): { area: number; mask: Uint8Array }[] {
  const total = width * height
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)
  const found: { area: number; mask: Uint8Array }[] = []

  for (let start = 0; start < total; start++) {
    if (visited[start] || !mask[start]) continue
    let head = 0, tail = 0
    visited[start] = 1
    queue[tail++] = start
    while (head < tail) {
      const idx = queue[head++]
      const x = idx % width
      const y = (idx - x) / width
      if (x > 0 && !visited[idx - 1] && mask[idx - 1]) { visited[idx - 1] = 1; queue[tail++] = idx - 1 }
      if (x < width - 1 && !visited[idx + 1] && mask[idx + 1]) { visited[idx + 1] = 1; queue[tail++] = idx + 1 }
      if (y > 0 && !visited[idx - width] && mask[idx - width]) { visited[idx - width] = 1; queue[tail++] = idx - width }
      if (y < height - 1 && !visited[idx + width] && mask[idx + width]) { visited[idx + width] = 1; queue[tail++] = idx + width }
    }
    const m = new Uint8Array(total)
    for (let i = 0; i < tail; i++) m[queue[i]] = 1
    found.push({ area: tail, mask: m })
  }

  return found.sort((a, b) => b.area - a.area)
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
 * Finds the receipt corners in a full-resolution photo. Pass `chroma` (per-pixel
 * max(r,g,b)-min(r,g,b), same dimensions as `gray`) to separate paper from a
 * coloured tabletop and to allow a second receipt in the same shot; omit it and
 * this behaves exactly as it always did, on luma alone.
 *
 * Or null if nothing can be found with confidence.
 * or null if nothing can be found with confidence. Runs the whole pipeline
 * (blur, Otsu, flood fill, hull, reduce, max-area quad, sanity gates) on a
 * `DETECT_MAX_EDGE` downscale for speed, then scales the winning quad back
 * up so it's returned in `gray`'s own pixel coordinates. Any pipeline step
 * failing — low contrast, no bright blob, too small/large, non-convex,
 * a hull with a corner pinched shut, a blob that doesn't fill its quad —
 * means "nothing found," never a partial or guessed result.
 */
export function detectReceiptQuad(gray: GrayImage, chroma?: GrayImage | null): Quad | null {
  const small = downscaleGray(gray, DETECT_MAX_EDGE)
  const scaleX = gray.width / small.width
  const scaleY = gray.height / small.height

  const blurred = boxBlur3(small)

  const histogram = new Array(256).fill(0)
  for (let i = 0; i < blurred.data.length; i++) histogram[blurred.data[i]]++

  const { threshold, separation } = otsu(histogram)
  if (separation < MIN_CLASS_SEPARATION) return null

  const frameArea = blurred.width * blurred.height

  // Colour is optional, and its absence is not a degraded mode — it is the
  // ORIGINAL behaviour, kept intact so every pinned test still describes what
  // this function does when handed luma alone. The multi-blob path is
  // deliberately gated on having colour too: without the chroma cap a
  // "component" is merely a bright region, and unioning bright regions on a
  // light tabletop would enthusiastically wrap the whole table.
  let combined: Uint8Array
  let paperArea: number
  let blobCount: number

  if (chroma) {
    const smallChroma = downscaleGray(chroma, DETECT_MAX_EDGE)

    // Otsu the chroma of the pixels luma already called bright. Two materials
    // in that set (neutral paper, coloured tabletop) split cleanly; one
    // material does not split at all, and the separation check below is what
    // tells the two situations apart.
    const chromaHistogram = new Array(256).fill(0)
    let brightCount = 0
    for (let i = 0; i < smallChroma.data.length; i++) {
      if (blurred.data[i] > threshold) { chromaHistogram[smallChroma.data[i]]++; brightCount++ }
    }
    // Percentiles of the bright pixels' chroma, read straight off the
    // histogram — no sorting, and no allocation proportional to the image.
    const nth = (fraction: number): number => {
      let seen = 0
      const target = brightCount * fraction
      for (let v = 0; v < 256; v++) {
        seen += chromaHistogram[v]
        if (seen >= target) return v
      }
      return 255
    }
    const spread = brightCount > 0 ? nth(0.9) - nth(0.5) : 0

    // A second, markedly more colourful material is in the bright set, so let
    // Otsu place the boundary between the two. Otherwise there is one material
    // and brightness alone decides, exactly as it always did.
    const chromaCap = spread >= MIN_CHROMA_SPREAD ? otsu(chromaHistogram).threshold : 255

    const mask = new Uint8Array(frameArea)
    for (let i = 0; i < mask.length; i++) {
      mask[i] = blurred.data[i] > threshold && smallChroma.data[i] <= chromaCap ? 1 : 0
    }

    const comps = paperComponents(mask, blurred.width, blurred.height)
    if (comps.length === 0) return null

    // The largest blob, plus any sibling of comparable size — another receipt
    // in the same shot, never a scrap of neutral clutter beside it.
    const cutoff = comps[0].area * SIBLING_AREA_RATIO
    const kept = comps.filter((c) => c.area >= cutoff)

    combined = new Uint8Array(frameArea)
    paperArea = 0
    for (const c of kept) {
      paperArea += c.area
      for (let i = 0; i < combined.length; i++) if (c.mask[i]) combined[i] = 1
    }
    blobCount = kept.length
  } else {
    const component = largestComponent(blurred, threshold)
    if (!component) return null
    combined = component.mask
    paperArea = component.area
    blobCount = 1
  }

  if (paperArea < MIN_AREA_FRACTION * frameArea) return null

  const boundary = boundaryPoints(combined, blurred.width, blurred.height)
  const hull = convexHull(boundary)
  if (hull.length < 4) return null

  const reduced = reduceHull(hull, 24)
  const quad = maxAreaQuad(reduced)
  if (!quad) return null

  if (!quadSane(quad, blurred.width, blurred.height)) return null

  // A quad drawn around two separated slips must contain the gap between them,
  // so it can never meet the single-sheet fill ratio. Each threshold applies
  // only to the shape it was derived from.
  const minFill = blobCount > 1 ? MIN_UNION_FILL_RATIO : MIN_FILL_RATIO
  if (paperArea / quadArea(quad) < minFill) return null

  return scaleQuad(quad, scaleX, scaleY)
}
