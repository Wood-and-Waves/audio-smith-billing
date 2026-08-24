// YNAB "Plan" export -> ledger_budget_moves.
//
//   npm run import:plan -- <plan.csv> --start 2026-01              -> DRY RUN, dev
//   npm run import:plan -- --commit <plan.csv> --start 2026-01     -> writes, dev
//   npm run import:plan -- --prod --commit <plan.csv> --start 2026-01
//   npm run import:plan -- --commit --replace <plan.csv> --start 2026-01
//
// Dry by default and writing only with --commit, matching
// scripts/import/ynab-backfill.mjs. Without --commit this connects, reads,
// reports and writes nothing, so it is safe to preview against production.
//
// One move per category per month, from Ready to Assign into the category. The
// month BEFORE --start is imported differently: its AVAILABLE column, not its
// Assigned, becomes a single opening move per category, because that is what
// carries into the first real month.
//
// BACKFILL TOOL: a committing run first clears this owner's moves from the
// opening month onward, then rewrites them. AFTER PHASE TWO, hand-entered moves
// live in the same table and a re-run would DELETE THEM SILENTLY. Use
// --replace to acknowledge and proceed; a committing run without it will refuse
// if any moves exist. Dry runs are unaffected.

import { readFileSync } from 'node:fs'
import pg from 'pg'
import { parseYnabPlan } from '../../lib/ynabPlan.ts'
import { OPENING_MONTH } from '../../lib/budget.ts'

// Money arrives as integer cents and must stay that way; stop node-postgres
// handing back bigint as a JS number that could lose precision silently.
// (Copied from ynab-backfill.mjs, which needs it for the same reason.)
pg.types.setTypeParser(20, (v) => Number(v))

const USAGE = `Usage: node --env-file=.env.local scripts/import/ynab-plan.mjs [--prod] [--commit] [--replace] <plan.csv> --start 2026-01

  <plan.csv>   YNAB "Plan" CSV export (Budget > Export), or pass the same
               path with --file.
  --start      First month to import at full strength, YYYY-MM. Required.
               The month before this is the opening seed: its Available
               column (not Assigned) becomes one carry-in move per category.
  --prod       Target DATABASE_URL_PROD instead of DATABASE_URL.
  --commit     Actually write. Without it: a dry run — the delete and every
               insert really run, inside a transaction that is then rolled
               back, so nothing is written but nothing about the report is
               make-believe either. If any moves exist in the table, --replace
               is required to proceed.
  --replace    Acknowledge and proceed even if the table has existing moves —
               they will be deleted. Required when --commit finds any moves.
  --dry        Explicit synonym for the default (no --commit). Rejected
               together with --commit, which would otherwise be a
               contradiction.
`

// A flag's value must not itself look like a flag — without this, `--start
// --commit` (a `--start` with nothing after it, immediately followed by the
// next real flag) silently eats "--commit" as if it were the month, leaving
// out.start = '--commit' and out.commit still false: a run that LOOKS like
// it committed but was actually, silently, a dry run (item 6).
function takeValue(argv, i, flagName) {
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`${flagName} needs a value (got ${v === undefined ? 'nothing' : `"${v}"`}).`)
  }
  return v
}

