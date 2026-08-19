// One-off backfill: YNAB "Register" CSV export -> ledger_transactions.
//
//   npm run import:ynab -- <csv-path>                          -> DRY RUN, dev DB
//   npm run import:ynab -- --commit <csv-path>                 -> writes, dev DB
//   npm run import:ynab -- --prod --commit <csv-path>           -> writes, PRODUCTION
//   npm run import:ynab -- <csv-path> --account "Business Checking" --start 2026-01-01
//
// Mirrors scripts/import/load.mjs (env-file, single-owner detection, begin/
// commit/rollback, refuse-if-data-exists) and scripts/run-sql.mjs (the
// --prod banner: the target is printed before anything runs against it, so
// it's never something you have to infer from which terminal you're in).
//
// The CSV mechanics and Dan's mapping rules (owner vs. income vs. expense,
// aliases, skip reasons) live in lib/ynabRegister.ts, pinned by
// scripts/test/ynabRegister.test.ts. This script is the thin, imperative
// shell around that pure module: read the file, resolve who and what account
// this is for, resolve category names against the DB, guard against a
// double-run, report, and — only with --commit — write.
//
// Without --commit this is entirely read-only: it connects, reads, computes
// a report, and writes nothing. Safe to run against production to preview.

import { readFileSync } from 'node:fs'
import pg from 'pg'

// Money arrives as integer cents and must stay that way; stop node-postgres
// handing back bigint as a JS number that could lose precision silently.
pg.types.setTypeParser(20, (v) => Number(v))

const USAGE = `Usage: node --env-file=.env.local scripts/import/ynab-backfill.mjs [--prod] [--commit] <csv-path> [--account "Name"] [--start 2026-01-01]

  <csv-path>   YNAB "Register" CSV export for the budget (Account > Export)
  --account    The YNAB account name to import, both to pick the ledger
               account in the database (by name) and to filter the CSV to
               that account's rows. Required when the CSV has more than one
               distinct account, or when it isn't the database's one open
               ledger account by name. Auto-detected and printed when the
               CSV has exactly one distinct account and this flag is omitted.
  --start      Backfill start date, YYYY-MM-DD. Default 2026-01-01.
  --prod       Target DATABASE_URL_PROD instead of DATABASE_URL.
  --commit     Actually write. Without it: a dry run — connects, reads,
               reports, writes nothing.
`

function parseArgs(argv) {
  const out = { prod: false, commit: false, help: false, csvPath: null, account: null, start: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { out.help = true; continue }
    if (a === '--prod') { out.prod = true; continue }
    if (a === '--commit') { out.commit = true; continue }
    if (a === '--account') { out.account = argv[i += 1] ?? null; continue }
    if (a === '--start') { out.start = argv[i += 1] ?? null; continue }
    if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`)
    if (out.csvPath !== null) throw new Error(`Unexpected extra argument: "${a}"`)
    out.csvPath = a
  }
  return out
}

const money = (cents) => {
  const negative = cents < 0
  const abs = Math.abs(cents)
  const formatted = '$' + (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return negative ? `-${formatted}` : formatted
}

const SKIP_REASONS = ['other-account', 'before-start', 'starting-balance', 'zero-amount']
const KINDS = ['income', 'expense', 'owner_pay', 'transfer']

/**
 * Everything that can be computed WITHOUT a database connection: reading and
 * parsing the CSV, resolving which YNAB account's rows to keep, and mapping
 * every row through lib/ynabRegister.ts. Split out so it can (and, in the
 * smoke test, does) run and fail on its own — a bad CSV or a bad --account
 * should never even attempt to open a connection.
 */
async function readAndMap(opts) {
  const { parseYnabRegister, mapYnabRow } = await import('../../lib/ynabRegister.ts')

  let csvText
  try {
    csvText = readFileSync(opts.csvPath, 'utf8')
  } catch (e) {
    throw new Error(`Can't read "${opts.csvPath}": ${e.message}`)
  }

  const rows = parseYnabRegister(csvText)

  // The CSV-side filter name is NOT necessarily the ledger account's own
  // name — YNAB's account naming and Dan's /money account naming are two
  // separate things that happen to usually agree. --account, when given, is
  // used for both. Without it, the only safe default is "the CSV only talks
  // about one account" — anything more and this refuses to guess.
  let accountName
  if (opts.account) {
    accountName = opts.account
  } else {
    const distinct = [...new Set(rows.map((r) => r.account))]
    if (distinct.length === 0) throw new Error('The CSV has no data rows.')
    if (distinct.length > 1) {
      throw new Error(
        `The CSV contains ${distinct.length} different YNAB accounts (${distinct.join(', ')}). `
        + 'Pass --account "Name" to pick one.',
      )
    }
    accountName = distinct[0]
    console.log(`account (auto-detected from CSV): ${accountName}`)
  }

  const startDate = opts.start ?? '2026-01-01'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new Error(`--start "${startDate}" isn't YYYY-MM-DD.`)
  }

  const skipCounts = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0]))
  const kindCounts = Object.fromEntries(KINDS.map((k) => [k, 0]))
  const kindTotals = Object.fromEntries(KINDS.map((k) => [k, 0]))
  const categoryCounts = new Map() // categoryName -> count, across every kind that carries one
  const mapped = [] // MappedTxn[]
  let minDate = null
  let maxDate = null

  for (const row of rows) {
    const outcome = mapYnabRow(row, { accountName, startDate })
    if (outcome.kind === 'skip') {
      skipCounts[outcome.reason] += 1
      continue
    }
    const { txn } = outcome
    kindCounts[txn.kind] += 1
    kindTotals[txn.kind] += txn.amountCents
    if (minDate === null || txn.date < minDate) minDate = txn.date
    if (maxDate === null || txn.date > maxDate) maxDate = txn.date
    if (txn.categoryName !== null) {
      categoryCounts.set(txn.categoryName, (categoryCounts.get(txn.categoryName) ?? 0) + 1)
    }
    mapped.push(txn)
  }

  return {
    rowsRead: rows.length, accountName, startDate,
    skipCounts, kindCounts, kindTotals, categoryCounts, mapped, minDate, maxDate,
  }
}

