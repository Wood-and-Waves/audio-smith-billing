# Receipt Corner-Finding + Perspective Flattening

## Context

Receipt photos are shot at an angle on tables; the current browser pipeline
(downscale → grayscale → contrast-stretch in `enhance()`) fixes exposure but not
geometry. This feature detects the receipt's four corners, perspective-flattens it
into a straight document (better OCR, cleaner client-facing invoice PDFs), and gives
Dan draggable corner handles to fix detection when it's wrong. From
`docs/BACKLOG.md`; UX decided with Dan:

- **Single-photo add:** confirm screen — photo + detected quad + 4 draggable
  handles + "Use full photo" skip — before upload.
- **Batch (2+ photos):** fully automatic, no confirmation (stays fire-and-forget).
- **Fix-later:** "Adjust corners" button on any expense row with a photo receipt —
  reopens the untouched original, re-detects, adjusts, re-flattens, swaps the
  enhanced file. Same adjuster component in both places.
- **Hand-rolled pure math, no OpenCV.js/jscanify** (8MB wasm on the common path
  rejected). **Hard constraint:** corners not confidently found → null → exactly
  today's behavior, never a mangled crop. PDFs skip detection entirely.
- **No DB migration.** No new dependencies. OCR is NOT re-run on fix-later
  (verified: `extractReceipt` only fills form state pre-insert; re-running would
  clobber nothing and feed nothing).

Repo: `audio-smith-billing`. Branch off `main` (e.g. `receipt-corners`).

## Architecture

All math is pure and canvas-free, operating on
`{ data: Uint8ClampedArray, width, height }` grayscale (`GrayImage`) — same
lib-vs-component split as `lib/receiptImage.ts` / `ExpenseLog.tsx`. Detection runs
on a ≤400px downscale; the warp samples one grayscale plane from a ≤2400px source
(1.5× the 1600 output cap — one resampling step, phone-memory-safe at batch
concurrency 3) straight to the ≤1600 output. Bonus: on the warp path the contrast
histogram is computed after cropping, so table wood no longer drags the stretch.

## New pure libs (exact signatures)

