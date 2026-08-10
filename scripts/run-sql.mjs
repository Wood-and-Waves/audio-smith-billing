// One-off SQL runner against the Supabase Postgres database.
//
//   npm run db:sql -- path/to/file.sql            -> DEVELOPMENT (DATABASE_URL)
//   npm run db:sql -- --prod path/to/file.sql     -> PRODUCTION  (DATABASE_URL_PROD)
//
// The safe target is the default and production takes an explicit flag, because
// the failure mode here is silent: a migration run against the wrong database
// looks exactly like success. Every run prints the project ref it connected to
// before executing anything, so the target is never something you have to infer
// from which terminal you're in.
//
// Connection strings live in .env.local (Supabase dashboard -> Project Settings
// -> Database -> Connection string -> "Transaction pooler"). Never commit those
// values or paste them into chat.
//
// NOTE: this connects as a role that BYPASSES RLS. It can confirm a policy's
// text but can never prove enforcement — that needs a real session or the anon
// key. See CLAUDE.md "Past incidents".

import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const args = process.argv.slice(2)
const prod = args.includes('--prod')
const sqlPath = args.find((a) => !a.startsWith('--'))

if (!sqlPath) {
  console.error('Usage: npm run db:sql -- [--prod] <path-to-sql-file>')
  process.exit(1)
}

const varName = prod ? 'DATABASE_URL_PROD' : 'DATABASE_URL'
const url = process.env[varName]
if (!url) {
  console.error(`${varName} is not set. Add it to .env.local first (see comment at top of this file).`)
  process.exit(1)
}
if (url.includes('PASTE_')) {
  console.error(`${varName} still contains a placeholder — fill in the real value in .env.local.`)
  process.exit(1)
}

// Say which database this is before touching it. The project ref is the only
// unambiguous identifier; host and port are nearly identical between projects.
const ref = (url.match(/postgres\.([a-z0-9]+)/) || [])[1] ?? 'unknown'
console.log(prod
  ? `\n  ⚠  PRODUCTION  (${ref})  — ${sqlPath}\n`
  : `  dev (${ref}) — ${sqlPath}`)

const sql = readFileSync(sqlPath, 'utf8')

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
})

try {
  await client.connect()
  const result = await client.query(sql)
  const results = Array.isArray(result) ? result : [result]
  for (const r of results) {
    console.log(`${r.command || 'OK'} — ${r.rowCount ?? 0} row(s)`)
    if (r.rows?.length) console.table(r.rows)
  }
} catch (err) {
  console.error('SQL error:', err.message)
  process.exitCode = 1
} finally {
  await client.end()
}
