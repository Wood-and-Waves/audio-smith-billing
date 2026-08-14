// What is due, what is late, and what has just gone late.
//
// Pure: no database, no email, no clock. "Today" is injected, which is what
// makes every boundary below testable and what keeps a timezone bug out of a
// decision about money.
//
// It does NOT define "overdue". lib/status.ts already does, and that is what
// the invoice list and the public invoice page display. A second definition
// here would eventually disagree with what a client is looking at.
//
// No '@/' imports and no JSX — this module runs under plain node --test.

import { displayStatus, daysUntilDue, type StoredStatus } from './status.ts'

/** An invoice due within this many days is worth mentioning. */
export const DUE_SOON_DAYS = 7

export type ReminderInvoice = {
  id: string
  number: number
  due_date: string          // YYYY-MM-DD
  total_cents: number
  status: StoredStatus
  client_name: string
  /** Whether a reminder_log row of kind 'overdue_alert' already exists. */
  alerted_overdue: boolean
}

export type Sweep = {
  /** Not yet due, due within DUE_SOON_DAYS. Soonest first. */
  dueSoon: ReminderInvoice[]
  /** Past due. Oldest first. */
  overdue: ReminderInvoice[]
  /** Past due and never alerted about. A subset of overdue. */
  newlyOverdue: ReminderInvoice[]
  /** Every chaseable invoice, including ones due far off. Stored cents. */
  totalOutstandingCents: number
}

export function sweep(invoices: ReminderInvoice[], today: string): Sweep {
  const dueSoon: ReminderInvoice[] = []
  const overdue: ReminderInvoice[] = []
  const newlyOverdue: ReminderInvoice[] = []
  let totalOutstandingCents = 0

  for (const inv of invoices) {
    const shown = displayStatus(
      { status: inv.status, due_date: inv.due_date, total_cents: inv.total_cents },
      today,
    )

    // draft has never been sent to anyone; paid and void are settled.
    if (shown !== 'sent' && shown !== 'overdue') continue

    totalOutstandingCents += inv.total_cents

    if (shown === 'overdue') {
      overdue.push(inv)
      if (!inv.alerted_overdue) newlyOverdue.push(inv)
    } else if (daysUntilDue(inv.due_date, today) <= DUE_SOON_DAYS) {
      dueSoon.push(inv)
    }
  }

  // Soonest first in every bucket: the thing needing attention leads.
  const byDueDate = (a: ReminderInvoice, b: ReminderInvoice) =>
    a.due_date.localeCompare(b.due_date)

  return {
    dueSoon: dueSoon.sort(byDueDate),
    overdue: overdue.sort(byDueDate),
    newlyOverdue: newlyOverdue.sort(byDueDate),
    totalOutstandingCents,
  }
}

/**
 * Is this plain date a Monday?
 *
 * `today` is already a Chicago calendar date from todayInChicago(), so the
 * weekday is a property of that string and must not be re-derived from the
 * current instant. Anchoring at noon UTC keeps the arithmetic clear of both
 * midnight boundaries — a Chicago Sunday evening is already Monday in UTC, and
 * reading the weekday off `new Date()` would fire the weekly digest a day
 * early, every week.
 */
export function isDigestDay(today: string): boolean {
  return new Date(today + 'T12:00:00Z').getUTCDay() === 1
}
