import { cn } from '@/lib/cn'

// Small-caps section heading on a hairline rule — the house ruled-section
// pattern. `note` sits opposite the title on the same rule.
//
// No 'use client' and no hooks, so this renders in a Server Component tree (the
// reports page) as well as a client one (New Show). Keep it that way.
export default function SectionHead({
  title,
  note,
  className,
}: {
  title: string
  note?: string
  className?: string
}) {
  return (
    // Wraps rather than stacking unconditionally: a short pair (a date and a
    // crew count) stays on one line with the count hard right, while a long note
    // drops to its own line instead of squeezing the heading into two.
    <div className={cn('flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line pb-2', className)}>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {note && <p className="text-[11px] text-muted">{note}</p>}
    </div>
  )
}
