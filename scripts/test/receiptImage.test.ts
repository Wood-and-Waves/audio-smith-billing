// The arithmetic behind the "flatbed scan" look, separated from the canvas so
// it can actually be tested. The canvas wiring lives in the component.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scaleToFit, contrastBounds, buildLut, MAX_EDGE } from '../../lib/receiptImage.ts'

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

test('a flat image does not divide by zero', () => {
  // Every pixel identical — lo and hi collapse. The LUT must still be usable.
  const h = new Array(256).fill(0)
  h[128] = 1000
  const { lo, hi } = contrastBounds(h)
  const lut = buildLut(lo, hi)
  assert.equal(lut.length, 256)
  assert.ok(Number.isFinite(lut[128]))
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
