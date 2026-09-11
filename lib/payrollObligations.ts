// What payroll owes, to whom, and by when — the "am I behind" engine.
//
// Running payroll creates four separate obligations on three different
// rhythms, and they are easy to confuse:
//
//   941 deposit       MONTHLY   both halves of FICA plus the federal income
//                               tax withheld, due the 15th of the next month
//   Form 941          QUARTERLY the return that reconciles those deposits.
//                               A filing, not a payment
//   Form 940 (FUTA)   ANNUAL    0.6% of the first $7,000 of wages. About $42
//                               on Dan's salary — under the $500 threshold
//                               that would force quarterly deposits, so it is
//                               one payment with the return, by 31 January
//   IL-941            MONTHLY   Illinois withholding, deposited; the return
//                     QUARTERLY is its own filing
//   IL UI (UI-3/40)   QUARTERLY Illinois unemployment, and it is money
//
// A deadline that is wrong by a day is a penalty, so two rules govern the
// dates here:
//
//   1. A due date falling on a weekend moves to the Monday.
//   2. Federal and state holidays are NOT modelled. A holiday can push a
//      deadline one day later than this says. That direction is safe — a date
//      shown early can never cause a late payment, and a date shown late can.
//      Erring early is the whole point.
//
// `today` is a parameter. This module never reads a clock.
// No '@/' imports and no JSX — exercised by node --test.

import { addDays, weekdayIndex, monthLabel } from './dates.ts'

export type ObligationCode =
  | '941-deposit'
  | '941-return'
  | '940'
  | 'il-941-deposit'
  | 'il-941-return'
  | 'il-ui'

export type ObligationStatus = 'done' | 'overdue' | 'due' | 'upcoming'

/** What one paycheck contributes. Comes straight off a recorded payroll run. */
export type ObligationRun = {
  payDate: string
  federalDepositCents: number
  ilDepositCents: number
  futaCents: number
  ilSutaCents: number
}

/**
 * A payment made, or — at zero cents — a filing marked as filed. Matched to an
 * obligation on code plus period, so a payment against the wrong month never
 * silently closes the right one.
 */
export type ObligationPayment = {
  code: ObligationCode
  periodStart: string
  periodEnd: string
  amountCents: number
}

export type Obligation = {
  code: ObligationCode
  label: string
  /** 'payment' carries money; 'filing' is paperwork with a deadline. */
  kind: 'payment' | 'filing'
  periodStart: string
  periodEnd: string
  dueOn: string
  amountDueCents: number
  amountPaidCents: number
  balanceCents: number
  status: ObligationStatus
}

/** Anything falling due within this many days reads as 'due' rather than 'upcoming'. */
const DUE_SOON_DAYS = 30

const ymOf = (iso: string) => iso.slice(0, 7)
const yearOf = (iso: string) => Number(iso.slice(0, 4))

const lastDayOf = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

const quarterOf = (iso: string): number => Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1

const quarterStart = (year: number, q: number) =>
  `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`

const quarterEnd = (year: number, q: number) =>
  lastDayOf(`${year}-${String(q * 3).padStart(2, '0')}`)

/** Saturday moves forward two days, Sunday one. See the header on holidays. */
function rollToBusinessDay(iso: string): string {
  const day = weekdayIndex(iso)
  if (day === 6) return addDays(iso, 2)
  if (day === 0) return addDays(iso, 1)
  return iso
}

function statusOf(
  kind: 'payment' | 'filing',
  balanceCents: number,
  hasRecord: boolean,
  dueOn: string,
  today: string,
): ObligationStatus {
  const done = kind === 'filing' ? hasRecord : balanceCents <= 0
  if (done) return 'done'
  if (dueOn < today) return 'overdue'
  return dueOn <= addDays(today, DUE_SOON_DAYS) ? 'due' : 'upcoming'
}

