'use client'

import { useEffect, useRef, useState } from 'react'
import { type Point, type Quad, orderQuad, quadUsable } from '@/lib/receiptQuad'

/** Clockwise draw/handle order, matching `Quad`'s own field order. */
const CORNER_KEYS: (keyof Quad)[] = ['tl', 'tr', 'br', 'bl']

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * Shared corner-marking dialog: a photo, a draggable quad over it, and
 * confirm / "use full photo" / cancel. Used both for the single-photo
 * confirm screen (`ExpenseLog.tsx`) and fix-later re-adjustment, so nothing
 * here may assume how its caller got the photo or what it does with the
 * result — the quad in, the quad (or null) out, normalized 0..1 throughout.
 *
 * Fixed overlay dialog copies PunchClock's idiom verbatim (see
 * components/PunchClock.tsx:130-144): same backdrop, same role/aria wiring,
 * same Escape-and-backdrop-click-to-cancel gated on a busy flag, same panel
 * classes.
 *
 * Coordinate mapping: `<img>` is drawn with `object-contain`, so whenever the
 * photo's aspect ratio doesn't match the wrapper's box, the actual pixels
 * occupy a smaller, centered sub-box with letterbox bars on two sides.
 * `computeBox()` derives that sub-box (in pixels, relative to the wrapper)
 * from the img's natural size vs. the wrapper's own rendered rect; it is
 * cached in state and refreshed on load and on resize (`ResizeObserver`),
 * not on every drag frame. The overlay `<svg>` itself is given no `viewBox`,
 * so its user-unit space is identical to its own rendered CSS-pixel box —
 * every coordinate below is plain, unscaled pixels, which is what keeps the
 * r=10 handles perfect circles instead of ellipses distorted by a
 * non-uniform viewBox scale. A pointer event's `clientX/clientY` is viewport
 * space, not wrapper space, so handlers re-fetch the wrapper's live
 * `getBoundingClientRect()` at event time (cheap, and correct even if the
 * page has scrolled since the box was last cached) rather than trying to
 * keep a second, scroll-aware offset in state.
 */