**`lib/receiptQuad.ts`** — types + geometry + sanity gates:
`Point`, `Quad {tl,tr,br,bl}`, `GrayImage`; `MIN_AREA_FRACTION = 0.15`,
`MAX_AREA_FRACTION = 0.98`, `MIN_CORNER_GAP = 0.08` (fraction of frame diagonal);
`orderQuad(pts): Quad | null` (clockwise around centroid, min x+y = tl),
`quadArea` (shoelace), `isConvex`, `minCornerGap`, `scaleQuad`, `clampQuad`,
`quadSane(q, w, h)` (detection gate), `quadUsable(q)` (manual gate on normalized
coords: convex, nonzero area, gap ≥ 0.02 — no area floor; a small manual crop is
Dan's call).

**`lib/receiptCorners.ts`** — detection:
`DETECT_MAX_EDGE = 400`, `MIN_CLASS_SEPARATION = 24`, `MIN_FILL_RATIO = 0.8`;
`downscaleGray` (box average, never enlarges), `boxBlur3`,
`otsu(histogram): { threshold, separation }`, `largestComponent` (4-connected BFS
over bright pixels), `convexHull` (Andrew's monotone chain),
`reduceHull(hull, 24)` (least-area-loss vertex removal), `maxAreaQuad` (exhaustive
C(≤24,4) shoelace — deterministic, no epsilon), `detectReceiptQuad(gray): Quad | null`.

Pipeline: blur → Otsu (separation < 24 → null: white-on-white/flat scene) →
largest bright component (area < 15% → null) → hull of boundary pixels → reduce →
max-area quad → gates: `quadSane` AND blob-fills-quad ≥ 0.8 (rejects merged
blobs/L-shapes) AND area ≤ 98% (a full-frame quad = no receipt found). Any gate
fails → null, no partial results.

**`lib/receiptWarp.ts`** — homography + warp:
`Homography {a..h}`; `rectToQuad(quad): Homography | null` — **Heckbert unit-square
closed form** (affine branch when the perspective terms vanish; |det| < 1e-9 →
null), not an 8×8 solve; `mapPoint`, `warpOutputSize` (average opposite edge
lengths → reuse `scaleToFit` from `./receiptImage.ts`; either dim < 32 → treat as
failure), `bilinearSample` (edge-clamped), `warpGray(src, quad, out): GrayImage | null`
(inverse mapping, allocation-free inner loop; ~1.9M px ≈ 30–80ms on a phone).

**`lib/receiptImage.ts`** — add `applyContrastStretch(gray: GrayImage): void`
composing the existing histogram → `contrastBounds` → `buildLut` in place. Existing
exports and the RGBA fallback loop untouched.

## Component integration (`components/ExpenseLog.tsx`)

- New helpers: `WARP_SOURCE_MAX_EDGE = 2400`, `grayFromBitmap(bitmap, maxEdge)`
  (same Rec.601 luma line as today), `grayToJpeg(gray)` (canvas → JPEG_QUALITY).
- `detectCorners(file): Promise<Quad | null>` — normalized 0..1 quad (the
  interchange format everywhere).
- `enhance(file, quadNorm?: Quad | null)`: `undefined` = auto-detect (batch),
  `null` = skip warp, `Quad` = use it (confirm/fix-later, gated by `quadUsable`).
  Quad path: gray at 2400 → denormalize (`scaleQuad`+`clampQuad`) → `warpGray` →
  `applyContrastStretch` → `grayToJpeg`; warp null → fall through. No-quad path
  and the PDF branch: **byte-identical to today's code**. `bitmap.close()` in
  `finally`.
- `uploadReceiptPair(..., quadNorm?)` threads it through; batch (`runBatchRow`)
  passes nothing → auto-detect. That is the entire batch diff.
- **Single flow:** split `onPickFile` — PDFs go straight to upload; photos run
  `detectCorners`, then set `pendingAdjust` state (object URL + detected quad, or a
  12%-inset default when detection fails so hand-marking still works) → adjuster →
  confirm/`beginUpload(file, quad, token)` / "Use full photo" (null) / cancel.
  `beginUpload` = the entire existing upload body, unchanged. Existing
  `tokenRef` supersession covers pick-while-open; file decoded twice by design
  (holding an ImageBitmap in state across a modal is a leak hazard).

## `components/CornerAdjuster.tsx` (new, shared)

Props: `{ src, initialQuad, confirmLabel, busy?, onConfirm(quad | null), onCancel }`.
Fixed overlay dialog **copying `components/PunchClock.tsx:130-144` verbatim**
(`fixed inset-0 z-50 … bg-black/50`, `role="dialog" aria-modal`, Escape +
backdrop-click cancel, `bg-bg border border-line rounded-field` panel). Inside:
`<img>` (`max-h-[70vh] object-contain`) + absolutely-positioned `<svg>` overlay
drawing the quad polygon, an evenodd dim outside it, and 4 handles (visible r≈10,
invisible hit r≈24, pointer events with `setPointerCapture`, `touch-action: none`).
Coords normalized; screen mapping computed from the letterboxed image box at event
time. `quadUsable` gates: invalid → danger stroke + Confirm disabled; `orderQuad`
canonicalizes before confirm. Buttons: confirmLabel / "Use full photo" / Cancel.
**No instructional copy.**

## Fix-later

- Row button "Adjust corners" (underline idiom next to "Make non-reimbursable",
  `disabled={locked || pending}`) only when `receipt_original` exists, isn't a
  `.pdf`, and `receipt_path` exists.
- Flow: `signedReceiptUrls([original])` (exists, `app/expenses/actions.ts:183`) →
  client `fetch` → blob (precedent: `exportOriginals`) → detect → adjuster
  (`confirmLabel='Save'`) → `enhance(asFile, quad)` → upload to a **new stamped
  path** `…-adjusted-enhanced.jpg` (never upsert in place: all-or-nothing + CDN
  staleness) → server action → `router.refresh()`; on action error, best-effort
  remove the freshly uploaded orphan.
- **New action `replaceExpenseReceipt(expenseId, newEnhancedPath)`** in
  `app/expenses/actions.ts`, modeled line-for-line on `setExpenseBillable`
  (`:144`) + `deleteExpense`'s select (`:102`): auth → load
  `show_id, receipt_path, receipt_original, shows(status)` → refuse when billed
  (the PDF artifact is frozen) → refuse when `receipt_original` is null (never a
  back door for a first attachment) → path-prefix check exactly as `addExpense:68`
  → update `receipt_path` → best-effort delete of the old enhanced object
  (warning-not-failure, `deleteExpense` policy) → `revalidatePath`.

## Tasks (subagent-driven, TDD; model tiering per repo process — not money code, mid-tier reviews suffice)

1. **`lib/receiptQuad.ts`** + `scripts/test/receiptQuad.test.ts` — geometry: all 24
   permutations canonicalize identically, shoelace vs hand values, convex/crossed,
   gate boundary cases at exactly 0.15/0.98/gap.
2. **`lib/receiptWarp.ts`** + tests — corner mapping exact to 1e-9 (perspective AND
   affine branch), degenerate → null, output-size capping, bilinear exactness +
   edge clamp, **linear-ramp warp** (bilinear is exact on linear fields → every
   output pixel assertable ±1), identity quad reproduces source, checkerboard
   un-skews.
3. **`lib/receiptCorners.ts`** + tests — synthetic images built in-test (`makeGray`,
   `fillQuad`, seeded LCG noise, no fixtures): white quad on dark noise → corners
   within 3px; rejections each → null: flat, low-contrast (sep < 24), 5% tiny,
   99% full-frame, L-shaped merged blob, sliver quad.
4. **`applyContrastStretch`** in `lib/receiptImage.ts` + test additions (flat plane
   unchanged via MIN_SPAN; [90..170] stretches to ~[0..255]).
5. **`enhance()` refactor + batch auto-flatten** in `ExpenseLog.tsx` — PDF/null
   paths byte-identical; gates + dev-sandbox batch check (angled photos flatten,
   hostile photos degrade).
6. **`CornerAdjuster.tsx` + single-flow confirm** — dialog, handles, defaults,
   token/object-URL lifecycle; manual: drag each corner, confirm/skip/cancel/
   Escape/supersede, PDF bypass.
7. **Fix-later** — action + row flow; manual: swap verified in storage + row,
   original untouched, billed show refused.
8. **Whole-branch review + full verification** (below), then
   superpowers:finishing-a-development-branch.

Each task: `npm test` green; TS/TSX tasks add cold tsc
(`rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`); UI
tasks add `npm run build`. At execution start, write the spec + detailed plan docs
to `docs/superpowers/specs|plans/` per repo convention, and keep
`.superpowers/sdd/progress.md` as the recovery ledger.

## Verification (dev sandbox, real angled photo)

1. Single add: adjuster shows a quad hugging the receipt → confirm → enhanced file
   is a straight, readable document; original untouched.
2. Crossed handles → danger stroke, Save disabled; sensible drag → output matches.
3. "Use full photo" → today's exact output. 4. Batch 3+: no adjuster; flattened
   where detected; white-on-white degrades cleanly. 5. PDF: no adjuster, no row
   button. 6. Fix-later: new enhanced file swapped in, old object deleted, amounts/
   dates untouched, invoice preview embeds the new image. 7. Billed show: refused.
8. OCR spot-check: same angled photo before/after branch — compare fields filled.
9. Phone pass: thumb-drag works, no scroll during drag, memory stable over a
   6-photo batch.

## Known residual risk (accepted, documented in code)

A hard shadow splitting the receipt can yield a plausible half-receipt quad the
gates can't see. Single-add catches it on the confirm screen; batch repairs it via
fix-later from the untouched original. Do NOT loosen thresholds to chase it.