function parseArgs(argv) {
  const out = { prod: false, commit: false, replace: false, dry: false, help: false, csvPath: null, start: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { out.help = true; continue }
    if (a === '--prod') { out.prod = true; continue }
    if (a === '--commit') { out.commit = true; continue }
    if (a === '--replace') { out.replace = true; continue }
    if (a === '--dry') { out.dry = true; continue }
    if (a === '--file') { out.csvPath = takeValue(argv, i, '--file'); i += 1; continue }
    if (a === '--start') { out.start = takeValue(argv, i, '--start'); i += 1; continue }
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

/** '2026-01' -> '2025-12'. The month whose Available column seeds the opener. */
function monthBefore(ym) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 - 1, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** A signed cents figure -> a { from_category_id, to_category_id, amount_cents } triple. */
function directedMove(categoryId, signedCents) {
  return signedCents > 0
    ? { from_category_id: null, to_category_id: categoryId, amount_cents: signedCents }
    : { from_category_id: categoryId, to_category_id: null, amount_cents: -signedCents }
}

/**
 * Everything computable WITHOUT a database connection: reading and parsing
 * the CSV, grouping rows by category name, and deciding — purely from the
 * numbers — which categories actually need to be written and which can be
 * skipped. Split out so a bad CSV or a bad --start fails here, before a
 * connection is ever opened.
 */
function readAndGroup(opts) {
  let csvText
  try {
    csvText = readFileSync(opts.csvPath, 'utf8')
  } catch (e) {
    throw new Error(`Can't read "${opts.csvPath}": ${e.message}`)
  }

  const rows = parseYnabPlan(csvText)
  const openingMonth = monthBefore(opts.start)

  // Group the flat CSV rows by category name. Names are unique per owner in
  // ledger_categories (and, in practice, in this export too), so name is the
  // only key that matters — the YNAB "Category Group" is read once per
  // category, not once per row, since a category does not change groups
  // between months in this file.
  const byName = new Map() // name -> { grp, rows: YnabPlanRow[] }
  for (const r of rows) {
    if (!byName.has(r.category)) byName.set(r.category, { grp: r.grp, rows: [] })
    byName.get(r.category).rows.push(r)
  }

  let hiddenGroupRows = 0
  const noActivity = [] // category names with nothing to write, in any direction
  const needed = [] // { name, openingCents, regularRows: [{month, assignedCents}] }

  for (const [name, { grp, rows: catRows }] of byName) {
    // YNAB's own "Hidden Categories" group holds categories retired from the
    // live budget entirely — there is no ledger_categories row for these and
    // there never will be. Distinct from ledger_categories.hidden, which
    // marks a category retired on OUR side but which still matches by name.
    if (grp === 'Hidden Categories') {
      hiddenGroupRows += catRows.length
      continue
    }

    const openingRow = catRows.find((r) => r.month === openingMonth)
    const openingCents = openingRow?.availableCents ?? 0
    const regularRows = catRows
      .filter((r) => r.month >= opts.start && r.assignedCents !== 0)
      .map((r) => ({ month: r.month, assignedCents: r.assignedCents }))

    // A category that never carries a nonzero dollar in the imported range
    // writes nothing either way, so its name never has to resolve against
    // ledger_categories — matching it would be pointless and refusing to
    // match it would be a false failure over a category that does not
    // affect the budget at all.
    if (openingCents === 0 && regularRows.length === 0) {
      noActivity.push(name)
      continue
    }

    needed.push({ name, openingCents, regularRows })
  }

  return { rowsRead: rows.length, openingMonth, hiddenGroupRows, noActivity, needed }
}

function printReport(result, status) {
  const { openingMonth, hiddenGroupRows, noActivity, needed, monthsCovered, movesWritten, openingTotal, openingCount, assignedByYear } = result

  console.log(`\nstart month      ${result.start}`)
  console.log(`opening month    ${openingMonth}`)
  console.log(`rows read        ${result.rowsRead}`)

  console.log(`\nskipped ${hiddenGroupRows} row(s) in YNAB's own "Hidden Categories" group — no ledger_categories row exists or ever will for those.`)
  if (noActivity.length) {
    console.log(`skipped ${noActivity.length} categor${noActivity.length === 1 ? 'y' : 'ies'} with nothing to write (zero every month, ${openingMonth} through the end of the file):`)
    for (const name of [...noActivity].sort()) console.log(`  ${name}`)
  } else {
    console.log('skipped 0 categories for having nothing to write.')
  }

  console.log(`\nevery category with money to move matched an existing ledger_categories row (${needed.length} of them).`)

  console.log(`\nmonths covered   ${monthsCovered[0]} .. ${monthsCovered.at(-1)}  (${monthsCovered.length} months)`)
  console.log(`moves written    ${movesWritten}`)

  console.log(`\nopening total (${openingMonth})   ${money(openingTotal)}  across ${openingCount} categor${openingCount === 1 ? 'y' : 'ies'}:`)
  for (const n of needed) {
    if (n.openingCents !== 0) console.log(`  ${n.name.padEnd(32)} ${money(n.openingCents)}`)
  }

  console.log('\ntotal assigned by year:')
  for (const [year, cents] of [...assignedByYear.entries()].sort()) {
    console.log(`  ${year}   ${money(cents)}`)
  }

  console.log(`\n${status}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { console.log(USAGE); return }
  if (!opts.csvPath || !opts.start) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  if (!/^\d{4}-\d{2}$/.test(opts.start)) {
    console.error(`--start "${opts.start}" isn't YYYY-MM.`)
    process.exitCode = 1
    return
  }
  // I3: this script and lib/budget.ts's buildBudget only agree on where the
  // opening seed lives by convention — buildBudget always starts its
  // carry-in at the hardcoded OPENING_MONTH, no matter what --start this
  // script was run with. They happen to agree for --start 2026-01, and
  // nothing enforced that. With a later --start, the delete below (`month >=
  // opening month`) would no longer reach the PREVIOUS run's real opening
  // rows — those stay in the table, and this run's own opening rows for the
  // new (wrong) opening month get written alongside them, so the carry-in is
  // counted twice and every later month inflates. Refuse outright instead.
  const openingMonth = monthBefore(opts.start)
  if (openingMonth !== OPENING_MONTH) {
    console.error(
      `--start ${opts.start} opens at ${openingMonth}, but lib/budget.ts's OPENING_MONTH is `
      + `${OPENING_MONTH}. buildBudget always starts its carry-in at OPENING_MONTH, so the two `
      + 'must agree — otherwise this run\'s delete misses the previous run\'s real opening rows '
      + 'and the carry-in gets written twice.',
    )
    process.exitCode = 1
    return
  }
  if (opts.dry && opts.commit) {
    console.error('--dry and --commit are contradictory. Pick one.')
    process.exitCode = 1
    return
  }

  // Everything above this line, and everything inside readAndGroup, is pure
  // — no database touched yet. A bad CSV or a bad --start fails here, before
  // a connection is ever opened.
  const result = readAndGroup(opts)
  result.start = opts.start

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

    // Resolve category NAMES against this owner's actual chart. Hidden
    // ledger_categories rows are included on purpose — Bank Fees and
    // Subscriptions are retired on our side but still match by name if
    // the plan ever needs them.
    const { rows: cats } = await client.query(
      'select id, name from ledger_categories where owner_id = $1',
      [owner],
    )
    const categoryIdByName = new Map(cats.map((c) => [c.name, c.id]))

    const unmatched = result.needed.filter((n) => !categoryIdByName.has(n.name)).map((n) => n.name)
    if (unmatched.length) {
      throw new Error(
        `${unmatched.length} plan categor${unmatched.length === 1 ? 'y has' : 'ies have'} money to move but no matching `
        + `ledger_categories row: ${unmatched.join(', ')}. Add the category (or fix the name) before importing — `
        + 'a silently skipped category is a budget that quietly does not add up.',
      )
    }

    // Check for existing moves before committing. If any exist and --commit was
    // given without --replace, refuse loudly to prevent accidental data loss.
    // Dry runs always proceed regardless (they'll rollback anyway).
    if (opts.commit && !opts.replace) {
      const { rows: existingMoves } = await client.query(
        'select count(*) as count, min(month) as first_month, max(month) as last_month from ledger_budget_moves where owner_id = $1 and month >= $2',
        [owner, `${result.openingMonth}-01`],
      )
      if (existingMoves[0].count > 0) {
        const count = parseInt(existingMoves[0].count, 10)
        const firstMonth = existingMoves[0].first_month?.slice(0, 7) ?? '?'
        const lastMonth = existingMoves[0].last_month?.slice(0, 7) ?? '?'
        console.error(
          `\nREFUSED: --commit found ${count} move(s) in ledger_budget_moves from ${firstMonth} to ${lastMonth}.`
          + '\nAfter phase two, hand-entered assignments live in this table alongside imports.'
          + '\nA re-run without --replace would DELETE them silently.'
          + '\nUse: npm run import:plan -- --commit --replace <plan.csv> --start 2026-01'
        )
        process.exitCode = 1
        await client.end()
        return
      }
    }

    // Build every move now, in JS, from the parsed numbers — this is exactly
    // what gets inserted, in both the dry run and the committing run.
    const moves = []
    for (const n of result.needed) {
      const id = categoryIdByName.get(n.name)
      if (n.openingCents !== 0) {
        moves.push({ month: `${result.openingMonth}-01`, note: 'YNAB opening balance', ...directedMove(id, n.openingCents) })
      }
      for (const r of n.regularRows) {
        moves.push({ month: `${r.month}-01`, note: null, ...directedMove(id, r.assignedCents) })
      }
    }

    result.monthsCovered = [...new Set(moves.map((m) => m.month.slice(0, 7)))].sort()
    result.movesWritten = moves.length
    const openingMoves = moves.filter((m) => m.month.slice(0, 7) === result.openingMonth)
    result.openingCount = openingMoves.length
    result.openingTotal = openingMoves.reduce(
      (s, m) => s + (m.to_category_id ? m.amount_cents : -m.amount_cents), 0,
    )
    result.assignedByYear = new Map()
    for (const n of result.needed) {
      for (const r of n.regularRows) {
        const year = r.month.slice(0, 4)
        result.assignedByYear.set(year, (result.assignedByYear.get(year) ?? 0) + r.assignedCents)
      }
    }

    // Idempotent by deletion: clear this owner's moves from the opening
    // month onward, then rewrite them, all inside one transaction. Run for
    // real even on a dry run — and then rolled back — so the report reflects
    // the actual delete and the actual inserts, constraints included, not a
    // JS-side guess at what they would do.
    await client.query('begin')

    await client.query(
      'delete from ledger_budget_moves where owner_id = $1 and month >= $2',
      [owner, `${result.openingMonth}-01`],
    )

    const CHUNK = 500
    for (let i = 0; i < moves.length; i += CHUNK) {
      const slice = moves.slice(i, i + CHUNK)
      const params = [owner]
      const values = slice.map((m) => {
        const base = params.length
        params.push(m.month, m.from_category_id, m.to_category_id, m.amount_cents, m.note)
        return `($1,$${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`
      })
      await client.query(
        `insert into ledger_budget_moves (owner_id, month, from_category_id, to_category_id, amount_cents, note)
         values ${values.join(',')}`,
        params,
      )
    }

    if (opts.commit) {
      await client.query('commit')
      printReport(result, 'COMMITTED.')
    } else {
      await client.query('rollback')
      printReport(result, 'DRY RUN — the delete and every insert ran for real, then rolled back. Nothing written.')
    }
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
