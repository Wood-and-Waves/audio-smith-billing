// One-time Dropbox hookup, run by Dan in his own terminal.
//
//   npm run dropbox:auth          walk the OAuth flow; writes the refresh
//                                 token into .env.local (never printed)
//   npm run dropbox:auth -- --push   copy the three DROPBOX_* values from
//                                 .env.local into Vercel production env
//
// Exists because the archive feature shipped with placeholder values in
// Vercel — three 11-character stubs — and every upload since has failed
// with invalid_client. No secret value is ever echoed to the terminal:
// the token goes straight into .env.local, and --push pipes values into
// `vercel env add`'s stdin.
//
// Prerequisite for the auth flow: DROPBOX_APP_KEY and DROPBOX_APP_SECRET
// filled in .env.local, copied from the app's page at
// https://www.dropbox.com/developers/apps (the app with "App folder" access).

import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { spawnSync } from 'node:child_process'

const ENV_PATH = '.env.local'
const NAMES = ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN']

function readEnvValue(name) {
  const line = readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`))
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

async function verify(accessToken) {
  const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '', recursive: false }),
  })
  return res.ok
}

async function authFlow() {
  const appKey = readEnvValue('DROPBOX_APP_KEY')
  const appSecret = readEnvValue('DROPBOX_APP_SECRET')
  if (!appKey || !appSecret || appKey.length < 12 || appSecret.length < 12) {
    console.log('First fill DROPBOX_APP_KEY and DROPBOX_APP_SECRET in .env.local.')
    console.log('They are on your app\'s page at https://www.dropbox.com/developers/apps')
    console.log('(App key is shown; App secret is behind a "Show" link.)')
    process.exit(1)
  }

  console.log('\n1. Open this link, sign in if asked, and click Allow:\n')
  console.log(`   https://www.dropbox.com/oauth2/authorize?client_id=${appKey}&response_type=code&token_access_type=offline\n`)
  console.log('2. Dropbox will show an access code. Paste it here.\n')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const code = (await rl.question('Access code: ')).trim()
  rl.close()
  if (!code) { console.log('No code entered — nothing changed.'); process.exit(1) }

  const basic = Buffer.from(`${appKey}:${appSecret}`).toString('base64')
  const body = new URLSearchParams({ grant_type: 'authorization_code', code })
  const res = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.refresh_token) {
    console.log(`Dropbox refused the code (HTTP ${res.status}${json.error ? `, ${json.error}` : ''}). Try again with a fresh code.`)
    process.exit(1)
  }

  if (!(await verify(json.access_token))) {
    console.log('Got a token but Dropbox refused a folder listing with it — not saving. Check the app\'s permissions (files.content.write, files.content.read) and retry.')
    process.exit(1)
  }

  writeEnvValue('DROPBOX_REFRESH_TOKEN', json.refresh_token)
  console.log('\nConnected and verified. The refresh token is saved in .env.local (not shown).')
  console.log('Now put all three values into production:\n')
  console.log('   npm run dropbox:auth -- --push\n')
}

function pushToVercel() {
  for (const name of NAMES) {
    const value = readEnvValue(name)
    if (!value || value.length < 12) {
      console.log(`${name} in .env.local looks unset or like a placeholder — run the auth flow first.`)
      process.exit(1)
    }
  }
  for (const name of NAMES) {
    const value = readEnvValue(name)
    // rm is best-effort (the var may not exist); add reads the value from
    // stdin so it never appears in a process list or on screen.
    spawnSync('npx', ['vercel', 'env', 'rm', name, 'production', '-y'], { stdio: ['ignore', 'ignore', 'ignore'] })
    const add = spawnSync('npx', ['vercel', 'env', 'add', name, 'production'], {
      input: value, stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8',
    })
    if (add.status !== 0) {
      console.log(`Vercel refused ${name}: ${(add.stderr ?? '').slice(0, 200)}`)
      process.exit(1)
    }
    console.log(`${name}: updated in Vercel production.`)
  }
  console.log('\nDone. Redeploy so the running app picks the values up:')
  console.log('   npx vercel redeploy --prod\n')
  console.log('(Or push any commit — every deploy reads the fresh env.)')
}

if (process.argv.includes('--push')) pushToVercel()
else await authFlow()