export default function CornerAdjuster({
  src, initialQuad, confirmLabel, busy = false, onConfirm, onCancel,
}: {
  src: string
  initialQuad: Quad
  confirmLabel: string
  busy?: boolean
  onConfirm: (quad: Quad | null) => void
  onCancel: () => void
}) {
  const [quad, setQuad] = useState<Quad>(initialQuad)
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  function computeBox() {
    const wrapper = wrapperRef.current
    const img = imgRef.current
    if (!wrapper || !img || !img.naturalWidth || !img.naturalHeight) return
    const rect = wrapper.getBoundingClientRect()
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight)
    const width = img.naturalWidth * scale
    const height = img.naturalHeight * scale
    // Centered, exactly what object-contain does -- this holds for both a
    // portrait photo in a wide box (bars left/right) and a landscape photo
    // shorter than the max-height cap (bars top/bottom).
    setBox({ left: (rect.width - width) / 2, top: (rect.height - height) / 2, width, height })
  }

  useEffect(() => {
    computeBox()
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const ro = new ResizeObserver(computeBox)
    ro.observe(wrapper)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const usable = quadUsable(quad)

  /** Wires one handle's hit circle: capture on down, drag on move, release on up/cancel. */
  function cornerHandlers(corner: keyof Quad) {
    return {
      onPointerDown: (e: React.PointerEvent<SVGCircleElement>) => {
        if (busy) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
      },
      onPointerMove: (e: React.PointerEvent<SVGCircleElement>) => {
        // Only react while THIS pointer is actually captured by THIS handle
        // -- otherwise a plain hover (no button down, no capture) would drag
        // the corner just by passing over it.
        if (!box || !e.currentTarget.hasPointerCapture(e.pointerId)) return
        const rect = wrapperRef.current?.getBoundingClientRect()
        if (!rect) return
        const nx = clamp01((e.clientX - rect.left - box.left) / box.width)
        const ny = clamp01((e.clientY - rect.top - box.top) / box.height)
        setQuad((q) => ({ ...q, [corner]: { x: nx, y: ny } }))
      },
      onPointerUp: (e: React.PointerEvent<SVGCircleElement>) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      },
      // Mobile Safari fires pointercancel, not pointerup, when a drag turns
      // into a page scroll or the system takes the gesture over. Without
      // this, the handle stays captured to a pointer that will never send
      // another move or up -- effectively dead until the dialog reopens.
      onPointerCancel: (e: React.PointerEvent<SVGCircleElement>) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      },
    }
  }

  function handleConfirm() {
    if (!usable || busy) return
    // Canonicalizes whichever geometric corner is truly top-left/etc,
    // regardless of which NAMED handle a person happened to drag where --
    // dragging the "tl" handle to the photo's actual bottom-right, say,
    // still produces a valid convex quad, just with the labels crossed, and
    // the warp math needs the labels to match reality. orderQuad only
    // returns null when two of the four points are exactly coincident, which
    // `usable` (checked above, requires a minimum gap between every pair)
    // already rules out -- the `?? quad` fallback is unreachable in practice
    // and exists only so a future change to either gate can't turn this into
    // a crash.
    const ordered = orderQuad([quad.tl, quad.tr, quad.br, quad.bl])
    onConfirm(ordered ?? quad)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Receipt corners"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}
    >
      <div
        className="w-full max-w-sm bg-bg border border-line rounded-field p-5"
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onCancel() }}
      >
        <div ref={wrapperRef} className="relative">
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={computeBox}
            // `block`: an <img> is inline by default, which leaves a few
            // px of baseline whitespace below it inside a block wrapper --
            // enough to throw off computeBox()'s rect-vs-naturalSize math.
            className="block max-h-[60vh] w-full object-contain select-none"
          />
          {box && (
            <svg className="absolute inset-0 h-full w-full touch-none" aria-hidden="true">
              <path
                d={[
                  `M${box.left},${box.top}`,
                  `H${box.left + box.width}`,
                  `V${box.top + box.height}`,
                  `H${box.left}`,
                  'Z',
                  `M${box.left + quad.tl.x * box.width},${box.top + quad.tl.y * box.height}`,
                  `L${box.left + quad.tr.x * box.width},${box.top + quad.tr.y * box.height}`,
                  `L${box.left + quad.br.x * box.width},${box.top + quad.br.y * box.height}`,
                  `L${box.left + quad.bl.x * box.width},${box.top + quad.bl.y * box.height}`,
                  'Z',
                ].join(' ')}
                fillRule="evenodd"
                className="fill-black/40"
              />
              <polygon
                points={CORNER_KEYS.map((c) => {
                  const p = quad[c]
                  return `${box.left + p.x * box.width},${box.top + p.y * box.height}`
                }).join(' ')}
                fill="none"
                strokeWidth={2}
                className={usable ? 'stroke-accent' : 'stroke-danger'}
              />
              {CORNER_KEYS.map((corner) => {
                const p: Point = quad[corner]
                const cx = box.left + p.x * box.width
                const cy = box.top + p.y * box.height
                return (
                  <g key={corner}>
                    <circle
                      cx={cx} cy={cy} r={24}
                      fill="transparent"
                      style={{ pointerEvents: 'all' }}
                      {...cornerHandlers(corner)}
                    />
                    {/* Decorative only -- pointer-events:none so a press
                        landing on the small visible dot still reaches the
                        larger invisible hit circle underneath it rather
                        than being swallowed by an opaque fill with no
                        handlers of its own. */}
                    <circle
                      cx={cx} cy={cy} r={10}
                      strokeWidth={2}
                      className={`fill-bg ${usable ? 'stroke-accent' : 'stroke-danger'}`}
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>
                )
              })}
            </svg>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!usable || busy}
            className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase
                       tracking-wider text-sm rounded-field hover:opacity-90
                       transition-opacity disabled:opacity-50"
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(null)}
            disabled={busy}
            className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
          >
            Use full photo
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
