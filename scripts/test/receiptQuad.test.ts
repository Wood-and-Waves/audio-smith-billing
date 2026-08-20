// The geometry shared by automatic corner detection and Dan's manual
// handle-dragging adjuster, separated from both so it can be tested without a
// canvas or a real photo. No fixtures — every quad below is a hand-built,
// hand-checked (shoelace by hand) value.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  orderQuad, quadArea, isConvex, minCornerGap, scaleQuad, clampQuad,
  quadSane, quadUsable, MIN_AREA_FRACTION, MAX_AREA_FRACTION, MIN_CORNER_GAP,
  type Point, type Quad,
} from '../../lib/receiptQuad.ts'

// A known irregular (non-square, non-symmetric) convex quad. Corner sums
// (x+y) are tl=0, tr=110, br=170, bl=60 — tl is unambiguously the minimum,
// so canonicalization has exactly one correct answer.
const tl: Point = { x: 0, y: 0 }
const tr: Point = { x: 100, y: 10 }
const br: Point = { x: 90, y: 80 }
const bl: Point = { x: -10, y: 70 }
const CANONICAL: Quad = { tl, tr, br, bl }

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of permutations(rest)) out.push([items[i], ...tail])
  }
  return out
}

test('all 24 orderings of the same 4 points canonicalize identically', () => {
  const perms = permutations([tl, tr, br, bl])
  assert.equal(perms.length, 24, 'permutation generator must cover every ordering')

  for (const perm of perms) {
    const result = orderQuad(perm)
    assert.deepEqual(result, CANONICAL, `input order [${perm.map((p) => `(${p.x},${p.y})`).join(' ')}] mis-ordered`)
  }
})

test('orderQuad rejects two coincident points', () => {
  const pts: Point[] = [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 0, y: 0 }, { x: -10, y: 70 }]
  assert.equal(orderQuad(pts), null)
})

test('quadArea matches a hand-computed shoelace value: unit square', () => {
  const square: Quad = { tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, br: { x: 1, y: 1 }, bl: { x: 0, y: 1 } }
  assert.equal(quadArea(square), 1)
})

test('quadArea matches a hand-computed shoelace value: trapezoid', () => {
  // Top edge width 4 (y=0), bottom edge width 2 (y=2): (4+2)/2 * 2 = 6.
  const trapezoid: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 4, y: 0 }, br: { x: 3, y: 2 }, bl: { x: 1, y: 2 },
  }
  assert.equal(quadArea(trapezoid), 6)
})

test('isConvex is true for an ordinary convex quad', () => {
  assert.equal(isConvex(CANONICAL), true)
})

test('isConvex is false for a concave (dart-shaped) simple quad', () => {
  // A(0,0) B(4,0) C(4,4) D(2,1): D is pulled toward the interior, giving a
  // reflex angle at D. The edges do not cross (checked by hand).
  const dart: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 4, y: 0 }, br: { x: 4, y: 4 }, bl: { x: 2, y: 1 },
  }
  assert.equal(isConvex(dart), false)
})

test('isConvex is false for a self-crossing (bowtie) quad', () => {
  // The square's own diagonals, taken as edges: (0,0)-(4,4) crosses (4,0)-(0,4).
  const bowtie: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 4, y: 4 }, br: { x: 4, y: 0 }, bl: { x: 0, y: 4 },
  }
  assert.equal(isConvex(bowtie), false)
})

test('isConvex is false for three collinear corners (zero-area turn)', () => {
  const collinear: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 2, y: 0 }, br: { x: 4, y: 0 }, bl: { x: 0, y: 4 },
  }
  assert.equal(isConvex(collinear), false)
})

test('minCornerGap finds the closest of all 6 corner pairs, not just adjacent ones', () => {
  const square: Quad = { tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, br: { x: 1, y: 1 }, bl: { x: 0, y: 1 } }
  assert.equal(minCornerGap(square), 1)

  const pinched: Quad = { tl: { x: 0, y: 0 }, tr: { x: 0.01, y: 0 }, br: { x: 1, y: 1 }, bl: { x: 0, y: 1 } }
  assert.ok(Math.abs(minCornerGap(pinched) - 0.01) < 1e-9)
})

test('scaleQuad multiplies every coordinate by the given per-axis factor', () => {
  const unit: Quad = { tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, br: { x: 1, y: 1 }, bl: { x: 0, y: 1 } }
  const scaled = scaleQuad(unit, 200, 100)
  assert.deepEqual(scaled, {
    tl: { x: 0, y: 0 }, tr: { x: 200, y: 0 }, br: { x: 200, y: 100 }, bl: { x: 0, y: 100 },
  })
})

test('clampQuad pulls out-of-range coordinates back into [0,width]/[0,height]', () => {
  const overflowing: Quad = {
    tl: { x: -10, y: -5 }, tr: { x: 150, y: -5 }, br: { x: 150, y: 120 }, bl: { x: -10, y: 120 },
  }
  const clamped = clampQuad(overflowing, 100, 100)
  assert.deepEqual(clamped, {
    tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, br: { x: 100, y: 100 }, bl: { x: 0, y: 100 },
  })
})

// quadSane boundary cases. Frame is 100x100: area = 10000, diagonal = 100*sqrt(2).
const FRAME = 100

