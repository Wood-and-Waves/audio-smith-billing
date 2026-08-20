// The homography + resampling behind perspective flattening, separated from
// canvas/photo I/O so it's testable with synthetic images. No fixtures —
// every source image below is built in-test, and every expected value is
// either hand-computed or derived from the library's own `rectToQuad`/
// `mapPoint` (legitimate here: those tests below check EXACT corner mapping
// against hand values first, so reusing them afterward to build the expected
// grid for `warpGray` tests is checking a different property — that the
// resample loop actually walks the homography it was given).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rectToQuad, mapPoint, warpOutputSize, bilinearSample, warpGray,
  type Homography,
} from '../../lib/receiptWarp.ts'
import { scaleToFit, MAX_EDGE } from '../../lib/receiptImage.ts'
import type { Quad, GrayImage } from '../../lib/receiptQuad.ts'

const CORNER_EPSILON = 1e-9

// ---------------------------------------------------------------------------
// rectToQuad + mapPoint
// ---------------------------------------------------------------------------

test('rectToQuad+mapPoint: a genuinely perspective quad maps all four unit corners exactly', () => {
  const quad: Quad = {
    tl: { x: 10, y: 20 }, tr: { x: 300, y: 5 }, br: { x: 280, y: 250 }, bl: { x: 0, y: 200 },
  }
  const hom = rectToQuad(quad)
  assert.ok(hom, 'a well-formed perspective quad must produce a homography')

  // Genuinely perspective: opposite-edge sums differ, so the perspective
  // terms are not both zero.
  assert.notEqual(hom!.g === 0 && hom!.h === 0, true, 'sanity: this quad must exercise the perspective branch')

  for (const [label, s, t, expected] of [
    ['tl', 0, 0, quad.tl], ['tr', 1, 0, quad.tr], ['br', 1, 1, quad.br], ['bl', 0, 1, quad.bl],
  ] as const) {
    const mapped = mapPoint(hom!, s, t)
    assert.ok(Math.abs(mapped.x - expected.x) < CORNER_EPSILON, `${label}.x: got ${mapped.x}, want ${expected.x}`)
    assert.ok(Math.abs(mapped.y - expected.y) < CORNER_EPSILON, `${label}.y: got ${mapped.y}, want ${expected.y}`)
  }
})

test('rectToQuad+mapPoint: a pure parallelogram exercises the affine branch (g===0, h===0)', () => {
  // tl+br === tr+bl (both (120,120)), the parallelogram condition — a photo
  // of a rectangle shot dead-on, just rotated/skewed, has no vanishing point.
  const quad: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 100, y: 20 }, br: { x: 120, y: 120 }, bl: { x: 20, y: 100 },
  }
  const hom = rectToQuad(quad)
  assert.ok(hom, 'a well-formed parallelogram quad must produce a homography')
  assert.equal(hom!.g, 0, 'affine branch must not fabricate a perspective term')
  assert.equal(hom!.h, 0, 'affine branch must not fabricate a perspective term')

  for (const [label, s, t, expected] of [
    ['tl', 0, 0, quad.tl], ['tr', 1, 0, quad.tr], ['br', 1, 1, quad.br], ['bl', 0, 1, quad.bl],
  ] as const) {
    const mapped = mapPoint(hom!, s, t)
    assert.ok(Math.abs(mapped.x - expected.x) < CORNER_EPSILON, `${label}.x: got ${mapped.x}, want ${expected.x}`)
    assert.ok(Math.abs(mapped.y - expected.y) < CORNER_EPSILON, `${label}.y: got ${mapped.y}, want ${expected.y}`)
  }
})

test('rectToQuad returns null for a degenerate quad (three collinear corners)', () => {
  // tr, br, bl all sit on y=0 — br lies on the line through tr and bl, which
  // is exactly the configuration that collapses the 2x2 solve's determinant.
  const degenerate: Quad = {
    tl: { x: 0, y: 10 }, tr: { x: 10, y: 0 }, br: { x: 20, y: 0 }, bl: { x: 30, y: 0 },
  }
  assert.equal(rectToQuad(degenerate), null)
})

// ---------------------------------------------------------------------------
// warpOutputSize
// ---------------------------------------------------------------------------

test('warpOutputSize averages each pair of opposite edges before scaling', () => {
  // Top edge 90 (horizontal), bottom edge 120 (horizontal) -> avg width 105.
  // Left edge 40 (vertical), right edge is a 30-40-50 triangle -> 50, avg
  // height 45. Both pairs are deliberately unequal so the test would fail if
  // the implementation used just one edge instead of averaging.
  const quad: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 90, y: 0 }, br: { x: 120, y: 40 }, bl: { x: 0, y: 40 },
  }
  const expected = scaleToFit(105, 45)
  assert.deepEqual(warpOutputSize(quad), expected)
  assert.deepEqual(expected, { width: 105, height: 45 }, 'sanity: within the cap, unscaled')
})

