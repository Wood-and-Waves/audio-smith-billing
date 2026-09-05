// Automatic corner detection, tested entirely with synthetic images built
// right here — no fixture photos. `makeGray`/`fillQuad` paint flat regions
// with a seeded LCG for deterministic per-pixel noise, standing in for real
// photo grain without ever needing a real photo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  downscaleGray, boxBlur3, otsu, largestComponent, convexHull, reduceHull,
  maxAreaQuad, detectReceiptQuad, DETECT_MAX_EDGE, MIN_CLASS_SEPARATION,
} from '../../lib/receiptCorners.ts'
import { orderQuad, quadArea, MIN_AREA_FRACTION, type Point, type Quad, type GrayImage } from '../../lib/receiptQuad.ts'

// ---------------------------------------------------------------------------
// synthetic-image helpers
// ---------------------------------------------------------------------------

function makeGray(w: number, h: number, bg: number): GrayImage {
  const data = new Uint8ClampedArray(w * h)
  data.fill(bg)
  return { data, width: w, height: h }
}

function pointInQuad(p: Point, q: Quad): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl]
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (c === 0) continue
    const s = c > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

function fillQuad(img: GrayImage, quad: Quad, value: number): void {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (pointInQuad({ x: x + 0.5, y: y + 0.5 }, quad)) {
        img.data[y * img.width + x] = value
      }
    }
  }
}

/** Seeded LCG (Numerical Recipes constants) — deterministic, no fixtures. */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function addNoise(img: GrayImage, amplitude: number, seed: number): void {
  const rng = makeLcg(seed)
  for (let i = 0; i < img.data.length; i++) {
    const delta = Math.round((rng() * 2 - 1) * amplitude)
    img.data[i] = Math.min(255, Math.max(0, img.data[i] + delta))
  }
}

/**
 * Matches `a`'s corners against `b`'s over all 4 cyclic rotations (both
 * quads are canonically ordered by `orderQuad`, so only a rotation, never a
 * reflection, could separate them) and returns the per-corner distances for
 * the rotation with the least total error.
 */
