// One-time Gmail hookup, run by Dan in his own terminal.
//
//   npm run gmail:auth            walk the OAuth flow; writes the refresh
//                                 token into .env.local (never printed)
//   npm run gmail:auth -- --push  copy the three GMAIL_* values from
//                                 .env.local into Vercel production env
//
// Same shape and same discipline as scripts/dropbox-auth.mjs: no secret value
// is ever echoed, the token goes straight into .env.local, and --push pipes
// values into `vercel env add`'s stdin.
//
// SCOPE IS READ-ONLY, deliberately. Marking a receipt "done" is tracked in our
// own table instead of by relabelling the message, so this grant can never
// alter or delete anything in Dan's mailbox. gmail.modify would be more
// convenient and is not worth the blast radius.
//
// Prerequisites, from https://console.cloud.google.com:
//   1. A project with the Gmail API enabled.
//   2. OAuth consent screen: choose INTERNAL. Dan has Google Workspace, and
//      an internal app needs no Google verification AND its refresh tokens do
//      not expire. An "External / Testing" app looks like it works and then
//      silently stops after seven days — that is the trap this note exists
//      for.
//   3. Credentials -> OAuth client ID -> Desktop app. Put the id and secret in
//      .env.local as GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.

import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'

const ENV_PATH = '.env.local'
const NAMES = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const PORT = 4517 // arbitrary and local-only; must match the client's redirect URI

function readEnvValue(name) {
  const line = readFileSync(ENV_PATH, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`))
  return line ? line.slice(name.length + 1).trim() : ''
}

function writeEnvValue(name, value) {
  const lines = readFileSync(ENV_PATH, 'utf8').split('\n')
  const i = lines.findIndex((l) => l.startsWith(`${name}=`))
  const next = `${name}=${value}`
  if (i === -1) lines.push(next)
  else lines[i] = next
  writeFileSync(ENV_PATH, lines.join('\n'))
}

if (process.argv.includes('--push')) {
  for (const name of NAMES) {
    const value = readEnvValue(name)
    if (!value) { console.error(`${name} is empty in ${ENV_PATH} — run the auth flow first.`); process.exit(1) }
    spawnSync('vercel', ['env', 'rm', name, 'production', '--yes'], { stdio: 'ignore' })
    const r = spawnSync('vercel', ['env', 'add', name, 'production'], { input: `${value}\n` })
    console.log(`${name}: ${r.status === 0 ? 'pushed' : 'FAILED'}`)
  }
  process.exit(0)
}

const clientId = readEnvValue('GMAIL_CLIENT_ID')
const clientSecret = readEnvValue('GMAIL_CLIENT_SECRET')
if (!clientId || !clientSecret) {
  console.error(`Fill GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in ${ENV_PATH} first (see the header of this file).`)
  process.exit(1)
}

const redirectUri = `http://localhost:${PORT}`
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPE,
  // offline + consent is what actually returns a refresh token. Without
  // prompt=consent Google omits it on every grant after the first, and the
  // flow appears to succeed while producing nothing usable.
  access_type: 'offline',
  prompt: 'consent',
})

// A DESKTOP-type OAuth client accepts any http://localhost:PORT redirect
// without registering it — that is the whole reason to pick Desktop over Web
// here. Nothing to configure in the console; the loopback below just works.
console.log(`\nOpen this in the browser, signed in as the Workspace account:\n\n${authUrl}\n`)
console.log('Waiting for the redirect…')

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, redirectUri)
    const got = url.searchParams.get('code')
    const err = url.searchParams.get('error')

    // A browser asks for more than the redirect. Safari fetches /favicon.ico
    // the moment the page renders, and an earlier version of this treated ANY
    // request without a code as a failure — so the favicon killed a flow that
    // had already succeeded, reporting "no code in redirect" about a URL that
    // visibly contained one. Only a request actually carrying `code` or
    // `error` decides anything; everything else is answered and ignored.
    if (!got && !err) {
      res.writeHead(204)
      res.end()
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(got ? 'Authorised. Close this tab and return to the terminal.' : `Failed: ${err}`)
    server.close()
    if (got) resolve(got)
    else reject(new Error(err))
  })
  server.listen(PORT)
  setTimeout(() => { server.close(); reject(new Error('timed out after 5 minutes')) }, 300_000)
})

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code',
  }),
})
const json = await res.json()
if (!res.ok || !json.refresh_token) {
  // Never print the body: it can carry a token on the success path.
  console.error(`Token exchange failed (HTTP ${res.status})${json.error ? `: ${json.error}` : ''}`)
  console.error('If it succeeded but returned no refresh_token, revoke the app at')
  console.error('https://myaccount.google.com/permissions and run this again.')
  process.exit(1)
}

writeEnvValue('GMAIL_REFRESH_TOKEN', json.refresh_token)
console.log(`\nGMAIL_REFRESH_TOKEN written to ${ENV_PATH} (not printed).`)
console.log('Next: npm run gmail:auth -- --push')
