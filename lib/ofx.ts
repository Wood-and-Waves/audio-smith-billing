// OFX (Open Financial Exchange) bank-statement parser, text in, structs out.
//
// Banks still ship two decades of this format: 1.x SGML, where a leaf tag
// like <DTPOSTED>value has no closing tag and the transaction aggregate is
// the only reliable boundary, and 2.x XML, which closes everything. Writing
// a real SGML/XML parser is a project of its own for a format nobody's bank
// actually validates against a DTD — so instead we lean on the one thing
// both dialects agree on: a leaf value runs from '>' to the next '<' or end
// of line. That single pattern reads an unclosed SGML leaf and a closed XML
// leaf the same way, without caring which one it's looking at.
//
// No '@/' imports and no JSX — this parses a file the user picked in the
// browser, so it has to run there and under plain node --test alike.

import { roundCents } from './money.ts'

export type ParsedOfxTxn = {
  fitid: string | null
  date: string // YYYY-MM-DD from DTPOSTED's first 8 digits
  amountCents: number // TRNAMT x 100, rounded half away from zero
  name: string // NAME (or empty string)
  memo: string | null // MEMO when present
}

export type ParsedOfx = { transactions: ParsedOfxTxn[]; ledgerBalanceCents: number | null }

/**
 * The value of the first `<TAG>` in `text`, stopping at the next '<' or line
 * end — which is exactly where an XML closing tag or an SGML line break
 * falls. Trimmed; null when the tag is absent or its value is blank, so
 * "no FITID element" and "empty FITID" collapse to the same null a caller
 * can branch on.
 */
function tagValue(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}>([^<\r\n]*)`, 'i'))
  if (!match) return null
  const value = match[1].trim()
  return value === '' ? null : value
}

/** Dollars-as-text -> integer cents. Same half-away-from-zero rule as lib/money.ts. */
function toCents(raw: string | null): number {
  return roundCents(parseFloat(raw ?? '0') * 100)
}

/**
 * Below this, a file cannot be a bank statement — the OFX header block alone
 * is ~200 bytes before a single transaction. Set well under that so no real
 * statement can ever trip it; its job is to catch a download that returned
 * nothing, not to police small files.
 */
export const MIN_PLAUSIBLE_OFX_BYTES = 64

export function parseOfx(text: string): ParsedOfx {
  // A FAILED DOWNLOAD is not a wrong file type, and saying so saves Dan
  // looking in the wrong place. Chase handed him a .qfx containing nine bytes
  // — the literal text "undefined" — and "Not an OFX file." sent him to check
  // the format and the app rather than to re-download (2026-08-26).
  //
  // SIZE ALONE decides this, deliberately. An earlier version also treated
  // "contains no angle bracket" as a failed download, which is wrong: a CSV
  // arrives perfectly intact and contains none, and it deserves the format
  // error below, not a "re-download it". The test suite caught that.
  const trimmed = text.trim()
  if (trimmed.length < MIN_PLAUSIBLE_OFX_BYTES) {
    throw new Error(
      `That file is empty or didn't download correctly (${text.length} ` +
      `${text.length === 1 ? 'byte' : 'bytes'}). Try downloading it again.`,
    )
  }

  // A real statement has one of the two structural markers. A CSV or a
  // stray text file has neither, and that's a clearer error for Dan than
  // silently returning zero transactions. Reached only once the file is big
  // enough to be a real download, so this now means what it says: the file
  // arrived, and it is not OFX.
  if (!/<OFX[\s>]/i.test(text) && !/<STMTTRN[\s>]/i.test(text)) {
    throw new Error('Not an OFX file.')
  }

  const transactions: ParsedOfxTxn[] = []
  const stmttrnBlocks = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi
  let block: RegExpExecArray | null
  while ((block = stmttrnBlocks.exec(text))) {
    const body = block[1]

    const postedRaw = tagValue(body, 'DTPOSTED')
    const day = (postedRaw ?? '').slice(0, 8) // DTPOSTED may carry a time and TZ offset after the date
    // importOfx parses the whole file before writing a single row, so a
    // throw here is a clean Fail with no partial import — much better than
    // letting a missing/garbled DTPOSTED become the date "--" and either
    // crash on write or land silently wrong in the ledger.
    if (!/^\d{8}$/.test(day)) {
      throw new Error(`This OFX file has a malformed transaction (invalid date "${postedRaw ?? ''}").`)
    }

    const amountRaw = tagValue(body, 'TRNAMT')
    const amountCents = toCents(amountRaw)
    // toCents treats an ABSENT TRNAMT as a real $0.00 (tagValue -> null ->
    // parseFloat('0')), which is exactly right — some banks send $0 auth-hold
    // reversals with no amount tag at all, and ledgerImport already has a
    // dedicated skip path for that. A PRESENT but unparsable one (e.g. "N/A")
    // is a different problem — parseFloat silently reads that as NaN too — so
    // it's checked for finiteness explicitly rather than let fall through to
    // the same $0.
    if (!Number.isFinite(amountCents)) {
      throw new Error(`This OFX file has a malformed transaction (invalid amount "${amountRaw ?? ''}").`)
    }

    transactions.push({
      fitid: tagValue(body, 'FITID'),
      date: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`,
      amountCents,
      name: tagValue(body, 'NAME') ?? '',
      memo: tagValue(body, 'MEMO'),
    })
  }

  // BALAMT appears under both LEDGERBAL and AVAILBAL, and a statement can
  // carry both. Reading the first BALAMT in the whole document is a coin
  // flip on tag order; scope to the LEDGERBAL block specifically — that's
  // the balance the ledger reconciles against, not what's currently
  // available (which can be lower, e.g. with a pending hold).
  const ledgerbalBlock = text.match(/<LEDGERBAL>([\s\S]*?)<\/LEDGERBAL>/i)
  const balamt = ledgerbalBlock ? tagValue(ledgerbalBlock[1], 'BALAMT') : null
  const ledgerBalanceCents = balamt === null ? null : toCents(balamt)

  return { transactions, ledgerBalanceCents }
}