function bestCornerDistances(a: Quad, b: Quad): number[] {
  const aPts = [a.tl, a.tr, a.br, a.bl]
  const bPts = [b.tl, b.tr, b.br, b.bl]
  let best: number[] = []
  let bestTotal = Infinity
  for (let shift = 0; shift < 4; shift++) {
    const distances = aPts.map((p, i) => {
      const q = bPts[(i + shift) % 4]
      return Math.hypot(p.x - q.x, p.y - q.y)
    })
    const total = distances.reduce((s, d) => s + d, 0)
    if (total < bestTotal) {
      bestTotal = total
      best = distances
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// downscaleGray
// ---------------------------------------------------------------------------

test('downscaleGray: exact box means on a hand-built 4x4 -> 2x2', () => {
  // Each 2x2 source block averages cleanly: TL=(0,1,4,5)/4=2.5->3 (round),
  // TR=(2,3,6,7)/4=4.5->5(round-half-away banker's? Math.round(4.5)=5),
  // BL=(8,9,12,13)/4=10.5->11(?), BR=(10,11,14,15)/4=12.5->13. Values chosen
  // so every block's mean is a clean .5 and Math.round's "round half up" is
  // unambiguous (all positive).
  const src: GrayImage = {
    data: new Uint8ClampedArray([
      0, 1, 2, 3,
      4, 5, 6, 7,
      8, 9, 10, 11,
      12, 13, 14, 15,
    ]),
    width: 4,
    height: 4,
  }
  const out = downscaleGray(src, 2)
  assert.equal(out.width, 2)
  assert.equal(out.height, 2)
  // TL block [0,1,4,5] mean=2.5->3; TR block [2,3,6,7] mean=4.5->5;
  // BL block [8,9,12,13] mean=10.5->11; BR block [10,11,14,15] mean=12.5->13
  // (Math.round rounds .5 up, so all four are unambiguous).
  assert.deepEqual(Array.from(out.data), [3, 5, 11, 13])
})

test('downscaleGray never enlarges: long edge already at or under the cap returns src unchanged', () => {
  const src = makeGray(50, 30, 100)
  assert.equal(downscaleGray(src, 50), src, 'long edge exactly at cap: same object')
  assert.equal(downscaleGray(src, 100), src, 'long edge under cap: same object')
})

test('downscaleGray caps the long edge and scales the short edge proportionally', () => {
  const src = makeGray(800, 400, 100)
  const out = downscaleGray(src, DETECT_MAX_EDGE)
  assert.equal(out.width, 400)
  assert.equal(out.height, 200)
})

// ---------------------------------------------------------------------------
// boxBlur3
// ---------------------------------------------------------------------------

test('boxBlur3 leaves a flat image unchanged', () => {
  const src = makeGray(5, 5, 77)
  const out = boxBlur3(src)
  assert.deepEqual(Array.from(out.data), Array.from(src.data))
})

test('boxBlur3 averages a single bright pixel with its clamped neighborhood', () => {
  const src = makeGray(3, 3, 0)
  src.data[4] = 90 // center pixel (1,1)
  const out = boxBlur3(src)
  // Center: all 9 neighbors exist, sum=90, count=9 -> 90/9=10.
  assert.equal(out.data[4], 10)
  // Corner (0,0): only its own 2x2 block of neighbors exist (4 pixels: (0,0)(1,0)(0,1)(1,1)),
  // and (1,1)=90 is one of them -> sum=90, count=4 -> 90/4=22.5 -> 23 (round).
  assert.equal(out.data[0], 23)
  // Edge-center (1,0): neighbors are (0,0)(1,0)(2,0)(0,1)(1,1)(2,1) -> count 6, sum 90 -> 15.
  assert.equal(out.data[1], 15)
})

// ---------------------------------------------------------------------------
// otsu
// ---------------------------------------------------------------------------

test('otsu on a flat (single-valued) histogram returns the degenerate default', () => {
  const histogram = new Array(256).fill(0)
  histogram[128] = 500
  assert.deepEqual(otsu(histogram), { threshold: 127, separation: 0 })
})

test('otsu on an empty histogram returns the degenerate default', () => {
  assert.deepEqual(otsu(new Array(256).fill(0)), { threshold: 127, separation: 0 })
})

test('otsu on a hand-built bimodal histogram lands the threshold between the modes with separation matching the gap', () => {
  const histogram = new Array(256).fill(0)
  // Symmetric clusters, so each cluster's mean is exactly its midpoint:
  // low cluster [45..55] mean=50, high cluster [195..205] mean=200, a
  // 150-level gap, with true zero counts in between (no ties from any
  // sub-cluster variation, only from the empty gap itself).
  for (let v = 45; v <= 55; v++) histogram[v] = 10
  for (let v = 195; v <= 205; v++) histogram[v] = 10

  const { threshold, separation } = otsu(histogram)
  assert.ok(threshold >= 55 && threshold < 195, `threshold ${threshold} must fall strictly between the two modes`)
  assert.equal(separation, 150)
})

// ---------------------------------------------------------------------------
// largestComponent
// ---------------------------------------------------------------------------

test('largestComponent picks the bigger of two disjoint bright blobs', () => {
  const img = makeGray(20, 10, 0)
  // Small blob: 2x2 = 4px, at (1,1)-(2,2).
  fillQuad(img, { tl: { x: 1, y: 1 }, tr: { x: 3, y: 1 }, br: { x: 3, y: 3 }, bl: { x: 1, y: 3 } }, 200)
  // Big blob: 6x6 = 36px, at (10,2)-(16,8), far enough away to stay disjoint.
  fillQuad(img, { tl: { x: 10, y: 2 }, tr: { x: 16, y: 2 }, br: { x: 16, y: 8 }, bl: { x: 10, y: 8 } }, 200)

  const result = largestComponent(img, 100)
  assert.ok(result)
  assert.equal(result!.area, 36)
  // Sanity: the mask marks pixels from the big blob, not the small one.
  assert.equal(result!.mask[2 * 20 + 12], 1, 'a big-blob pixel must be in the winning mask')
  assert.equal(result!.mask[1 * 20 + 1], 0, 'a small-blob pixel must not be in the winning mask')
})

test('largestComponent returns null when no pixel is above threshold', () => {
  const img = makeGray(10, 10, 50)
  assert.equal(largestComponent(img, 100), null)
})

// ---------------------------------------------------------------------------
// convexHull
// ---------------------------------------------------------------------------

test('convexHull of a square plus interior points returns exactly the 4 corners', () => {
  const points: Point[] = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    { x: 5, y: 5 }, { x: 3, y: 7 }, { x: 8, y: 2 }, { x: 1, y: 1 },
  ]
  const hull = convexHull(points)
  assert.equal(hull.length, 4)
  const asSet = new Set(hull.map((p) => `${p.x},${p.y}`))
  assert.equal(asSet.size, 4, 'no duplicated endpoint')
  for (const corner of [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]) {
    assert.ok(asSet.has(`${corner.x},${corner.y}`), `hull must include corner (${corner.x},${corner.y})`)
  }
})

// ---------------------------------------------------------------------------
// reduceHull
// ---------------------------------------------------------------------------

test('reduceHull: a 12-gon around a quad reduces to exactly the 4 dominant corners', () => {
  const corners: Point[] = [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 60 }, { x: 0, y: 60 }]
  const twelveGon: Point[] = []
  for (let i = 0; i < 4; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % 4]
    twelveGon.push(a)
    twelveGon.push({ x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 })
    twelveGon.push({ x: a.x + ((b.x - a.x) * 2) / 3, y: a.y + ((b.y - a.y) * 2) / 3 })
  }
  assert.equal(twelveGon.length, 12, 'sanity: construction produced a 12-gon')

  const reduced = reduceHull(twelveGon, 4)
  assert.equal(reduced.length, 4)
  const asSet = new Set(reduced.map((p) => `${p.x},${p.y}`))
  for (const corner of corners) {
    assert.ok(asSet.has(`${corner.x},${corner.y}`), `reduced hull must keep corner (${corner.x},${corner.y})`)
  }
})

