// A zip file, written by hand.
//
// Deliberately no dependency: this repo has nine, and a zip using the STORE
// method is about a hundred lines. STORE — no compression — is also the RIGHT
// method here, not merely the easy one. Every byte going in is a JPEG or a PDF,
// both already compressed, so deflate would burn CPU on a phone to save
// nothing.
//
// No zip64. A show's receipts will not approach 4GB, and the added complexity
// would be untested weight.
//
// Pure: bytes in, bytes out, no clock. Entry timestamps come from the expense's
// own spent_on date.

export type ZipEntry = {
  name: string
  bytes: Uint8Array
  /** Plain YYYY-MM-DD. Becomes the DOS timestamp in the archive. */
  date: string
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS date: year since 1980 in the top 7 bits, then month, then day. */
function dosDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return (Math.max(0, y - 1980) << 9) | (m << 5) | d
}

/** Midday, so a reader in any timezone still shows the right day. */
const DOS_TIME = (12 << 11) | (0 << 5) | 0

class Writer {
  /**
   * Readable, because the whole archive is now handed out as its pieces.
   * See buildZipParts.
   */
  readonly parts: Uint8Array[] = []
  length = 0

  bytes(b: Uint8Array) {
    this.parts.push(b)
    this.length += b.length
  }

  u16(v: number) {
    this.bytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]))
  }

  u32(v: number) {
    this.bytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]))
  }

}

/**
 * The archive as its pieces, in order, unconcatenated.
 *
 * This exists because concatenating is what the export could not afford. The
 * entry bytes are already in memory — 320MB for the 80 x 4MB show this spec
 * contemplates — and buildZip copied all of them into one buffer (1280MB peak),
 * after which the call site copied that buffer again with .slice() to satisfy a
 * TypeScript BodyInit constraint (1600MB), before Blob took its own copy. Three
 * full copies where none is needed: Blob accepts the parts directly and
 * concatenates internally, so the export hands it this array and keeps only the
 * bytes it already had.
 *
 * A twelve-receipt show survives either way. A tour does not.
 */
export function buildZipParts(entries: ZipEntry[]): Uint8Array[] {
  const encoder = new TextEncoder()
  const body = new Writer()
  const central = new Writer()

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.bytes)
    const size = entry.bytes.length
    const date = dosDate(entry.date)
    const offset = body.length

    // Local file header.
    body.u32(0x04034b50)
    body.u16(20)          // version needed: 2.0, which is what STORE requires
    body.u16(0x0800)      // bit 11: the name is UTF-8, so accents survive
    body.u16(0)           // method 0 = stored
    body.u16(DOS_TIME)
    body.u16(date)
    body.u32(crc)
    body.u32(size)        // compressed
    body.u32(size)        // uncompressed — equal, because nothing is compressed
    body.u16(name.length)
    body.u16(0)           // no extra field
    body.bytes(name)
    body.bytes(entry.bytes)

    // Central directory record for the same entry.
    central.u32(0x02014b50)
    // Version made by: low byte 20 (spec 2.0), high byte 3 (Unix host).
    //
    // Claiming host 0 (MS-DOS/FAT) here made Apple's unzip apply an extra
    // OEM-codepage conversion on top of the already-UTF-8 name, even with the
    // EFS bit set below — corrupting any accented byte and failing extraction
    // with "Illegal byte sequence". Claiming Unix skips that legacy path.
    central.u16(0x0314)
    central.u16(20)       // version needed
    central.u16(0x0800)
    central.u16(0)
    central.u16(DOS_TIME)
    central.u16(date)
    central.u32(crc)
    central.u32(size)
    central.u32(size)
    central.u16(name.length)
    central.u16(0)        // extra
    central.u16(0)        // comment
    central.u16(0)        // disk number
    central.u16(0)        // internal attributes
    // External attributes: with a Unix host declared above, unzip reads the
    // top 16 bits as st_mode. Leaving this at 0 extracted every entry with NO
    // permission bits at all — an unreadable file, caught by the round-trip
    // test as EACCES on the read-back. 0100644 is a regular file, rw-r--r--.
    central.u32(0o100644 << 16)
    central.u32(offset)   // where the local header sits
    central.bytes(name)
  }

  // End of central directory. Written on its own so the two writers above are
  // never materialised — their .length is all this record needs from them.
  const end = new Writer()
  end.u32(0x06054b50)
  end.u16(0)                      // this disk
  end.u16(0)                      // disk holding the central directory
  end.u16(entries.length)         // entries on this disk
  end.u16(entries.length)         // entries total
  end.u32(central.length)
  end.u32(body.length)            // where the central directory starts
  end.u16(0)                      // no comment

  return [...body.parts, ...central.parts, ...end.parts]
}

/**
 * The whole archive as one buffer.
 *
 * Kept, and unchanged in behaviour: the round-trip test through the system
 * `unzip` runs against this, and a caller that genuinely wants one buffer
 * should not have to assemble it. Anything holding a show's worth of photos
 * should be reaching for buildZipParts instead.
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const parts = buildZipParts(entries)
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
