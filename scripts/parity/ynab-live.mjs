// Live parity: YNAB's API vs this app's own arithmetic, current month.
//
//   npm run parity              -> PRODUCTION database vs live YNAB
//   npm run parity -- --dev     -> dev database instead
//
// Read-only on both sides. Reads YNAB_API_TOKEN and YNAB_BUDGET_ID from
// .env.local — the budget id is pinned so this can never wander into the
// personal or Wood and Waves budgets the token can also see.
//
// The comparison is per-category Available for the current Chicago month,
// computed by lib/budget.ts (the formulas validated against 1,421 rows of
// the 2026-08-22 export) against YNAB's `balance` (milliunits -> cents).
// YNAB's "Inflow: Ready to Assign" pseudo-category is compared against the
// app's own readyToAssignCents, with the known ~$1.01 Novo-account remainder
// called out rather than counted as a failure; "Uncategorized" and deleted/
// hidden YNAB rows are skipped. First run of this check hit zero on
// 2026-08-24, the day Dan cleared his ledger punch list.

import pg from 'pg'
import { buildBudget, OPENING_MONTH } from '../../lib/budget.ts'
pg.types.setTypeParser(20, (v) => Number(v))

const dev = process.argv.includes('--dev')
const url = process.env[dev ? 'DATABASE_URL' : 'DATABASE_URL_PROD']
const tok = process.env.YNAB_API_TOKEN
const bid = process.env.YNAB_BUDGET_ID
if (!url || !tok || !bid) {
  console.error('Need DATABASE_URL(_PROD), YNAB_API_TOKEN and YNAB_BUDGET_ID in .env.local')
  process.exit(1)
}
const ref = (url.match(/postgres\.([a-z0-9]+)/) || [])[1] ?? 'unknown'
console.log(`${dev ? 'dev' : 'PROD'} (${ref}) vs live YNAB\n`)

const api = async (p) => {
  const r = await fetch(`https://api.ynab.com/v1/budgets/${bid}${p}`, {
    headers: { Authorization: `Bearer ${tok}` },
  })
  if (!r.ok) { console.error(`YNAB API: ${r.status} ${r.statusText}`); process.exit(1) }
  return (await r.json()).data
}

const c = new pg.Client({ connectionString: url })
await c.connect()
const cats = (await c.query('select id, name, grp, sort, hidden, budget_role from ledger_categories')).rows
const mv = (await c.query("select to_char(month,'YYYY-MM') m, from_category_id, to_category_id, amount_cents, undone_at from ledger_budget_moves")).rows
const tx = (await c.query("select to_char(date,'YYYY-MM') m, category_id, amount_cents from ledger_transactions")).rows
const acct = (await c.query("select opening_balance_cents, to_char(opening_date,'YYYY-MM') m from ledger_accounts where closed = false order by created_at limit 1")).rows[0]
await c.end()

const now = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit',
}).format(new Date()).slice(0, 7)

const budget = buildBudget({
  categories: cats.map((r) => ({ id: r.id, name: r.name, grp: r.grp, sort: r.sort, hidden: r.hidden, budgetRole: r.budget_role })),
  moves: mv.map((r) => ({ month: r.m, fromCategoryId: r.from_category_id, toCategoryId: r.to_category_id, amountCents: r.amount_cents, undoneAt: r.undone_at })),
  txns: [
    { month: acct.m, categoryId: null, amountCents: acct.opening_balance_cents },
    ...tx.map((r) => ({ month: r.m, categoryId: r.category_id, amountCents: r.amount_cents })),
  ],
  targets: [], fromMonth: OPENING_MONTH, toMonth: now,
})
const monthOut = budget.get(now)
const appByName = new Map(monthOut.rows.map((r) => [cats.find((k) => k.id === r.categoryId)?.name, r]))

const usd = (cents) => (cents / 100).toFixed(2)
let rtaLine = null
const month = await api('/months/current')
{
  const ynabRta = Math.round(month.month.to_be_budgeted / 10)
  const delta = monthOut.readyToAssignCents - ynabRta
  rtaLine = `Ready to Assign: app ${usd(monthOut.readyToAssignCents)} vs YNAB ${usd(ynabRta)}`
    + (delta === 0 ? ' — exact'
       // The app carries the $1.01 YNAB nets away inside the dormant Novo
       // account (the app tracks Chase only) — expected, not a failure.
       : delta === 101 ? ' — the known $1.01 Novo remainder'
       : `  (Δ ${usd(delta)} — investigate)`)
}
let ok = 0
const diffs = []

for (const yc of month.month.categories) {
  if (yc.deleted || yc.hidden) continue
  const ynabCents = Math.round(yc.balance / 10)
  // The pseudo-category's `balance` is a lifetime-inflow figure, NOT the
  // month's Ready to Assign — that lives on the month itself as
  // to_be_budgeted. Learned the hard way on this tool's first run.
  if (yc.name === 'Inflow: Ready to Assign' || yc.name === 'Uncategorized') continue
  const app = appByName.get(yc.name)
  if (!app) { diffs.push(`  no app category named "${yc.name}"`); continue }
  if (ynabCents === app.availableCents) ok++
  else diffs.push(`  ${yc.name}: app ${usd(app.availableCents)} vs YNAB ${usd(ynabCents)}  (Δ ${usd(app.availableCents - ynabCents)})`)
}

console.log(`${now}: ${ok} categories match exactly, ${diffs.length} differ`)
for (const d of diffs) console.log(d)
if (rtaLine) console.log(rtaLine)
process.exitCode = diffs.length === 0 ? 0 : 1