test('reduceHull is a no-op when the hull is already within the vertex budget', () => {
  const hull: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
  assert.deepEqual(reduceHull(hull, 24), hull)
})

// ---------------------------------------------------------------------------
// maxAreaQuad
// ---------------------------------------------------------------------------

test('maxAreaQuad picks the 4 extreme corners over interior-ish midpoint decoys', () => {
  const corners: Point[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }]
  // Decoys sit just inside the hull, near (but not on) two of the edges --
  // including one would always cede area to keeping the true corner instead.
  const decoys: Point[] = [{ x: 50, y: 5 }, { x: 95, y: 40 }]
  const hull = [corners[0], decoys[0], corners[1], decoys[1], corners[2], corners[3]]

  const quad = maxAreaQuad(hull)
  assert.ok(quad)
  assert.deepEqual(quad, orderQuad(corners))
})

test('maxAreaQuad returns null for a hull with fewer than 4 points', () => {
  assert.equal(maxAreaQuad([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]), null)
})

// ---------------------------------------------------------------------------
// detectReceiptQuad
// ---------------------------------------------------------------------------

const WIDTH = 300
const HEIGHT = 400
const BG = 40
const RECEIPT = 230
const NOISE = 8

// A plausible perspective quad: comfortably inset, well within the
// MIN_AREA_FRACTION..MAX_AREA_FRACTION band, no pinched corners.
const GROUND_TRUTH: Quad = {
  tl: { x: 60, y: 50 },
  tr: { x: 255, y: 70 },
  br: { x: 235, y: 370 },
  bl: { x: 40, y: 340 },
}

