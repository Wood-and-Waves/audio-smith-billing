// The PREFILL for the client reminder. Subject and a plain-text body Dan edits
// before sending. Like the invoice defaults, the body deliberately omits the
// public link — the server mints its token at send and appends it via
// assembleEmail. Emits no remit and no bank detail: a reminder is a nudge with
// a link, nothing more.
//
// No '@/' imports and no server-only anything — exercised by node --test and
// importable by a client component.

import { formatUSD } from './money.ts'
import { formatDateLong } from './dates.ts'

export function buildReminderDefaults(input: {
  number: number
  total_cents: number
  due_date: string
  legalName: string
}): { subject: string; body: string } {
  const { number, total_cents, due_date, legalName } = input
  const subject = `Reminder: invoice #${number} from ${legalName}`
  const body = [
    `A friendly reminder about invoice #${number}.`,
    '',
    `Amount due: ${formatUSD(total_cents)}`,
    `Due: ${formatDateLong(due_date)}`,
    '',
    'Thank you!',
  ].join('\n')
  return { subject, body }
}
