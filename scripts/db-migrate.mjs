// Apply pending SQL migrations, in order, exactly once, and record what ran.
//
//   npm run db:migrate                 apply pending to DEV
//   npm run db:migrate -- --status     list applied and pending, change nothing
//   npm run db:migrate -- --prod       apply pending to PRODUCTION
//   npm run db:migrate -- --baseline   record all files as applied WITHOUT running
//
// WHY THIS EXISTS
// ---------------
// Before this, scripts/sql/ held 24 migrations with no order, no record of what
// had been applied where, and several that superseded earlier ones. That was
// survivable with one database. With two it is not: the whole value of a dev
// database is that it is identical to production, and nothing was keeping them
// that way. See CLAUDE.md for the layout of scripts/sql/.
//
// RULES THIS ENFORCES
//   * Filename order is apply order. Number them: 0001_, 0002_, …
//   * A migration runs exactly once per database. Re-running is a no-op.
//   * An applied migration is IMMUTABLE. Its checksum is recorded, and editing
//     it afterwards is refused loudly — because the database still holds the old
//     version's effects while the file claims otherwise, and that divergence is
//     invisible until something breaks much later.
//   * Each migration runs inside a transaction, so a failure leaves nothing
//     half-applied. A migration that genuinely cannot run in one (CREATE INDEX
//     CONCURRENTLY, for instance) opts out with `-- migrate:no-transaction` on
//     the first line, and is then responsible for its own cleanup on failure.
//
// WHEN TO USE --baseline
// ----------------------
// `npm run db:schema` regenerates schema.sql FROM PRODUCTION, so it already
// contains every migration applied there. Build a fresh database from that file
// and those migrations are present but unrecorded — the runner would try to
// apply them a second time. --baseline records them as done without executing.
// Use it immediately after building a database from schema.sql, and at no other
// time: on a database that genuinely has not had them applied, it silently
// skips real work.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import pg from 'pg'

const DIR = join('scripts', 'sql', 'migrations')
const LOCK_KEY = 4_827_193_004 // arbitrary, constant; guards against two concurrent runs

const args = process.argv.slice(2)
const prod = args.includes('--prod')
const status = args.includes('--status')
const baseline = args.includes('--baseline')

const varName = prod ? 'DATABASE_URL_SESSION_PROD' : 'DATABASE_URL_SESSION'
const url = process.env[varName]
if (!url) {
  console.error(`${varName} is not set in .env.local.`)
  process.exit(1)
}
// Migrations are DDL: use the SESSION pooler (5432). The transaction pooler
// (6543) multiplexes connections and does not reliably hold session state such
// as advisory locks.
if (url.includes(':6543')) {
  console.error(`${varName} points at the transaction pooler (6543). Migrations need the session pooler (5432).`)
  process.exit(1)
}

const ref = (url.match(/postgres\.([a-z0-9]+)/) || [])[1] ?? 'unknown'
const label = prod ? `⚠  PRODUCTION (${ref})` : `dev (${ref})`

const files = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
  : []

const sum = (f) => createHash('sha256').update(readFileSync(join(DIR, f))).digest('hex').slice(0, 16)

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()

try {
  await client.query(`
    create table if not exists public.schema_migrations (
      filename   text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )`)
  // Never reachable through the API. RLS with no policies denies everyone; the
  // revoke is belt-and-braces for a database whose default privileges grant new
  // tables to anon/authenticated (production does exactly that).
  await client.query(`alter table public.schema_migrations enable row level security`)
  await client.query(`revoke all on table public.schema_migrations from anon, authenticated`)

  const { rows: appliedRows } = await client.query('select filename, checksum, applied_at from public.schema_migrations order by filename')
  const applied = new Map(appliedRows.map((r) => [r.filename, r]))

  // An applied migration whose file has since changed means the database and the
  // repo disagree about what was run. Refuse before doing anything else.
  const drifted = files.filter((f) => applied.has(f) && applied.get(f).checksum !== sum(f))
  if (drifted.length) {
    console.error(`\n${label}\n`)
    console.error('These migrations were applied, then edited:\n')
    for (const f of drifted) console.error(`  ${f}  recorded ${applied.get(f).checksum}, file is now ${sum(f)}`)
    console.error(`
The database still holds what the ORIGINAL version did. Editing an applied
migration cannot change that — it only hides the difference.

Write a new migration that makes the change instead, and restore these files.`)
    process.exit(1)
  }

  const pending = files.filter((f) => !applied.has(f))

  if (status) {
    console.log(`\n${label}\n`)
    if (!files.length) console.log('  No migration files yet.')
    for (const f of files) {
      const a = applied.get(f)
      console.log(a ? `  ✓ ${f}  ${a.applied_at.toISOString().slice(0, 16).replace('T', ' ')}` : `  · ${f}  PENDING`)
    }
    for (const [f, a] of applied) {
      if (!files.includes(f)) console.log(`  ? ${f}  applied but the file is gone (${a.checksum})`)
    }
    console.log(`\n  ${applied.size} applied, ${pending.length} pending`)
    process.exit(0)
  }

  if (!pending.length) {
    console.log(`${label} — nothing to do (${applied.size} already applied)`)
    process.exit(0)
  }

  if (baseline) {
    console.log(`\n${label}\n\nRecording as applied WITHOUT running:`)
    for (const f of pending) {
      await client.query('insert into public.schema_migrations (filename, checksum) values ($1,$2)', [f, sum(f)])
      console.log(`  = ${f}`)
    }
    console.log(`\n${pending.length} recorded. Nothing was executed.`)
    process.exit(0)
  }

  const { rows: [{ got }] } = await client.query('select pg_try_advisory_lock($1) as got', [LOCK_KEY])
  if (!got) {
    console.error('Another migration run holds the lock. Wait for it to finish.')
    process.exit(1)
  }

  console.log(`\n${label}\n\nApplying ${pending.length} migration(s):`)
  for (const f of pending) {
    const sql = readFileSync(join(DIR, f), 'utf8')
    const noTx = /^\s*--\s*migrate:no-transaction/m.test(sql.split('\n')[0] ?? '')
    process.stdout.write(`  ${f}${noTx ? ' (no transaction)' : ''} … `)
    try {
      if (!noTx) await client.query('begin')
      await client.query(sql)
      await client.query('insert into public.schema_migrations (filename, checksum) values ($1,$2)', [f, sum(f)])
      if (!noTx) await client.query('commit')
      console.log('ok')
    } catch (e) {
      if (!noTx) await client.query('rollback').catch(() => {})
      console.log('FAILED')
      console.error(`\n  ${e.message}\n`)
      console.error(noTx
        ? '  This migration opted out of a transaction, so it may be half-applied. Check before retrying.'
        : '  Rolled back; nothing from this migration was applied. Later migrations were not attempted.')
      process.exitCode = 1
      break
    }
  }
  await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
  if (!process.exitCode) console.log('\nDone.')
} finally {
  await client.end()
}