test('detectReceiptQuad finds a noisy perspective quad within 3px per corner', () => {
  const img = makeGray(WIDTH, HEIGHT, BG)
  fillQuad(img, GROUND_TRUTH, RECEIPT)
  addNoise(img, NOISE, 12345)

  const result = detectReceiptQuad(img)
  assert.ok(result, 'a clear high-contrast quad must be detected')

  const distances = bestCornerDistances(result!, GROUND_TRUTH)
  for (const [i, d] of distances.entries()) {
    assert.ok(d <= 3, `corner ${i} off by ${d}px (must be <= 3px)`)
  }
})

test('detectReceiptQuad rejects a flat image (no contrast at all)', () => {
  const img = makeGray(WIDTH, HEIGHT, 128)
  assert.equal(detectReceiptQuad(img), null)
})

test('detectReceiptQuad rejects low contrast under MIN_CLASS_SEPARATION', () => {
  const img = makeGray(WIDTH, HEIGHT, 120)
  fillQuad(img, GROUND_TRUTH, 135) // gap of 15, under the 24 threshold
  assert.ok(135 - 120 < MIN_CLASS_SEPARATION, 'sanity: this gap is meant to be too small')
  assert.equal(detectReceiptQuad(img), null)
})

test('detectReceiptQuad rejects a tiny quad (~5% of frame area)', () => {
  const img = makeGray(WIDTH, HEIGHT, BG)
  // ~15x20 = 300px out of 120000 = 0.25%, well under the 15% floor -- sized
  // generously small so downscale/blur rounding can't accidentally cross it.
  const tiny: Quad = { tl: { x: 140, y: 190 }, tr: { x: 160, y: 190 }, br: { x: 160, y: 210 }, bl: { x: 140, y: 210 } }
  fillQuad(img, tiny, RECEIPT)
  assert.ok(quadArea(tiny) < MIN_AREA_FRACTION * WIDTH * HEIGHT, 'sanity: area is under the floor')
  assert.equal(detectReceiptQuad(img), null)
})

test('detectReceiptQuad rejects a near-full-frame quad (~99%)', () => {
  // A plain full-frame rectangle inset by only 1px doesn't work here: the
  // 3x3 blur rounds its corners just enough that the best-fit quad settles
  // a bit under the 98% ceiling (verified empirically -- a uniform 1px
  // inset on this pipeline tops out around 97.5%, since any thinner border
  // collapses Otsu separation to 0). Instead, keep the image bright at all
  // four TRUE corners (nothing to round there) and cut small dark notches
  // into the middle of each edge for contrast -- the corners stay sharp,
  // the blob's convex hull still lands on the four actual image corners,
  // and the resulting quad covers essentially the whole frame.
  const img = makeGray(WIDTH, HEIGHT, RECEIPT)
  const notch = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) img.data[y * WIDTH + x] = BG
    }
  }
  notch(WIDTH / 2 - 20, 0, 40, 10) // top edge
  notch(WIDTH / 2 - 20, HEIGHT - 10, 40, 10) // bottom edge
  notch(0, HEIGHT / 2 - 20, 10, 40) // left edge
  notch(WIDTH - 10, HEIGHT / 2 - 20, 10, 40) // right edge

  const result = detectReceiptQuad(img)
  assert.equal(result, null)
})

test('detectReceiptQuad rejects an L-shaped union of two overlapping rectangles (fill-ratio gate)', () => {
  const img = makeGray(WIDTH, HEIGHT, BG)
  // A big vertical bar and a big horizontal bar overlapping only at one
  // corner -- the union is a clear "L," and its convex hull (a near
  // rectangle spanning both arms) encloses a large empty notch that the
  // filled pixels never touch, so the blob fills well under 80% of it.
  const vertical: Quad = { tl: { x: 40, y: 40 }, tr: { x: 110, y: 40 }, br: { x: 110, y: 360 }, bl: { x: 40, y: 360 } }
  const horizontal: Quad = { tl: { x: 40, y: 40 }, tr: { x: 260, y: 40 }, br: { x: 260, y: 110 }, bl: { x: 40, y: 110 } }
  fillQuad(img, vertical, RECEIPT)
  fillQuad(img, horizontal, RECEIPT)
  assert.equal(detectReceiptQuad(img), null)
})