test('quadSane: area exactly at the MIN_AREA_FRACTION boundary passes', () => {
  assert.equal(MIN_AREA_FRACTION * FRAME * FRAME, 1500)
  const q: Quad = { tl: { x: 0, y: 0 }, tr: { x: 50, y: 0 }, br: { x: 50, y: 30 }, bl: { x: 0, y: 30 } }
  assert.equal(quadArea(q), 1500)
  assert.equal(quadSane(q, FRAME, FRAME), true)
})

test('quadSane: area just under the MIN_AREA_FRACTION boundary fails', () => {
  const q: Quad = { tl: { x: 0, y: 0 }, tr: { x: 50, y: 0 }, br: { x: 50, y: 29.9 }, bl: { x: 0, y: 29.9 } }
  assert.equal(quadArea(q), 1495)
  assert.equal(quadSane(q, FRAME, FRAME), false)
})

test('quadSane: area exactly at the MAX_AREA_FRACTION boundary passes', () => {
  assert.equal(MAX_AREA_FRACTION * FRAME * FRAME, 9800)
  const q: Quad = { tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, br: { x: 100, y: 98 }, bl: { x: 0, y: 98 } }
  assert.equal(quadArea(q), 9800)
  assert.equal(quadSane(q, FRAME, FRAME), true)
})

test('quadSane: area just over the MAX_AREA_FRACTION boundary fails', () => {
  const q: Quad = { tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, br: { x: 100, y: 99 }, bl: { x: 0, y: 99 } }
  assert.equal(quadArea(q), 9900)
  assert.equal(quadSane(q, FRAME, FRAME), false)
})

// The threshold itself is irrational (0.08 * 100 * sqrt(2)), so a point built
// by adding it to a coordinate and later recovering it by subtraction isn't
// guaranteed bit-exact -- that round-trip previously landed a hair under the
// inclusive boundary and flaked. A tiny epsilon (far larger than float
// rounding noise, far smaller than the quantities involved) keeps these
// genuinely straddling the boundary without relying on bit-exact equality.
const GAP_EPSILON = 1e-4

test('quadSane: corner gap just at (a hair over) the MIN_CORNER_GAP boundary passes', () => {
  const diagonal = Math.sqrt(FRAME * FRAME + FRAME * FRAME)
  const gap = MIN_CORNER_GAP * diagonal + GAP_EPSILON
  const q: Quad = {
    tl: { x: 40, y: 0 }, tr: { x: 40 + gap, y: 0 }, br: { x: 100, y: 80 }, bl: { x: 0, y: 80 },
  }
  assert.equal(isConvex(q), true, 'construction must stay convex')
  assert.equal(quadSane(q, FRAME, FRAME), true)
})

test('quadSane: corner gap just under the MIN_CORNER_GAP boundary fails', () => {
  const diagonal = Math.sqrt(FRAME * FRAME + FRAME * FRAME)
  const gap = MIN_CORNER_GAP * diagonal - GAP_EPSILON
  const q: Quad = {
    tl: { x: 40, y: 0 }, tr: { x: 40 + gap, y: 0 }, br: { x: 100, y: 80 }, bl: { x: 0, y: 80 },
  }
  assert.equal(isConvex(q), true, 'construction must stay convex')
  assert.equal(quadSane(q, FRAME, FRAME), false)
})

test('quadSane rejects a non-convex quad regardless of area or gap', () => {
  const dart: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 40, y: 0 }, br: { x: 40, y: 40 }, bl: { x: 20, y: 10 },
  }
  assert.equal(quadSane(dart, FRAME, FRAME), false)
})

// quadUsable: normalized 0..1 quads from manual handle-dragging.
test('quadUsable is true for a convex, well-separated normalized quad', () => {
  const q: Quad = {
    tl: { x: 0.1, y: 0.1 }, tr: { x: 0.9, y: 0.1 }, br: { x: 0.9, y: 0.9 }, bl: { x: 0.1, y: 0.9 },
  }
  assert.equal(quadUsable(q), true)
})

test('quadUsable is false for a self-crossing normalized quad', () => {
  const bowtie: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 1, y: 1 }, br: { x: 1, y: 0 }, bl: { x: 0, y: 1 },
  }
  assert.equal(quadUsable(bowtie), false)
})

test('quadUsable is false when two handles have been dragged nearly on top of each other', () => {
  // Same trapezoid shape as the quadSane gap tests, scaled into 0..1, with a
  // gap of 0.01 -- well under the 0.02-of-unit-diagonal usable threshold.
  const q: Quad = {
    tl: { x: 0.4, y: 0 }, tr: { x: 0.41, y: 0 }, br: { x: 1, y: 0.8 }, bl: { x: 0, y: 0.8 },
  }
  assert.equal(isConvex(q), true, 'construction must stay convex')
  assert.equal(quadUsable(q), false)
})

test('quadUsable has no area floor: a small but valid manual crop still passes', () => {
  // Area is far below MIN_AREA_FRACTION (which would fail quadSane), but a
  // deliberately tight manual crop is the owner's call, not a defect.
  const tiny: Quad = {
    tl: { x: 0.4, y: 0.4 }, tr: { x: 0.5, y: 0.4 }, br: { x: 0.5, y: 0.5 }, bl: { x: 0.4, y: 0.5 },
  }
  assert.ok(quadArea(tiny) < MIN_AREA_FRACTION, 'sanity: this area would fail quadSane-style thresholds')
  assert.equal(quadUsable(tiny), true)
})
