import { cn } from "@/lib/cn"

type Variant = "primary" | "ghost" | "danger"
type Size = "sm" | "md"

// Showbill controls: squared, uppercase, decisive. The 2px ink border on ghost
// is the house geometry (it reads as a printed control, not a bubble); primary
// is solid Crew Blue — the one saturated thing on a screen should be an action.
const base =
  "inline-flex items-center justify-center gap-2 font-bold uppercase tracking-[0.07em] cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent rounded-field"

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:opacity-90",
  ghost: "bg-surface border-2 border-ink text-ink hover:bg-surface-2",
  danger: "bg-danger text-white hover:opacity-90",
}

const sizes: Record<Size, string> = {
  sm: "px-3 py-1.5 text-[11px]",
  md: "px-4 py-2.5 text-[13px]",
}

export default function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button className={cn(base, variants[variant], sizes[size], className)} {...props} />
}
