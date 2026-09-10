// Reconcile Dan's calendar windows against the invoices that billed them.
//
// Read-only. Writes nothing, touches nothing. Its whole job is to put the
// window from his calendar beside the days the invoice actually billed, so a
// mismatch is visible BEFORE show-backfill.mjs writes to his live books.
//
// One invoice may cover SEVERAL shows — #362 billed two Journey visits and #380
// billed two more — so the day counts are checked against the invoice's whole
// group, never show by show, which would report a shortfall on every leg.
//
//   node --env-file=.env.local scripts/import/propose-show-windows.mjs [--prod]

import { readFileSync } from 'node:fs'
import pg from 'pg'
import {
  ratesFromInvoiceLines, dayCountsFromInvoiceLines, planShowDays, windowProblems,
} from '../../lib/showBackfill.ts'

pg.types.setTypeParser(20, (v) => Number(v))

const prod = process.argv.includes('--prod')
const url = prod ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL
if (!url) throw new Error(`No ${prod ? 'DATABASE_URL_PROD' : 'DATABASE_URL'} in the environment.`)
console.log(`Target: ${prod ? 'PRODUCTION' : 'local'}\n`)

const plan = JSON.parse(readFileSync(new URL('./out/shows-2026.json', import.meta.url), 'utf8'))
const usd = (c) => `$${(c / 100).toFixed(2)}`
// Counted the way computeShowLines counts: legs are flags (one date can carry
// two) and a travel day counts as worked only when travel_works says so.
const shape = (days) => {
  const worked = days.filter(d => (!d.travel_in && !d.travel_out) || d.travel_works).length
  const legs = days.reduce((n, d) => n + (d.travel_in ? 1 : 0) + (d.travel_out ? 1 : 0), 0)
  return `${worked} worked + ${legs} travel`
}

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  const clients = new Map(
    (await client.query('select id, name from clients')).rows.map(r => [r.name.toLowerCase(), r.id]),
  )

  // Plan every show's days once, then reconcile invoice by invoice.
  const planned = plan.shows.map(s => {
    const { days, problems } = planShowDays(s.startDate, s.endDate, s.travelIn, s.travelOut)
    const issues = [...problems]
    if (!clients.has(s.client.toLowerCase())) issues.push(`No client named "${s.client}".`)
    return { show: s, days, issues }
  })

  const groups = new Map()
  for (const p of planned) {
    const key = p.show.invoiceNumber === null ? `missing:${p.show.name}` : `#${p.show.invoiceNumber}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(p)
  }

  let problemCount = 0
  for (const [key, members] of groups) {
    const first = members[0].show
    const missing = first.invoiceNumber === null

    let head = `${missing ? 'MISSING' : key}  ${members.map(m => m.show.name).join('  +  ')}`
    console.log(head)
    for (const m of members) {
      console.log(`         ${m.show.startDate} to ${m.show.endDate}`
        + `  (${m.days.length} dates: ${shape(m.days)})`)
    }

    const groupIssues = members.flatMap(m => m.issues)
    if (missing) {
      console.log(`         no invoice in the app — sent to the client as #${first.sentAsNumber}`)
    } else {
      const inv = await client.query(
        `select i.id, i.total_cents, l.description, l.qty_hundredths, l.unit_price_cents
           from invoices i left join invoice_lines l on l.invoice_id = i.id
          where i.number = $1`, [first.invoiceNumber],
      )
      if (inv.rows.length === 0) groupIssues.push(`Invoice ${key} not found.`)
      else {
        const lines = inv.rows.filter(r => r.description !== null)
        const counts = dayCountsFromInvoiceLines(lines)
        const rates = ratesFromInvoiceLines(lines)
        const allDays = members.flatMap(m => m.days)
        groupIssues.push(...windowProblems(counts, allDays))
        const rateNote = rates.dayRateCents === 0
          ? 'flat fee, no day rate'
          : `day ${usd(rates.dayRateCents)} / travel ${usd(rates.travelRateCents)}`
            + `${rates.pmRateCents ? ` / PM ${usd(rates.pmRateCents)}` : ''}`
        console.log(`         invoice billed ${counts.showDays} day + ${counts.travelDays} travel`
          + `   ${rateNote}   total ${usd(inv.rows[0].total_cents)}`)
      }
    }
    for (const p of groupIssues) console.log(`         ⚠ ${p}`)
    problemCount += groupIssues.length
    console.log()
  }

  // Which numbers in the 368-376 gap are genuinely free for the two missing invoices.
  const used = new Set(
    (await client.query('select number from invoices where number between 368 and 376')).rows.map(r => r.number),
  )
  const free = []
  for (let n = 368; n <= 376; n++) if (!used.has(n)) free.push(n)
  console.log(`${plan.shows.length} shows in ${groups.size} invoice groups.`)
  console.log(`Free invoice numbers in the 368-376 gap: ${free.join(', ') || '(none)'}`)
  console.log(`${problemCount} problem${problemCount === 1 ? '' : 's'} to resolve before importing.`)
} finally {
  await client.end()
}