function printReport(result, account, status) {
  const { rowsRead, accountName, startDate, skipCounts, kindCounts, kindTotals,
    categoryCounts, unmapped, minDate, maxDate } = result

  console.log(`\naccount        ${account.name}  (YNAB CSV account: "${accountName}")`)
  console.log(`start date     ${startDate}`)
  console.log(`rows read      ${rowsRead}`)

  console.log('\nskipped:')
  for (const r of SKIP_REASONS) console.log(`  ${r.padEnd(16)} ${skipCounts[r]}`)

  console.log('\nimported by kind:')
  for (const k of KINDS) {
    console.log(`  ${k.padEnd(12)} ${String(kindCounts[k]).padStart(5)}   ${money(kindTotals[k]).padStart(14)}`)
  }

  if (categoryCounts.size) {
    console.log('\nby category:')
    for (const [name, count] of [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name.padEnd(32)} ${count}`)
    }
  }

  if (unmapped.size) {
    console.log('\nUNMAPPED category names (no matching ledger_categories row — left uncategorized):')
    for (const [name, count] of [...unmapped.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name.padEnd(32)} ${count}`)
    }
  } else {
    console.log('\nevery mapped category name matched an existing ledger category.')
  }

  console.log(`\nowner pay total          ${money(kindTotals.owner_pay)}`)
  console.log(`owner investment total   ${money(kindTotals.transfer)}   (inflow to the account, not income)`)
  console.log(`date range               ${minDate ?? '(none)'} .. ${maxDate ?? '(none)'}`)

  const delta = KINDS.reduce((t, k) => t + kindTotals[k], 0)
  const endingBalance = account.opening_balance_cents + delta
  console.log(`\nopening balance (${account.opening_date})   ${money(account.opening_balance_cents)}`)
  console.log(`computed ending balance          ${money(endingBalance)}`)
  console.log("Compare this against the bank's actual current balance before --commit.")

  console.log(`\n${status}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { console.log(USAGE); return }
  if (!opts.csvPath) { console.error(USAGE); process.exitCode = 1; return }

  // Everything above this line, and everything inside readAndMap, is pure —
  // no database touched yet. A bad CSV or an ambiguous --account fails here,
  // before a connection is ever opened.
  const result = await readAndMap(opts)

  // --- from here on, database -------------------------------------------
  const varName = opts.prod ? 'DATABASE_URL_PROD' : 'DATABASE_URL'
  const url = process.env[varName]
  if (!url) {
    console.error(`${varName} is not set. Add it to .env.local first (see scripts/run-sql.mjs's comment).`)
    process.exitCode = 1
    return
  }
  if (url.includes('PASTE_')) {
    console.error(`${varName} still contains a placeholder — fill in the real value in .env.local.`)
    process.exitCode = 1
    return
  }

  // Say which database this is before touching it — the project ref is the
  // only unambiguous identifier; host and port are nearly identical between
  // projects. Same rule as scripts/run-sql.mjs's --prod banner.
  const ref = (url.match(/postgres\.([a-z0-9]+)/) || [])[1] ?? 'unknown'
  console.log(opts.prod
    ? `\n  ⚠  PRODUCTION  (${ref})  — ${opts.csvPath}\n`
    : `  dev (${ref}) — ${opts.csvPath}`)

  const client = new pg.Client({ connectionString: url })
  await client.connect()

  try {
    const { rows: users } = await client.query(
      'select id, email from auth.users order by created_at limit 2',
    )
    if (users.length === 0) {
      throw new Error(
        'No user exists yet. Create one in the Supabase dashboard:\n'
        + '  Authentication > Users > Add user > Create new user\n'
        + '  (tick "Auto Confirm User")',
      )
    }
    if (users.length > 1) {
      throw new Error('More than one user found. This app assumes a single owner.')
    }
    const owner = users[0].id
    console.log(`owner: ${users[0].email}`)

    // Resolve the ledger account this backfill writes into. --account
    // matches by name (also the CSV-side filter, resolved in readAndMap);
    // without it, there must be exactly one open account to be unambiguous.
    let account
    if (opts.account) {
      const { rows } = await client.query(
        `select id, name, opening_balance_cents, opening_date::text as opening_date
           from ledger_accounts where owner_id = $1 and closed = false and name = $2`,
        [owner, opts.account],
      )
      if (rows.length === 0) {
        throw new Error(`No open ledger account named "${opts.account}". Create it in /money first, or check the spelling.`)
      }
      account = rows[0]
    } else {
      const { rows } = await client.query(
        `select id, name, opening_balance_cents, opening_date::text as opening_date
           from ledger_accounts where owner_id = $1 and closed = false`,
        [owner],
      )
      if (rows.length === 0) {
        throw new Error('No ledger account exists yet. Create one in /money first.')
      }
      if (rows.length > 1) {
        throw new Error(
          `More than one open ledger account exists (${rows.map((r) => r.name).join(', ')}). `
          + 'Pass --account "Name" to pick one.',
        )
      }
      account = rows[0]
    }

    // Resolve category NAMES against this owner's actual chart. Unknown
    // names (a category Dan renamed, deleted, or never seeded) are left
    // uncategorized rather than guessed at, and tallied so the report shows
    // exactly what needs a category assigned by hand afterward.
    const { rows: cats } = await client.query(
      'select id, name from ledger_categories where owner_id = $1',
      [owner],
    )
    const categoryIdByName = new Map(cats.map((c) => [c.name, c.id]))
    const unmapped = new Map()
    const withCategoryId = result.mapped.map((txn) => {
      if (txn.categoryName === null) return { ...txn, category_id: null }
      const category_id = categoryIdByName.get(txn.categoryName) ?? null
      if (category_id === null) {
        unmapped.set(txn.categoryName, (unmapped.get(txn.categoryName) ?? 0) + 1)
      }
      return { ...txn, category_id }
    })
    result.unmapped = unmapped

    // Refuse if this account already has anything: no --reset. A redo of a
    // backfill is a deliberate SQL wipe, not a flag, the same rule
    // load.mjs's --reset deliberately does NOT offer for this script.
    const { rows: [{ count: existing }] } = await client.query(
      'select count(*) from ledger_transactions where account_id = $1',
      [account.id],
    )
    if (Number(existing) > 0) {
      throw new Error(
        `${existing} ledger_transactions row(s) already exist for "${account.name}". `
        + 'This is a one-off backfill with no --reset — wipe them with an explicit SQL '
        + 'delete first if you really mean to redo it.',
      )
    }

    if (!opts.commit) {
      printReport(result, account, 'DRY RUN — nothing written.')
      return
    }

    await client.query('begin')

    // Bulk insert, chunked to stay well under Postgres's parameter limit.
    // source: 'manual' + import_id: null is DELIBERATE, not an oversight: a
    // future OFX statement import runs these same rows through
    // lib/ledgerImport.ts's matcher, which treats an unlinked manual row as
    // adoptable (same amount, ±10 days) and gives it the bank's import_id
    // instead of inserting a duplicate. Marking these 'import' now would
    // make every one of them permanently unmatchable to its real bank line.
    const CHUNK = 500
    for (let i = 0; i < withCategoryId.length; i += CHUNK) {
      const slice = withCategoryId.slice(i, i + CHUNK)
      const params = [owner, account.id]
      const values = slice.map((t) => {
        const base = params.length
        params.push(t.date, t.amountCents, t.kind, t.category_id, t.payee, t.memo, t.cleared)
        return `($1,$2,$${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},'manual',null)`
      })
      await client.query(
        `insert into ledger_transactions
           (owner_id, account_id, date, amount_cents, kind, category_id, payee, memo, cleared, source, import_id)
         values ${values.join(',')}`,
        params,
      )
    }

    await client.query('commit')
    printReport(result, account, 'COMMITTED.')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    console.error('\nFAILED:', e.message)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exitCode = 1
})
