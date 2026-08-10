// Loads the parsed Google Sheet into Postgres.
//
//   npm run import:parse     # sheet  -> out/*.json   (no database)
//   npm run import:load      # out/*.json -> database
//   npm run import:load -- --reset    # wipe app tables first
//
// Safe to re-run: without --reset it refuses to load on top of existing
// invoices rather than silently doubling your billing history.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// Money arrives as integer cents and must stay that way; stop node-postgres
// handing back bigint as a JS number that could lose precision silently.
pg.types.setTypeParser(20, (v) => Number(v))

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, 'out')
const read = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'))

const RESET = process.argv.includes('--reset')
const UNPAID_FROM = 385 // Dan, 2026-08-09: "Invoice 385 and on are not paid yet."

const APP_TABLES = [
  'reminder_log', 'payments', 'invoice_lines', 'invoices',
  'client_rates', 'items', 'clients', 'settings',
]

// Catalogue seeded from what Dan actually bills, derived from 337 line items.
const ITEMS = [
  { name: 'Day Rate',     unit: 'day',  price: 0, kind: 'flat' },
  { name: 'Travel Day',   unit: 'day',  price: 0, kind: 'derived', rule: 'travel_half' },
  { name: 'Overtime',     unit: 'hour', price: 0, kind: 'derived', rule: 'overtime_1_5x' },
  { name: 'Double Time',  unit: 'hour', price: 0, kind: 'derived', rule: 'double_time_2x' },
  { name: 'Per Diem',     unit: 'each', price: 6500, kind: 'flat' },
  { name: 'Baggage',      unit: 'each', price: 5000, kind: 'flat' },
  { name: 'Audio Training', unit: 'each', price: 50000, kind: 'flat' },
  { name: 'Expenses',     unit: 'each', price: 0, kind: 'flat' },
  { name: 'Parking',      unit: 'each', price: 0, kind: 'flat' },
]

const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })

/**
 * Infer a client's day rate and overtime threshold from their own history.
 * Overtime in the sheet is always dayRate / hours * 1.5, so the threshold
 * falls out of the two numbers. Gives the rate card real starting values
 * instead of making Dan retype 18 clients' rates.
 */
function inferRates(lines) {
  const dayRates = lines
    .filter((l) => /^day rate/i.test(l.description) && l.unit_price_cents > 0)
    .map((l) => l.unit_price_cents)
  if (!dayRates.length) return { day_rate_cents: null, ot_after_hours: 10 }

  // Most frequent day rate wins.
  const freq = new Map()
  for (const r of dayRates) freq.set(r, (freq.get(r) || 0) + 1)
  const day = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]

  const otRates = lines
    .filter((l) => /overtime/i.test(l.description) && l.unit_price_cents > 0)
    .map((l) => l.unit_price_cents)
  let hours = 10
  if (otRates.length) {
    const ot = otRates.sort((a, b) => otRates.filter(v => v === a).length - otRates.filter(v => v === b).length).pop()
    // ot = day / h * 1.5  ->  h = day * 1.5 / ot
    const h = (day * 1.5) / ot
    if (Number.isFinite(h) && h >= 6 && h <= 16) hours = Math.round(h * 2) / 2
  }
  return { day_rate_cents: day, ot_after_hours: hours }
}

