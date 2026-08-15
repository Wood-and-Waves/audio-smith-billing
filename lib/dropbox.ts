// Dropbox, over plain fetch.
//
// No SDK: this needs two endpoints, and the SDK would be a tenth runtime
// dependency for the sake of them.
//
// The app is registered with the "App folder" access type, so its root IS
// /Apps/{app name}/ and it can see nothing else in Dan's Dropbox. Paths here
// are therefore written as plain /receipts/... — an app-folder app addressing
// its own root.
//
// Credentials never appear in a log line. The only thing ever reported is
// whether a variable was PRESENT, by name.

import { dropboxContentHash } from './dropboxContentHash.ts'

export type DropboxCreds = {
  appKey: string
  appSecret: string
  refreshToken: string
}

/**
 * A short-lived access token, from the long-lived refresh token.
 *
 * Dropbox access tokens expire in about four hours, which is shorter than the
 * gap between nightly runs — so every run starts by exchanging.
 */
export async function getAccessToken(creds: DropboxCreds): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
  })
  const basic = Buffer.from(`${creds.appKey}:${creds.appSecret}`).toString('base64')

  const response = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    // The status only. A body from the token endpoint can echo parts of the
    // request, and this string ends up in a JSON response.
    throw new Error(`Dropbox refused the refresh token (HTTP ${response.status}).`)
  }
  const json = await response.json() as { access_token?: string }
  if (!json.access_token) throw new Error('Dropbox returned no access token.')
  return json.access_token
}

/**
 * The Dropbox-API-Arg header value.
 *
 * It travels in an HTTP header, so it must be plain ASCII — an accented vendor
 * name would otherwise make Dropbox reject the request outright. JSON's \uXXXX
 * escaping is what makes "Café" survive.
 */
export function uploadArg(path: string): string {
  const arg = JSON.stringify({ path, mode: 'add', autorename: true, mute: true })
  return arg.replace(/[\x7f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * Uploads one file and proves Dropbox stored exactly what was sent.
 *
 * Both checks matter, and they catch different things: size catches a truncated
 * upload, the content hash catches a corrupted one. This is the whole licence
 * for deleting the other copy, so a failure here returns ok:false and the
 * caller must leave receipt_archived_at null.
 */
export async function uploadAndVerify(
  accessToken: string, path: string, bytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let response: Response
  try {
    response = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': uploadArg(path),
        'Content-Type': 'application/octet-stream',
      },
      // Copied rather than passed directly: @types/node's Buffer merges into the
      // global Uint8Array type with a narrower ArrayBuffer parameter, so a plain
      // Uint8Array<ArrayBufferLike> does not satisfy fetch()'s BodyInit under
      // this project's lib config. Same issue, same fix, as dropboxContentHash.ts.
      body: new Uint8Array(bytes),
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Upload failed.' }
  }

  if (!response.ok) return { ok: false, error: `Dropbox rejected the upload (HTTP ${response.status}).` }

  const stored = await response.json() as { size?: number; content_hash?: string }
  if (stored.size !== bytes.length) {
    return { ok: false, error: `Dropbox stored ${stored.size} bytes, not ${bytes.length}.` }
  }
  const expected = await dropboxContentHash(bytes)
  if (stored.content_hash !== expected) {
    return { ok: false, error: 'Dropbox stored a file whose content hash does not match.' }
  }
  return { ok: true }
}