test('detectReceiptQuad still hulls correctly when the receipt runs off the right edge of the frame', () => {
  // The right corners fall outside the frame entirely, so that edge of the
  // blob has no background pixel to transition against -- it's simply cut
  // off by the image bounds. If boundaryPoints only counted pixels with a
  // background NEIGHBOR (missing the `onBorder` check), this edge would
  // contribute no boundary points at all and the hull would collapse.
  const img = makeGray(WIDTH, HEIGHT, BG)
  const offFrame: Quad = {
    tl: { x: 40, y: 60 }, tr: { x: 340, y: 40 }, br: { x: 340, y: 360 }, bl: { x: 40, y: 340 },
  }
  fillQuad(img, offFrame, RECEIPT)

  const result = detectReceiptQuad(img)
  assert.ok(result, 'a blob clipped by the frame edge must still produce a quad')
  assert.ok(result!.tr.x >= WIDTH - 2, 'the clipped right edge must hug the frame boundary')
  assert.ok(result!.br.x >= WIDTH - 2, 'the clipped right edge must hug the frame boundary')
})

test('detectReceiptQuad rejects a thin sliver quad (corner-gap gate via quadSane)', () => {
  const img = makeGray(WIDTH, HEIGHT, BG)
  // A long, large-area quad that tapers to an 8px-wide tip -- well under
  // MIN_CORNER_GAP (0.08 * diagonal(300,400)=500 -> 40px) at that end,
  // while total area easily clears MIN_AREA_FRACTION.
  const sliver: Quad = {
    tl: { x: 140, y: 40 }, tr: { x: 148, y: 40 }, br: { x: 280, y: 360 }, bl: { x: 20, y: 360 },
  }
  fillQuad(img, sliver, RECEIPT)
  assert.equal(detectReceiptQuad(img), null)
})

// ---------------------------------------------------------------------------
// colour: telling paper from a tabletop of the same brightness
// ---------------------------------------------------------------------------
//
// The failure these cover, in Dan's words (2026-08-27): "The corner tool is
// pretty good, but this does happen more than I like." A receipt on warm wood
// under one lamp — Otsu on luma splits the photo into lit and shadowed, not
// paper and table, and the flood fill runs off the receipt across the whole
// tabletop. Measured on his own photos, the wood's chroma sits near 87 while
// the receipt's sits near 12.

/** A flat plane, `bg` everywhere, `fg` inside the rect. Used for both planes. */
function planeWithRect(
  w: number, h: number, bg: number, fg: number,
  x0: number, y0: number, x1: number, y1: number,
): GrayImage {
  const img = makeGray(w, h, bg)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) img.data[y * w + x] = fg
  }
  return img
}

function paintRect(
  img: GrayImage, v: number, x0: number, y0: number, x1: number, y1: number,
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) img.data[y * img.width + x] = v
  }
}

test('a bright receipt on an EQUALLY BRIGHT but coloured table is found only with chroma', () => {
  // Both materials at luma 210: nothing in the luma plane distinguishes them,
  // which is exactly the hotel-table case. Chroma does — and the table's colour
  // VARIES, as real wood grain does, because a flat value would put its median
  // and ninth decile together and hide the second material from the spread
  // test. Proportions mirror his real photos: the receipt is the larger share
  // of the bright pixels, the table the rest.
  const w = 200, h = 260
  const gray = makeGray(w, h, 30)
  paintRect(gray, 210, 20, 20, 180, 240)      // the "table", bright
  paintRect(gray, 210, 45, 30, 155, 235)      // the receipt, equally bright

  const chroma = makeGray(w, h, 0)
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let y = 20; y < 240; y++) {
    for (let x = 20; x < 180; x++) chroma.data[y * w + x] = 60 + Math.floor(rnd() * 60)
  }
  paintRect(chroma, 10, 45, 30, 155, 235)     // neutral paper

  const withoutColour = detectReceiptQuad(gray)
  const withColour = detectReceiptQuad(gray, chroma)
  assert.ok(withColour, 'colour finds a quad')
  assert.ok(withoutColour, 'and so does luma alone — it just finds the wrong thing')
  assert.ok(
    quadArea(withColour!) < quadArea(withoutColour!),
    `colour should wrap the receipt, not the table (${quadArea(withColour!)} vs ${quadArea(withoutColour!)})`,
  )
})