const run = async () => {
  const invoices = read('invoices.json')
  const items = read('items.json')
  const clients = read('clients.json')
  let emails = { clients: [] }
  try { emails = read('client-emails.json') } catch { /* optional */ }
  const emailFor = new Map(emails.clients.map((c) => [c.name, c.billing_email]))

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    const { rows: users } = await client.query(
      'select id, email from auth.users order by created_at limit 2',
    )
    if (users.length === 0) {
      throw new Error(
        'No user exists yet. Create one in the Supabase dashboard:\n' +
        '  Authentication > Users > Add user > Create new user\n' +
        '  (tick "Auto Confirm User")',
      )
    }
    if (users.length > 1) {
      throw new Error('More than one user found. This app assumes a single owner.')
    }
    const owner = users[0].id
    console.log(`owner: ${users[0].email}\n`)

    const { rows: [{ count: existing }] } = await client.query('select count(*) from invoices')
    if (Number(existing) > 0 && !RESET) {
      throw new Error(`${existing} invoices already loaded. Re-run with --reset to replace them.`)
    }

    await client.query('begin')

    if (RESET) {
      for (const t of APP_TABLES) await client.query(`delete from ${t}`)
      console.log('reset: app tables cleared\n')
    }

    // --- settings -------------------------------------------------------
    await client.query(
      `insert into settings (id, owner_id, business_name, legal_name,
         address_line1, address_line2, phone, email, remit_to, next_invoice_number)
       values (1, $1, 'The Audio Smith', 'Smith Audio, LLC',
         '2610 Melbourne Lane', 'Lake in the Hills, IL 60156',
         '269.217.8400', 'dan@theaudiosmith.com', $2, $3)
       on conflict (id) do update set owner_id = excluded.owner_id`,
      [
        owner,
        'Please remit payment to:\n\nSmith Audio, LLC\n2610 Melbourne Lane\nLake in the Hills, IL 60156',
        Math.max(...invoices.map((i) => i.number)) + 1,
      ],
    )

    // --- items ----------------------------------------------------------
    const itemIds = new Map()
    for (const [i, it] of ITEMS.entries()) {
      const { rows: [row] } = await client.query(
        `insert into items (owner_id, name, unit_label, default_price_cents, kind, derive_rule, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [owner, it.name, it.unit, it.price, it.kind, it.rule ?? null, i],
      )
      itemIds.set(it.name, row.id)
    }

    // --- clients --------------------------------------------------------
    const clientIds = new Map()
    for (const c of clients) {
      const theirLines = items.filter((li) =>
        invoices.some((inv) => inv.number === li.invoice_number && inv.client_name === c.name),
      )
      const { day_rate_cents, ot_after_hours } = inferRates(theirLines)
      const { rows: [row] } = await client.query(
        `insert into clients (owner_id, name, billing_email, address_line1, address_line2,
           day_rate_cents, ot_after_hours, legacy_names)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [
          owner, c.name, emailFor.get(c.name) ?? null,
          c.address_line1 || null, c.address_line2 || null,
          day_rate_cents, ot_after_hours,
          c.aliases.filter((a) => a && a !== c.name),
        ],
      )
      clientIds.set(c.name, row.id)
    }

    // --- invoices + lines -----------------------------------------------
    let lineCount = 0
    for (const inv of invoices) {
      const lines = items.filter((li) => li.invoice_number === inv.number)
      const subtotal = lines.reduce((t, l) => t + l.line_total_cents, 0)
      const issue = inv.issue_date
      const due = new Date(issue + 'T00:00:00Z')
      due.setUTCDate(due.getUTCDate() + 30)

      // Historical invoices are marked settled by status. No payment rows are
      // fabricated — the sheet never recorded when or how anything was paid,
      // and inventing dates would be worse than leaving it blank.
      const status = inv.number >= UNPAID_FROM ? 'sent' : 'paid'

      const { rows: [row] } = await client.query(
        `insert into invoices (owner_id, client_id, number, issue_date, due_date,
           terms_days, status, bill_to_snapshot, subtotal_cents, tax_bp, tax_cents,
           deposit_cents, total_cents, imported, sent_at)
         values ($1,$2,$3,$4,$5,30,$6,$7,$8,0,0,$9,$10,true,$11) returning id`,
        [
          owner, clientIds.get(inv.client_name), inv.number, issue,
          due.toISOString().slice(0, 10), status,
          [inv.client_name, inv.address_line1, inv.address_line2].filter(Boolean).join('\n'),
          subtotal, inv.deposit_cents, inv.total_cents,
          status === 'draft' ? null : issue,
        ],
      )

      for (const [pos, l] of lines.entries()) {
        await client.query(
          `insert into invoice_lines (owner_id, invoice_id, position, description,
             qty_hundredths, unit_price_cents, line_total_cents)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [owner, row.id, pos, l.description, Math.round(l.qty * 100),
           l.unit_price_cents, l.line_total_cents],
        )
        lineCount++
      }
    }

    await client.query('commit')

    // --- reconcile against the source ------------------------------------
    const { rows: [tot] } = await client.query(
      `select count(*)::int as invoices, sum(total_cents)::bigint as total,
              count(*) filter (where status='paid')::int as paid,
              count(*) filter (where status='sent')::int as unpaid,
              sum(total_cents) filter (where status='sent')::bigint as outstanding
         from invoices`,
    )
    const srcTotal = invoices.reduce((t, i) => t + i.total_cents, 0)

    console.log(`clients      ${clients.length}`)
    console.log(`items        ${ITEMS.length}`)
    console.log(`invoices     ${tot.invoices}   (source ${invoices.length}) ${tot.invoices === invoices.length ? 'OK' : 'MISMATCH'}`)
    console.log(`lines        ${lineCount}   (source ${items.length}) ${lineCount === items.length ? 'OK' : 'MISMATCH'}`)
    console.log(`billed       ${money(Number(tot.total))}   (source ${money(srcTotal)}) ${Number(tot.total) === srcTotal ? 'OK' : 'MISMATCH'}`)
    console.log(`paid         ${tot.paid}`)
    console.log(`outstanding  ${tot.unpaid} invoices, ${money(Number(tot.outstanding ?? 0))}`)

    const { rows: rates } = await client.query(
      `select name, day_rate_cents, ot_after_hours from clients
        where day_rate_cents is not null order by day_rate_cents desc`,
    )
    if (rates.length) {
      console.log('\ninferred rate cards:')
      for (const r of rates) {
        console.log(`  ${r.name.padEnd(32)} day ${money(r.day_rate_cents).padStart(9)}   OT after ${r.ot_after_hours}h`)
      }
    }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    console.error('\nFAILED:', e.message)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

run()