test('warpOutputSize caps a huge quad so the long edge lands at MAX_EDGE', () => {
  // Same shape as above, scaled 20x: avg width 2100, avg height 900.
  const quad: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 1800, y: 0 }, br: { x: 2400, y: 800 }, bl: { x: 0, y: 800 },
  }
  const result = warpOutputSize(quad)
  assert.deepEqual(result, scaleToFit(2100, 900))
  assert.equal(result.width, MAX_EDGE, 'the long edge (width) must be capped')
  assert.ok(result.height < MAX_EDGE, 'the short edge must scale down proportionally, not stay uncapped')
})

test('warpOutputSize never enlarges a small quad', () => {
  const quad: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 10, y: 0 }, br: { x: 10, y: 8 }, bl: { x: 0, y: 8 },
  }
  assert.deepEqual(warpOutputSize(quad), { width: 10, height: 8 })
})

// ---------------------------------------------------------------------------
// bilinearSample
// ---------------------------------------------------------------------------

const SAMPLE_IMG: GrayImage = {
  data: new Uint8ClampedArray([10, 20, 40, 80]), // (0,0)=10 (1,0)=20 (0,1)=40 (1,1)=80
  width: 2,
  height: 2,
}

test('bilinearSample is exact on integer coordinates', () => {
  assert.equal(bilinearSample(SAMPLE_IMG, 0, 0), 10)
  assert.equal(bilinearSample(SAMPLE_IMG, 1, 0), 20)
  assert.equal(bilinearSample(SAMPLE_IMG, 0, 1), 40)
  assert.equal(bilinearSample(SAMPLE_IMG, 1, 1), 80)
})

test('bilinearSample interpolates correctly at hand-computed midpoints', () => {
  assert.equal(bilinearSample(SAMPLE_IMG, 0.5, 0), 15, 'avg of top row (10,20)')
  assert.equal(bilinearSample(SAMPLE_IMG, 0, 0.5), 25, 'avg of left column (10,40)')
  assert.equal(bilinearSample(SAMPLE_IMG, 0.5, 0.5), 37.5, 'avg of all four corners')
})

test('bilinearSample clamps beyond the image edges rather than reading out of bounds', () => {
  assert.equal(bilinearSample(SAMPLE_IMG, -10, -10), 10, 'clamps to (0,0)')
  assert.equal(bilinearSample(SAMPLE_IMG, 100, 100), 80, 'clamps to (1,1)')
  assert.equal(bilinearSample(SAMPLE_IMG, -5, 0.5), 25, 'x clamps to 0, y midpoint unaffected')
})

// ---------------------------------------------------------------------------
// warpGray
// ---------------------------------------------------------------------------

function makeRampGray(width: number, height: number): GrayImage {
  // value = x everywhere, clamped -- but width-1 <= 255 so no clamping ever
  // actually triggers, keeping the field a genuine linear function of x with
  // no floor/ceiling to trip the "exact on linear fields" property below.
  const data = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = Math.min(255, x)
  }
  return { data, width, height }
}

test('warpGray on a linear ramp matches the homography-mapped x exactly (bilinear is exact on linear fields)', () => {
  const src = makeRampGray(200, 150)
  const quad: Quad = {
    tl: { x: 10, y: 20 }, tr: { x: 190, y: 5 }, br: { x: 180, y: 140 }, bl: { x: 5, y: 130 },
  }
  const hom = rectToQuad(quad) as Homography
  assert.ok(hom, 'sanity: this quad must not be degenerate')

  const out = { width: 120, height: 90 }
  const warped = warpGray(src, quad, out)
  assert.ok(warped, 'sanity: 120x90 is above the minimum output size')

  // Sample a grid of output pixels (not just the corners) and check each one
  // against the homography's own prediction for that pixel's center.
  for (let v = 0; v < out.height; v += 7) {
    for (let u = 0; u < out.width; u += 7) {
      const s = (u + 0.5) / out.width
      const t = (v + 0.5) / out.height
      const expectedX = mapPoint(hom, s, t).x
      const actual = warped!.data[v * out.width + u]
      assert.ok(
        Math.abs(actual - expectedX) <= 1,
        `pixel (${u},${v}): got ${actual}, want ~${expectedX}`
      )
    }
  }
})

