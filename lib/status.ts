// Invoice status, and the one place "overdue" is decided.
//
// The database stores only draft | sent | paid | void. Overdue is DERIVED from
// the due date and the balance, never stored — a stored overdue flag is wrong
// every morning until the cron happens to run.
//
// No 'use client', no hooks, no imports: renders in server and client trees
// alike, and in a plain node test. Keep it that way.

export type StoredStatus = 'draft' | 'sent' | 'paid' | 'void'
export type DisplayStatus = 'draft' | 'sent' | 'overdue' | 'paid' | 'void'

export type InvoiceLike = {
  status: StoredStatus
  due_date: string        // YYYY-MM-DD
  total_cents: number
  paid_cents?: number
}

/** `today` is injected so this stays pure and testable. */
export function displayStatus(inv: InvoiceLike, today: string): DisplayStatus {
  if (inv.status !== 'sent') return inv.status
  const balance = inv.total_cents - (inv.paid_cents ?? 0)
  if (balance <= 0) return 'paid'
  return inv.due_date < today ? 'overdue' : 'sent'
}

export function daysUntilDue(dueDate: string, today: string): number {
  const ms = Date.parse(dueDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')
  return Math.round(ms / 86_400_000)
}

/**
 * The signal state of a channel: muted, live, clipping, or printed and done.
 * Colour is information here, not decoration — it is the only thing that has
 * to be readable across a whole list at a glance.
 */
export const STATUS_META: Record<DisplayStatus, { label: string; bar: string; text: string }> = {
  draft:   { label: 'Draft',   bar: 'bg-line',    text: 'text-muted' },
  sent:    { label: 'Sent',    bar: 'bg-accent',  text: 'text-accent' },
  overdue: { label: 'Overdue', bar: 'bg-danger',  text: 'text-danger' },
  paid:    { label: 'Paid',    bar: 'bg-transparent', text: 'text-muted' },
  void:    { label: 'Void',    bar: 'bg-transparent', text: 'text-muted' },
}

/** Today in a fixed timezone. Dan bills from Illinois; UTC would roll a day
 *  early every evening and make things look overdue before they are. */
export function todayInChicago(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}
