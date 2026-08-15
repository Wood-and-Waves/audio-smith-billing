// Dropbox's content hash.
//
// Split the file into 4MB blocks, SHA-256 each, concatenate those digests, and
// SHA-256 the result. Dropbox returns this for every uploaded file, so
// computing it locally and comparing proves the bytes it stored are the bytes
// that were sent.
//
// This is what licenses deleting the only other copy. A size check alone would
// catch a truncated upload; this also catches a corrupted one.
//
// Uses Web Crypto rather than node:crypto so the same module works in the edge
// and node runtimes without a second implementation.

export const BLOCK_SIZE = 4 * 1024 * 1024

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('')

export async function dropboxContentHash(bytes: Uint8Array): Promise<string> {
  const digests: Uint8Array[] = []
  for (let at = 0; at < bytes.length; at += BLOCK_SIZE) {
    // Copied rather than a subarray view: @types/node's Buffer merges into the
    // global Uint8Array type with a narrower ArrayBuffer parameter, so a plain
    // Uint8Array's subarray() (typed ArrayBufferLike) does not satisfy
    // crypto.subtle.digest()'s BufferSource under this project's lib config.
    // The copy is not a behavior change — digest() reads every byte either way.
    const block = new Uint8Array(bytes.subarray(at, Math.min(at + BLOCK_SIZE, bytes.length)))
    digests.push(new Uint8Array(await crypto.subtle.digest('SHA-256', block)))
  }

  // An empty file has no blocks, so this hashes an empty buffer — which is what
  // Dropbox does, and is NOT the same as hashing one empty block.
  const joined = new Uint8Array(digests.reduce((n, d) => n + d.length, 0))
  let at = 0
  for (const digest of digests) {
    joined.set(digest, at)
    at += digest.length
  }

  return toHex(await crypto.subtle.digest('SHA-256', joined))
}
