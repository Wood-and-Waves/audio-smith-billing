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

// The archive only ever UPLOADS (lib/dropbox.ts's uploadAndVerify reads the
// upload response itself), so the one scope that matters is
// files.content.write. The first version of this script verified with a
// folder LISTING — which needs files.metadata.read, a permission the app
// doesn't use — and refused a perfectly good token over it.
function missingScopes(tokenJson) {
  const granted = String(tokenJson.scope ?? '').split(' ')
  return ['files.content.write'].filter((s) => !granted.includes(s))
}

// The only verification that cannot lie: do what the archive does. A tiny
// upload into the app folder proves the whole chain — token, scope, folder —
// and leaves a visible file as evidence. (An account-info ping was tried
// here first and refused on a working setup; probing an ADJACENT capability
// answers a question nobody asked.)
async function probeUpload(accessToken) {
  const arg = JSON.stringify({
    path: '/connection-test.txt', mode: 'add', autorename: true, mute: true,
  })
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': arg,
      'Content-Type': 'application/octet-stream',
    },
    body: `Connected ${new Date().toISOString()}\n`,
  })
  if (res.ok) return { ok: true }
  const text = await res.text().catch(() => '')
  return { ok: false, detail: `HTTP ${res.status} ${text.slice(0, 200)}` }
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

  const missing = missingScopes(json)
  if (missing.length > 0) {
    console.log(`\nThe token is missing: ${missing.join(', ')}.`)
    console.log('On your app\'s page at https://www.dropbox.com/developers/apps open the')
    console.log('PERMISSIONS tab, tick "files.content.write" (and "files.content.read"),')
    console.log('click Submit — then run this again for a FRESH code. Permissions are')
    console.log('baked into the token when you click Allow, so the old code cannot work.')
    process.exit(1)
  }

  const probe = await probeUpload(json.access_token)
  if (!probe.ok) {
    console.log(`\nThe test upload failed — not saving. Dropbox said: ${probe.detail}`)
    console.log('\nDiagnostics (no secrets):')
    // Which KIND of token did Dropbox issue? A team-scoped app's tokens are
    // refused on user endpoints, which would explain every probe so far.
    console.log('  token fields:', JSON.stringify({
      token_type: json.token_type ?? null,
      scope: json.scope ?? null,
      has_account_id: 'account_id' in json,
      has_team_id: 'team_id' in json,
      has_uid: 'uid' in json,
    }))
    for (const [label, host, fn, body] of [
      ['get_current_account', 'api.dropboxapi.com', '2/users/get_current_account', undefined],
      ['list_folder', 'api.dropboxapi.com', '2/files/list_folder', JSON.stringify({ path: '' })],
    ]) {
      try {
        const r = await fetch(`https://${host}/${fn}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${json.access_token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body } : {}),
        })
        const t = await r.text().catch(() => '')
        console.log(`  ${label}: HTTP ${r.status} ${t.slice(0, 250).replace(/\s+/g, ' ')}`)
      } catch (e) {
        console.log(`  ${label}: threw ${e instanceof Error ? e.message : e}`)
      }
    }
    console.log('\nSend the lines above back and the cause will be nameable.')
    process.exit(1)
  }

  writeEnvValue('DROPBOX_REFRESH_TOKEN', json.refresh_token)
  console.log('\nConnected and PROVEN: a file named connection-test.txt was just uploaded')
  console.log('to the app\'s Dropbox folder — go look. The refresh token is saved in')
  console.log('.env.local (not shown).')
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

// --probe: bisect tool. The console's "Generate access token" button mints a
// token with no OAuth page involved — if an upload works with THAT, the app
// and the account are healthy and the fault is in the authorize flow's
// browser session; if it fails the same way, the account's API access is the
// problem and the fix is a Dropbox support ticket, not more apps.
async function probeFlow() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const token = (await rl.question(
    'Paste a token from the app console (Settings tab -> OAuth 2 -> Generate): ',
  )).trim()
  rl.close()
  if (!token) { console.log('Nothing pasted.'); process.exit(1) }
  const probe = await probeUpload(token)
  if (probe.ok) {
    console.log('\nUPLOAD WORKED. The app and account are fine — the authorize flow is the problem.')
  } else {
    console.log(`\nUpload failed the same way: ${probe.detail}`)
    console.log('That means the ACCOUNT\'s API access is restricted — Dropbox support territory.')
  }
}

if (process.argv.includes('--push')) pushToVercel()
else if (process.argv.includes('--probe')) await probeFlow()
else await authFlow()
