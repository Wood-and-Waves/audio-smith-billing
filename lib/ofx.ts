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

export function parseOfx(text: string): ParsedOfx {
  // A real statement has one of the two structural markers. A CSV or a
  // stray text file has neither, and that's a clearer error for Dan than
  // silently returning zero transactions.
  if (!/<OFX[\s>]/i.test(text) && !/<STMTTRN[\s>]/i.test(text)) {
    throw new Error('Not an OFX file.')
  }

  const transactions: ParsedOfxTxn[] = []
  const stmttrnBlocks = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi
  let block: RegExpExecArray | null
  while ((block = stmttrnBlocks.exec(text))) {
    const body = block[1]
    const posted = tagValue(body, 'DTPOSTED') ?? ''
    const day = posted.slice(0, 8) // DTPOSTED may carry a time and TZ offset after the date
    transactions.push({
      fitid: tagValue(body, 'FITID'),
      date: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`,
      amountCents: toCents(tagValue(body, 'TRNAMT')),
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
