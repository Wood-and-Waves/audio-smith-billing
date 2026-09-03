// Real bank OFX comes in two dialects: 1.x SGML (headers, unclosed leaf
// tags) and 2.x XML (closed tags). Both must parse to the same shape,
// because the import feature cannot care which decade Dan's bank lives in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOfx } from '../../lib/ofx.ts'

const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260810120000[-5:CDT]
<TRNAMT>-42.53
<FITID>2026081001
<NAME>TEST DINER
<MEMO>CARD 1234
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260812
<TRNAMT>600.00
<FITID>2026081202
<NAME>CLIENT PAYMENT
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1234.56<DTASOF>20260812</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`

test('parses 1.x SGML: dates, signed cents, fitid, name, memo, ledger balance', () => {
  const { transactions, ledgerBalanceCents } = parseOfx(SGML)
  assert.equal(transactions.length, 2)
  assert.deepEqual(transactions[0], {
    fitid: '2026081001', date: '2026-08-10', amountCents: -4253,
    name: 'TEST DINER', memo: 'CARD 1234',
  })
  assert.deepEqual(transactions[1], {
    fitid: '2026081202', date: '2026-08-12', amountCents: 60000,
    name: 'CLIENT PAYMENT', memo: null,
  })
  assert.equal(ledgerBalanceCents, 123456)
})

const XML = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="211"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260701</DTPOSTED>
<TRNAMT>-0.01</TRNAMT><FITID>x1</FITID><NAME>PENNY</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

test('parses 2.x XML with closing tags, one-cent amounts exact', () => {
  const { transactions } = parseOfx(XML)
  assert.deepEqual(transactions, [{
    fitid: 'x1', date: '2026-07-01', amountCents: -1, name: 'PENNY', memo: null,
  }])
})

test('a missing FITID becomes null, not an empty string', () => {
  const noId = SGML.replace('<FITID>2026081001\n', '')
  const { transactions } = parseOfx(noId)
  assert.equal(transactions[0].fitid, null)
})

test('floating-point amounts round to exact cents', () => {
  const { transactions } = parseOfx(SGML.replace('-42.53', '-42.535'))
  assert.equal(transactions[0].amountCents, -4254, 'half away from zero')
})

test('not an OFX file throws the friendly error', () => {
  // Fixture grown past the size floor on 2026-09-03. It used to be the
  // 21-byte 'Date,Payee,Amount\n...', which now reads as a failed download —
  // correctly, since nothing real is 21 bytes (Chase's actual CSV export is
  // ~3.6KB). The behaviour under test is unchanged: a file that ARRIVED and
  // is not OFX blames the format.
  const csv = 'Date,Payee,Amount,Balance\n'
    + '08/25/2026,STARBUCKS 8007827282,-25.00,1234.56\n'
    + '08/24/2026,WAL-MART #5023,-41.32,1259.56\n'
  assert.throws(() => parseOfx(csv), /Not an OFX file\./)
})

test('a missing DTPOSTED throws, naming the date', () => {
  const noDate = SGML.replace('<DTPOSTED>20260810120000[-5:CDT]\n', '')
  assert.throws(() => parseOfx(noDate), /malformed transaction.*date/i)
})

test('an unparsable TRNAMT throws, naming the amount', () => {
  const badAmount = SGML.replace('<TRNAMT>-42.53', '<TRNAMT>N/A')
  assert.throws(() => parseOfx(badAmount), /malformed transaction.*amount/i)
})

test('the ledger balance comes from LEDGERBAL, never AVAILBAL', () => {
  const both = SGML.replace(
    '<LEDGERBAL><BALAMT>1234.56<DTASOF>20260812</LEDGERBAL>',
    '<AVAILBAL><BALAMT>999.00<DTASOF>20260812</AVAILBAL>' +
    '<LEDGERBAL><BALAMT>1234.56<DTASOF>20260812</LEDGERBAL>')
  assert.equal(parseOfx(both).ledgerBalanceCents, 123456)
})

test('no LEDGERBAL block: the balance is null even when AVAILBAL exists', () => {
  const availOnly = SGML.replace(
    '<LEDGERBAL><BALAMT>1234.56<DTASOF>20260812</LEDGERBAL>',
    '<AVAILBAL><BALAMT>999.00<DTASOF>20260812</AVAILBAL>')
  assert.equal(parseOfx(availOnly).ledgerBalanceCents, null)
})

// A FAILED DOWNLOAD vs a WRONG FILE TYPE. Chase handed Dan a .qfx holding
// nine bytes — the literal text "undefined" — and the old message ("Not an
// OFX file.") sent him to check the format instead of re-downloading.

test('a download that returned the literal text "undefined" says so, and says how big it was', () => {
  assert.throws(
    () => parseOfx('undefined'),
    (err: Error) => {
      assert.match(err.message, /didn't download correctly/)
      assert.match(err.message, /9 bytes/, 'the size is what makes it obvious')
      assert.doesNotMatch(err.message, /Not an OFX file/, 'never blames the format')
      return true
    },
  )
})

test('an empty file reports zero bytes rather than a format problem', () => {
  assert.throws(() => parseOfx(''), /didn't download correctly \(0 bytes\)/)
})

test('a whitespace-only file is a failed download too', () => {
  assert.throws(() => parseOfx('   \r\n  \r\n'), /didn't download correctly/)
})

test('one byte is reported in the singular', () => {
  assert.throws(() => parseOfx('x'), /\(1 byte\)/)
})

test('a real file of the WRONG type still blames the format, not the download', () => {
  // A CSV export: big enough to have arrived intact, and genuinely not OFX.
  const csv = 'Details,Posting Date,Description,Amount,Type,Balance\n'
    + 'DEBIT,08/25/2026,STARBUCKS 8007827282,-25.00,DEBIT_CARD,1234.56\n'
    + 'DEBIT,08/24/2026,WAL-MART #5023,-41.32,DEBIT_CARD,1259.56\n'
  assert.ok(csv.length > 64, 'the fixture clears the size floor, so the format check is what fires')
  assert.throws(() => parseOfx(csv), /Not an OFX file/)
})

test('a real statement is untouched by the new guard', () => {
  const parsed = parseOfx(SGML)
  assert.ok(parsed.transactions.length > 0, 'still parses exactly as before')
})
