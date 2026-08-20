// The arithmetic behind the "flatbed scan" look, separated from the canvas so
// it can actually be tested. The canvas wiring lives in the component.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scaleToFit, contrastBounds, buildLut, MAX_EDGE, applyContrastStretch } from '../../lib/receiptImage.ts'

test('a large photo is scaled to the long edge, aspect ratio intact', () => {
  const landscape = scaleToFit(4032, 3024)
  assert.equal(landscape.width, MAX_EDGE)
  assert.equal(landscape.height, Math.round(3024 * (MAX_EDGE / 4032)))

  const portrait = scaleToFit(3024, 4032)
  assert.equal(portrait.height, MAX_EDGE, 'the LONG edge is the one capped')
  assert.equal(portrait.width, Math.round(3024 * (MAX_EDGE / 4032)))
})

test('an already-small image is never enlarged', () => {
  assert.deepEqual(scaleToFit(800, 600), { width: 800, height: 600 })
})

test('an extreme sliver never scales to a zero dimension', () => {
  // A 1px-wide image, long edge far past MAX_EDGE. The naive scale factor
  // rounds the short edge down to 0, which is an unusable canvas.
  const sliver = scaleToFit(1, 3201)
  assert.equal(sliver.height, MAX_EDGE)
  assert.ok(sliver.width >= 1, `width ${sliver.width} must be at least 1px`)
})

test('contrast bounds ignore the extreme tails', () => {
  // A receipt photographed in shadow: most pixels mid-grey, a few specks of
  // pure black and pure white. Stretching between the absolute min and max
  // would do almost nothing, because those specks are already 0 and 255.
  const h = new Array(256).fill(0)
  h[0] = 5          // a few black specks
  h[255] = 5        // a glare highlight
  for (let v = 90; v <= 170; v++) h[v] = 100   // the actual receipt

  const { lo, hi } = contrastBounds(h)
  assert.ok(lo >= 85 && lo <= 95, `lo ${lo} should land at the low end of the real data`)
  assert.ok(hi >= 165 && hi <= 175, `hi ${hi} should land at the high end of the real data`)
})

test('a flat image does not divide by zero, and is not thresholded to two levels', () => {
  // Every pixel identical — lo and hi collapse. The LUT must still be usable,
  // and — this is the part a bare Number.isFinite check misses — it must not
  // collapse the whole image down to black-and-white. Passing the image
  // through untouched is correct; a two-level silhouette is not.
  const h = new Array(256).fill(0)
  h[128] = 1000
  const { lo, hi } = contrastBounds(h)
  const lut = buildLut(lo, hi)
  assert.equal(lut.length, 256)
  assert.ok(Number.isFinite(lut[128]))

  const distinct = new Set(Array.from(lut))
  assert.ok(distinct.size > 2, `expected more than a black/white split, got ${distinct.size} distinct values`)
  assert.notEqual(lut[100], lut[150], 'two different inputs must not collapse onto the same output')
})

test('contrastBounds feeding straight into buildLut never produces a black-and-white image', () => {
  // The bug this guards against only shows up when contrastBounds' real
  // output — not a hand-picked wide span — is fed into buildLut. Each case
  // below is a plausible bad photo, not a synthetic edge case.
  const cases: Array<[string, () => number[]]> = [
    [
      'a flat single-bin histogram',
      () => {
        const h = new Array(256).fill(0)
        h[128] = 1000
        return h
      },
    ],
    [
      'an underexposed photo: 99% black, 1% highlight',
      () => {
        const h = new Array(256).fill(0)
        h[0] = 9900
        h[250] = 100
        return h
      },
    ],
    [
      'an all-black histogram',
      () => {
        const h = new Array(256).fill(0)
        h[0] = 1000
        return h
      },
    ],
    [
      'an all-white histogram',
      () => {
        const h = new Array(256).fill(0)
        h[255] = 1000
        return h
      },
    ],
  ]

  for (const [label, makeHistogram] of cases) {
    const { lo, hi } = contrastBounds(makeHistogram())
    const lut = buildLut(lo, hi)

    const distinct = new Set(Array.from(lut))
    assert.ok(
      distinct.size > 2,
      `${label}: expected more than a black/white split, got ${distinct.size} distinct values (lo=${lo}, hi=${hi})`
    )

    // Two luminances that differed in the input must still differ in the
    // output — detail must survive, not just "the LUT has many values".
    assert.notEqual(lut[80], lut[160], `${label}: distinguishable inputs collapsed to the same output`)
  }
})

test('the lut stretches the chosen range across the full scale', () => {
  const lut = buildLut(50, 200)
  assert.equal(lut[50], 0, 'the low bound becomes black')
  assert.equal(lut[200], 255, 'the high bound becomes white')
  assert.equal(lut[20], 0, 'below the low bound clamps, it does not wrap')
  assert.equal(lut[240], 255, 'above the high bound clamps')
  assert.ok(lut[125] > 100 && lut[125] < 155, 'the middle stays in the middle')
})

test('the lut never produces a pure black-and-white image', () => {
  // Deliberately a contrast STRETCH, not a threshold. Thermal receipts fade,
  // and thresholding erases a faint total — the one number a client queries.
  const lut = buildLut(50, 200)
  const distinct = new Set(Array.from(lut))
  assert.ok(distinct.size > 100, `expected a gradient, got ${distinct.size} distinct values`)
})

test('applyContrastStretch: flat plane passes through unchanged (MIN_SPAN guard)', () => {
  const data = new Uint8ClampedArray(400).fill(128)
  const gray = { data, width: 20, height: 20 }
  applyContrastStretch(gray)
  for (let i = 0; i < data.length; i++) assert.equal(data[i], 128)
})

test('applyContrastStretch: a 90..170 ramp stretches toward 0..255', () => {
  // 20x20 plane whose values sweep 90..170 uniformly - after the stretch the
  // range should reach near both ends, and ordering must be preserved.
  const data = new Uint8ClampedArray(400)
  for (let i = 0; i < 400; i++) data[i] = 90 + Math.floor((i / 399) * 80)
  const gray = { data, width: 20, height: 20 }
  applyContrastStretch(gray)
  let min = 255
  let max = 0
  for (let i = 0; i < 400; i++) {
    if (data[i] < min) min = data[i]
    if (data[i] > max) max = data[i]
    if (i > 0) assert.ok(data[i] >= data[i - 1], 'stretch must preserve ordering')
  }
  assert.ok(min <= 12, `min should approach 0, got ${min}`)
  assert.ok(max >= 243, `max should approach 255, got ${max}`)
})