export function buildObligations(input: {
  runs: ObligationRun[]
  payments: ObligationPayment[]
  today: string
}): Obligation[] {
  const { runs, payments, today } = input

  // Group the runs onto the three rhythms. A period exists because a paycheck
  // fell in it — never because the calendar contains it — so a year with no
  // payroll produces no obligations at all.
  const byMonth = new Map<string, { fed: number; il: number }>()
  const byQuarter = new Map<string, { suta: number; year: number; quarter: number }>()
  const byYear = new Map<number, number>()

  for (const r of runs) {
    const ym = ymOf(r.payDate)
    const month = byMonth.get(ym) ?? { fed: 0, il: 0 }
    month.fed += r.federalDepositCents
    month.il += r.ilDepositCents
    byMonth.set(ym, month)

    const year = yearOf(r.payDate)
    const q = quarterOf(r.payDate)
    const qKey = `${year}-Q${q}`
    const quarter = byQuarter.get(qKey) ?? { suta: 0, year, quarter: q }
    quarter.suta += r.ilSutaCents
    byQuarter.set(qKey, quarter)

    byYear.set(year, (byYear.get(year) ?? 0) + r.futaCents)
  }

  const out: Obligation[] = []

  const emit = (
    code: ObligationCode,
    label: string,
    kind: 'payment' | 'filing',
    periodStart: string,
    periodEnd: string,
    dueOn: string,
    amountDueCents: number,
  ) => {
    // A payment obligation for nothing is not an obligation. Filings always
    // stand, because the form is due whether or not money moved.
    if (kind === 'payment' && amountDueCents <= 0) return

    const matching = payments.filter(
      (p) => p.code === code && p.periodStart === periodStart && p.periodEnd === periodEnd,
    )
    const amountPaidCents = matching.reduce((sum, p) => sum + p.amountCents, 0)
    const balanceCents = amountDueCents - amountPaidCents

    out.push({
      code, label, kind, periodStart, periodEnd, dueOn,
      amountDueCents, amountPaidCents, balanceCents,
      status: statusOf(kind, balanceCents, matching.length > 0, dueOn, today),
    })
  }

  for (const [ym, { fed, il }] of byMonth) {
    const periodStart = `${ym}-01`
    const periodEnd = lastDayOf(ym)
    // The 15th of the FOLLOWING month, which is what makes a late-month
    // paycheck's deposit land only two weeks later.
    const [y, m] = ym.split('-').map(Number)
    const nextYm = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)
    const dueOn = rollToBusinessDay(`${nextYm}-15`)
    const when = monthLabel(ym)

    emit('941-deposit', `Federal payroll deposit (941) — ${when}`, 'payment', periodStart, periodEnd, dueOn, fed)
    emit('il-941-deposit', `Illinois withholding deposit (IL-941) — ${when}`, 'payment', periodStart, periodEnd, dueOn, il)
  }

  for (const { suta, year, quarter } of byQuarter.values()) {
    const periodStart = quarterStart(year, quarter)
    const periodEnd = quarterEnd(year, quarter)
    // Returns are due the last day of the month AFTER the quarter closes.
    const dueMonth = new Date(Date.UTC(year, quarter * 3, 1)).toISOString().slice(0, 7)
    const dueOn = rollToBusinessDay(lastDayOf(dueMonth))
    const when = `Q${quarter} ${year}`

    emit('941-return', `Form 941 — ${when}`, 'filing', periodStart, periodEnd, dueOn, 0)
    emit('il-941-return', `Illinois IL-941 return — ${when}`, 'filing', periodStart, periodEnd, dueOn, 0)
    emit('il-ui', `Illinois unemployment (UI-3/40) — ${when}`, 'payment', periodStart, periodEnd, dueOn, suta)
  }

  for (const [year, futa] of byYear) {
    emit(
      '940',
      `Federal unemployment (940) — ${year}`,
      'payment',
      `${year}-01-01`,
      `${year}-12-31`,
      rollToBusinessDay(`${year + 1}-01-31`),
      futa,
    )
  }

  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.code.localeCompare(b.code))
}

/** The headline: what is already late, and what it adds up to. */
export function overdueTotalCents(obligations: Obligation[]): number {
  return obligations
    .filter((o) => o.status === 'overdue')
    .reduce((sum, o) => sum + Math.max(0, o.balanceCents), 0)
}