test('KNOWN LIMIT: a tabletop that dwarfs the receipt is not separated by colour', () => {
  // Documented, not aspirational. The spread test compares the median of the
  // bright pixels' chroma with their ninth decile, so it needs the receipt to
  // be a real share of what is bright. Frame a small receipt against a huge
  // expanse of table and the median falls inside the TABLE's own range, the
  // gap shrinks below MIN_CHROMA_SPREAD, and detection falls back to
  // brightness alone — which is the old behaviour, not a crash.
  //
  // All twenty of Dan's real photos clear this comfortably (he fills the frame
  // with the receipt); it is recorded so the next person measures before
  // assuming colour always rescues a wood table.
  const w = 200, h = 260
  const gray = makeGray(w, h, 30)
  paintRect(gray, 210, 10, 10, 190, 250)      // table fills nearly everything
  paintRect(gray, 210, 85, 110, 115, 160)     // a small receipt

  const chroma = makeGray(w, h, 0)
  let seed = 999
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let y = 10; y < 250; y++) {
    for (let x = 10; x < 190; x++) chroma.data[y * w + x] = 60 + Math.floor(rnd() * 60)
  }
  paintRect(chroma, 10, 85, 110, 115, 160)

  assert.deepEqual(
    detectReceiptQuad(gray, chroma),
    detectReceiptQuad(gray),
    'colour changes nothing here — the fallback is the old behaviour',
  )
})

test('two separated receipts of similar size are spanned together', () => {
  // His restaurant bill: itemised check and signed slip, apart on a dark
  // table. They are two components, and taking only the larger loses one.
  const w = 240, h = 240
  const gray = makeGray(w, h, 20)
  paintRect(gray, 220, 20, 30, 100, 210)
  paintRect(gray, 220, 140, 30, 220, 210)
  const chroma = makeGray(w, h, 0)

  const quad = detectReceiptQuad(gray, chroma)
  assert.ok(quad, 'a quad is found')
  const pts = [quad!.tl, quad!.tr, quad!.br, quad!.bl]
  const minX = Math.min(...pts.map((p) => p.x))
  const maxX = Math.max(...pts.map((p) => p.x))
  assert.ok(minX < 40, `spans the left slip (minX ${minX})`)
  assert.ok(maxX > 200, `and the right one (maxX ${maxX})`)
})

test('a small neutral scrap beside the receipt is NOT swept in', () => {
  // The same wood photo has a grey card beside the receipt, and grey is as
  // neutral as paper. Size is what separates a second receipt from clutter.
  const w = 240, h = 240
  const gray = makeGray(w, h, 20)
  paintRect(gray, 220, 20, 20, 120, 220)     // the receipt
  paintRect(gray, 220, 200, 100, 230, 130)   // a small scrap, far right
  const chroma = makeGray(w, h, 0)

  const quad = detectReceiptQuad(gray, chroma)
  assert.ok(quad, 'a quad is found')
  const maxX = Math.max(...[quad!.tl, quad!.tr, quad!.br, quad!.bl].map((p) => p.x))
  assert.ok(maxX < 170, `stops at the receipt, not the scrap (maxX ${maxX})`)
})

test('uniform chroma changes nothing — one material means brightness decides', () => {
  // A receipt on a DARK table: every bright pixel is paper, there is no second
  // class, and forcing a chroma threshold would slice the receipt in half.
  const w = 200, h = 200
  const gray = makeGray(w, h, 25)
  paintRect(gray, 215, 50, 40, 150, 170)
  const flat = makeGray(w, h, 24)   // some colour cast, but only one material

  const a = detectReceiptQuad(gray)
  const b = detectReceiptQuad(gray, flat)
  assert.ok(a && b)
  assert.deepEqual(b, a, 'identical to the luma-only result')
})
