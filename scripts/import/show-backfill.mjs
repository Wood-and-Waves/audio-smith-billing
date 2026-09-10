// One-off backfill: Dan's 2026 calendar + the invoices that billed it -> shows.
//
//   node --env-file=.env.local scripts/import/show-backfill.mjs            -> DRY RUN, dev DB
//   node --env-file=.env.local scripts/import/show-backfill.mjs --commit   -> writes, dev DB
//   node --env-file=.env.local scripts/import/show-backfill.mjs --prod --commit
//
// Mirrors scripts/import/ynab-backfill.mjs (env-file, single-owner detection,
// begin/commit/rollback, refuse-if-data-exists, the --prod banner printed
// before anything runs). Without --commit it is entirely read-only.
//
// WHY DIRECT SQL rather than the app's own actions: createShow refuses a client
// with no client_rate_cards row, and billShows — the only code that sets
// shows.invoice_id — CREATES a new invoice and allocates a fresh number. This
// backfill has to attach shows to invoices that already exist, so neither path
// fits. The rates come off the historical invoice's own lines instead, which is
// the card as it was actually frozen at the time.
//
// The reconciliation lives in scripts/import/propose-show-windows.mjs. Run that
// first: it must report zero problems before this is worth running at all.

import { readFileSync } from 'node:fs'
import pg from 'pg'
import {
  ratesFromInvoiceLines, dayCountsFromInvoiceLines, planShowDays, windowProblems,
} from '../../lib/showBackfill.ts'

pg.types.setTypeParser(20, (v) => Number(v))

const argv = process.argv.slice(2)
const prod = argv.includes('--prod')
const commit = argv.includes('--commit')
const url = prod ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL
if (!url) throw new Error(`No ${prod ? 'DATABASE_URL_PROD' : 'DATABASE_URL'} in the environment.`)

console.log(`Target: ${prod ? 'PRODUCTION' : 'local'}`)
console.log(commit ? 'Mode:   COMMIT — this writes.\n' : 'Mode:   DRY RUN — nothing will be written.\n')