test('warpGray with the identity quad reproduces a smooth source within +/-1', () => {
  // Full-frame corners, out = src dims. Uses a genuinely 2D (not single-axis)
  // gradient with a gentle slope (1 per pixel in both x and y): the +0.5
  // pixel-center convention combined with the (w-1)/w edge-to-edge scaling
  // introduces a bounded subpixel positional error (~0.5px in each axis) even
  // for the identity quad, so the source has to be smooth for "reproduces
  // within +/-1" to be a meaningful (not accidentally-true) assertion. A
  // steep or high-frequency source would NOT reproduce within +/-1 here, by
  // design -- that's what the checkerboard test below is for.
  const width = 60
  const height = 45
  const src: GrayImage = { data: new Uint8ClampedArray(width * height), width, height }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) src.data[y * width + x] = Math.min(255, x + y)
  }

  const quad: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: width - 1, y: 0 }, br: { x: width - 1, y: height - 1 }, bl: { x: 0, y: height - 1 },
  }
  const warped = warpGray(src, quad, { width, height })
  assert.ok(warped)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const actual = warped!.data[y * width + x]
      const expected = src.data[y * width + x]
      assert.ok(
        Math.abs(actual - expected) <= 1,
        `pixel (${x},${y}): got ${actual}, want ~${expected}`
      )
    }
  }
})

test('warpGray un-skews a checkerboard: block means land near 0 and 255 in alternating cells', () => {
  const CELL = 20
  const COLS = 8
  const ROWS = 6
  const srcWidth = CELL * COLS
  const srcHeight = CELL * ROWS

  const src: GrayImage = { data: new Uint8ClampedArray(srcWidth * srcHeight), width: srcWidth, height: srcHeight }
  for (let y = 0; y < srcHeight; y++) {
    for (let x = 0; x < srcWidth; x++) {
      const cellX = Math.floor(x / CELL)
      const cellY = Math.floor(y / CELL)
      src.data[y * srcWidth + x] = (cellX + cellY) % 2 === 0 ? 255 : 0
    }
  }

  // A genuine perspective quad (not a parallelogram) inset from the frame.
  const quad: Quad = {
    tl: { x: 5, y: 8 }, tr: { x: srcWidth - 5, y: 2 }, br: { x: srcWidth - 10, y: srcHeight - 5 }, bl: { x: 8, y: srcHeight - 8 },
  }
  const hom = rectToQuad(quad) as Homography
  assert.ok(hom)
  assert.notEqual(hom.g === 0 && hom.h === 0, true, 'sanity: must be a genuine perspective quad')

  const out = { width: 160, height: 120 }
  const warped = warpGray(src, quad, out)
  assert.ok(warped)

  // Bucket every output pixel whose mapped source position falls safely
  // inside a cell (away from the checkerboard's borders, where bilinear
  // blending between black and white is expected) by that cell's parity.
  const MARGIN = 5
  const groups: { even: number[]; odd: number[] } = { even: [], odd: [] }
  for (let v = 0; v < out.height; v++) {
    for (let u = 0; u < out.width; u++) {
      const s = (u + 0.5) / out.width
      const t = (v + 0.5) / out.height
      const p = mapPoint(hom, s, t)
      if (p.x < 0 || p.x >= srcWidth || p.y < 0 || p.y >= srcHeight) continue

      const fx = p.x / CELL
      const fy = p.y / CELL
      const marginX = Math.min(fx - Math.floor(fx), Math.ceil(fx) - fx) * CELL
      const marginY = Math.min(fy - Math.floor(fy), Math.ceil(fy) - fy) * CELL
      if (Math.min(marginX, marginY) < MARGIN) continue

      const cellX = Math.floor(p.x / CELL)
      const cellY = Math.floor(p.y / CELL)
      const value = warped!.data[v * out.width + u]
      if ((cellX + cellY) % 2 === 0) groups.even.push(value)
      else groups.odd.push(value)
    }
  }

  assert.ok(groups.even.length > 100, 'sanity: enough interior samples in the "white" cells')
  assert.ok(groups.odd.length > 100, 'sanity: enough interior samples in the "black" cells')

  const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length
  assert.ok(mean(groups.even) > 245, `white-cell block mean should be near 255, got ${mean(groups.even)}`)
  assert.ok(mean(groups.odd) < 10, `black-cell block mean should be near 0, got ${mean(groups.odd)}`)
})

test('warpGray returns null for a degenerate quad regardless of output size', () => {
  const src = makeRampGray(100, 100)
  const degenerate: Quad = {
    tl: { x: 0, y: 10 }, tr: { x: 10, y: 0 }, br: { x: 20, y: 0 }, bl: { x: 30, y: 0 },
  }
  assert.equal(warpGray(src, degenerate, { width: 100, height: 100 }), null)
})

test('warpGray returns null when either output dimension is below 32', () => {
  const src = makeRampGray(100, 100)
  const quad: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 99, y: 0 }, br: { x: 99, y: 99 }, bl: { x: 0, y: 99 },
  }
  assert.equal(warpGray(src, quad, { width: 31, height: 100 }), null, 'width just under the floor')
  assert.equal(warpGray(src, quad, { width: 100, height: 31 }), null, 'height just under the floor')
  assert.ok(warpGray(src, quad, { width: 32, height: 32 }), 'exactly at the floor must succeed')
})