const plan = JSON.parse(readFileSync(new URL('./out/shows-2026.json', import.meta.url), 'utf8'))
const usd = (c) => `$${(c / 100).toFixed(2)}`
const cents = (dollars) => Math.round(Number(dollars) * 100)

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  // --- who ------------------------------------------------------------------
  const { rows: users } = await client.query(
    'select id, email from auth.users order by created_at limit 2',
  )
  if (users.length === 0) throw new Error('No user found. Sign in to the app once first.')
  if (users.length > 1) throw new Error('More than one user found. This app assumes a single owner.')
  const owner = users[0].id
  console.log(`Owner:  ${users[0].email}\n`)

  // --- resolve clients ------------------------------------------------------
  const clientIds = new Map(
    (await client.query('select id, name from clients where owner_id = $1', [owner]))
      .rows.map(r => [r.name.toLowerCase(), r.id]),
  )
  for (const s of plan.shows) {
    if (!clientIds.has(s.client.toLowerCase())) {
      throw new Error(
        `No client named "${s.client}". This script never creates a client — `
        + '"Streamline Pictures" and "Streamline Productions" are different rows and '
        + 'guessing between them would quietly split his history.',
      )
    }
  }

  // --- resolve invoices -----------------------------------------------------
  const numbers = [...new Set(plan.shows.map(s => s.invoiceNumber).filter(n => n !== null))]
  const invoices = new Map(
    (await client.query(
      `select id, number, total_cents from invoices where owner_id = $1 and number = any($2::int[])`,
      [owner, numbers],
    )).rows.map(r => [r.number, r]),
  )
  for (const n of numbers) if (!invoices.has(n)) throw new Error(`Invoice #${n} not found.`)

  const lineRows = (await client.query(
    `select i.number, l.description, l.qty_hundredths, l.unit_price_cents
       from invoices i join invoice_lines l on l.invoice_id = i.id
      where i.owner_id = $1 and i.number = any($2::int[])`,
    [owner, numbers],
  )).rows
  const linesByNumber = new Map()
  for (const r of lineRows) {
    if (!linesByNumber.has(r.number)) linesByNumber.set(r.number, [])
    linesByNumber.get(r.number).push(r)
  }

  // --- guard against a second run ------------------------------------------
  const { rows: [{ count: already }] } = await client.query(
    `select count(*) from shows where owner_id = $1 and invoice_id = any($2::uuid[])`,
    [owner, [...invoices.values()].map(i => i.id)],
  )
  if (Number(already) > 0) {
    throw new Error(
      `${already} show(s) already link to invoices in this range. This is a one-off `
      + 'backfill with no --reset: undo it with an explicit SQL delete if you mean to redo it.',
    )
  }

  // --- free numbers for the two invoices his old software numbered 382 ------
  const used = new Set(
    (await client.query(
      'select number from invoices where owner_id = $1 and number between 368 and 376', [owner],
    )).rows.map(r => r.number),
  )
  const free = []
  for (let n = 368; n <= 376; n++) if (!used.has(n)) free.push(n)

  // --- build the whole plan before writing a single row ---------------------
  const work = []
  const blockers = []
  let nextFree = 0
  for (const s of plan.shows) {
    const { days, problems } = planShowDays(s.startDate, s.endDate, s.travelIn, s.travelOut)
    if (problems.length > 0) throw new Error(`${s.name}: ${problems.join(' ')}`)

    let newInvoice = null
    let rates
    if (s.invoiceNumber === null) {
      if (!s.invoice) {
        // Reported, not thrown: a dry run should show the whole picture, not
        // stop at the first gap.
        blockers.push(
          `${s.name}: no invoice in the app and no "invoice" block in shows-2026.json. `
          + `Its line items must come off the PDF Dan sent as #${s.sentAsNumber} — they are `
          + 'not derivable from anything already in the database, and a guessed total would '
          + 'land in his live books.',
        )
        work.push({ show: s, days, rates: ratesFromInvoiceLines([]), newInvoice: null, blocked: true })
        continue
      }
      if (nextFree >= free.length) throw new Error('No free invoice number left in the 368-376 gap.')
      const lines = s.invoice.lines.map((l, i) => ({
        position: i,
        description: l.description,
        qty_hundredths: Math.round(Number(l.qty) * 100),
        unit_price_cents: cents(l.unitPrice),
        line_total_cents: Math.round(Number(l.qty) * cents(l.unitPrice)),
      }))
      const total = lines.reduce((t, l) => t + l.line_total_cents, 0)
      newInvoice = {
        number: free[nextFree++],
        issueDate: s.invoice.issueDate,
        dueDate: s.invoice.dueDate,
        status: s.invoice.status ?? 'paid',
        lines,
        total,
        notes: `Sent to the client as Invoice ${s.sentAsNumber}. Dan's prior software issued `
          + `three invoices numbered ${s.sentAsNumber}; renumbered here because invoice `
          + 'numbers must be unique. Backfilled 2026-09-10 from the emailed PDF.',
      }
      rates = ratesFromInvoiceLines(lines)
    } else {
      rates = ratesFromInvoiceLines(linesByNumber.get(s.invoiceNumber) ?? [])
    }
    work.push({ show: s, days, rates, newInvoice })
  }

  // Day counts are checked per INVOICE, never per show: #362 and #380 each
  // billed two Journey visits, and checking a leg alone reports a false shortfall.
  for (const [number, lines] of linesByNumber) {
    const members = work.filter(w => w.show.invoiceNumber === number)
    if (members.length === 0) continue
    const bad = windowProblems(dayCountsFromInvoiceLines(lines), members.flatMap(w => w.days))
    if (bad.length > 0) throw new Error(`Invoice #${number}: ${bad.join(' ')}`)
  }

  // --- report ---------------------------------------------------------------
  for (const w of work) {
    const legs = w.days.reduce((n, d) => n + (d.travel_in ? 1 : 0) + (d.travel_out ? 1 : 0), 0)
    const label = w.blocked ? 'BLOCKED' : w.newInvoice ? `NEW #${w.newInvoice.number}` : `#${w.show.invoiceNumber}`
    console.log(`${label.padEnd(9)} ${w.show.name}`)
    console.log(`          ${w.show.startDate}..${w.show.endDate}  ${w.days.length} days, ${legs} travel legs`
      + `   day ${usd(w.rates.dayRateCents)} / travel ${usd(w.rates.travelRateCents)}`
      + `${w.rates.pmRateCents ? ` / PM ${usd(w.rates.pmRateCents)}` : ''}`)
    if (w.newInvoice) console.log(`          creates invoice ${usd(w.newInvoice.total)} (sent as #${w.show.sentAsNumber})`)
  }
  const newCount = work.filter(w => w.newInvoice).length
  console.log(`\n${work.length} shows, ${work.reduce((n, w) => n + w.days.length, 0)} show_days,`
    + ` ${newCount} new invoice${newCount === 1 ? '' : 's'}.`)

  for (const b of blockers) console.log(`\n⚠ ${b}`)

  if (blockers.length > 0) {
    console.log(`\n${blockers.length} blocker(s). Nothing written.`)
    process.exit(1)
  }
  if (!commit) {
    console.log('\nDRY RUN — nothing written. Re-run with --commit.')
    process.exit(0)
  }

  // --- write ----------------------------------------------------------------
  await client.query('begin')
  try {
    for (const w of work) {
      const s = w.show
      let invoiceId
      if (w.newInvoice) {
        const n = w.newInvoice
        const { rows: [inv] } = await client.query(
          `insert into invoices
             (owner_id, client_id, number, issue_date, due_date, status,
              subtotal_cents, total_cents, notes, imported)
           values ($1,$2,$3,$4,$5,$6,$7,$7,$8,false) returning id`,
          [owner, clientIds.get(s.client.toLowerCase()), n.number, n.issueDate, n.dueDate,
           n.status, n.total, n.notes],
        )
        invoiceId = inv.id
        for (const l of n.lines) {
          await client.query(
            `insert into invoice_lines
               (owner_id, invoice_id, position, description, qty_hundredths,
                unit_price_cents, line_total_cents)
             values ($1,$2,$3,$4,$5,$6,$7)`,
            [owner, invoiceId, l.position, l.description, l.qty_hundredths,
             l.unit_price_cents, l.line_total_cents],
          )
        }
      } else {
        invoiceId = invoices.get(s.invoiceNumber).id
      }

      // status and invoice_id are set together: 0004's
      // shows_billed_matches_invoice check refuses either one alone.
      const { rows: [show] } = await client.query(
        `insert into shows
           (owner_id, client_id, name, venue, status, invoice_id,
            day_rate_cents, travel_rate_cents, pm_rate_cents, notes)
         values ($1,$2,$3,$4,'billed',$5,$6,$7,$8,$9) returning id`,
        [owner, clientIds.get(s.client.toLowerCase()), s.name, s.venue ?? null, invoiceId,
         w.rates.dayRateCents, w.rates.travelRateCents, w.rates.pmRateCents, s.notes ?? null],
      )
      for (const d of w.days) {
        await client.query(
          `insert into show_days (owner_id, show_id, date, travel_in, travel_out, travel_works)
           values ($1,$2,$3,$4,$5,$6)`,
          [owner, show.id, d.date, d.travel_in, d.travel_out, d.travel_works],
        )
      }
    }
    await client.query('commit')
    console.log('\nCommitted.')
  } catch (e) {
    await client.query('rollback')
    throw e
  }
} finally {
  await client.end()
}
