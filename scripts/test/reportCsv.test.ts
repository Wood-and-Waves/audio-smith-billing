// The transaction export, pinned. This file is opened on someone else's
// machine — Dan's accountant's — so its escaping and its formula guard are
// correctness, not polish.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transactionsCsv, csvFilename } from '../../lib/reportCsv.ts'
import type { ReportCategory } from '../../lib/ledgerReports.ts'
import type { ReportLine } from '../../lib/ledgerSplits.ts'

const CATS: ReportCategory[] = [
  { id: 'owner', name: 'Owner Investment, Pay, and Personal Expenses', grp: 'Owner Transactions', sort: 0, deductible: false },
  { id: 'temp', name: 'Temporary Transfer', grp: 'Owner Transactions', sort: 1, deductible: false },
  { id: 'meals', name: 'Meals and Entertainment', grp: 'Expenses', sort: 0, deductible: true },
]

const L = (over: Partial<ReportLine> = {}): ReportLine => ({
  date: '2026-05-01', amountCents: -1000, kind: 'expense',
  categoryId: 'meals', payee: 'Uber Eats', isSplitLeg: false, ...over,
})

const lines = (csv: string) => csv.replace(/^﻿/, '').trim().split('\n')

test('the header row names every column, in order', () => {
  assert.equal(lines(transactionsCsv([], CATS))[0], 'Date,Payee,Category,Group,Kind,Amount,Split')
})

test('an empty range produces a header and nothing else', () => {
  assert.equal(lines(transactionsCsv([], CATS)).length, 1)
})

test('a row carries its category name and group, and its amount in dollars', () => {
  assert.equal(lines(transactionsCsv([L()], CATS))[1],
    '2026-05-01,Uber Eats,Meals and Entertainment,Expenses,expense,-10.00,')
})

test('an uncategorized row says so rather than leaving a blank a reader must interpret', () => {
  assert.equal(lines(transactionsCsv([L({ categoryId: null })], CATS))[1],
    '2026-05-01,Uber Eats,(uncategorized),,expense,-10.00,')
})

// Dan's real March split. Two rows, same date and payee, each with its own
// category, and the amounts sum to the parent's 2,912.60.
test('a split becomes one row per leg, marked, and the amounts still sum', () => {
  const out = lines(transactionsCsv([
    L({ date: '2026-03-05', payee: 'Transfer to owner', categoryId: 'owner', amountCents: -251260, kind: 'owner_pay', isSplitLeg: true }),
    L({ date: '2026-03-05', payee: 'Transfer to owner', categoryId: 'temp', amountCents: -40000, kind: 'expense', isSplitLeg: true }),
  ], CATS))
  assert.equal(out[1], '2026-03-05,Transfer to owner,"Owner Investment, Pay, and Personal Expenses",Owner Transactions,owner_pay,-2512.60,split')
  assert.equal(out[2], '2026-03-05,Transfer to owner,Temporary Transfer,Owner Transactions,expense,-400.00,split')
})

// RFC 4180. Dan's payees come from bank exports and contain commas routinely.
test('a field with a comma is quoted', () => {
  assert.match(transactionsCsv([L({ payee: 'WAL-MART, NATIONAL CITY' })], CATS), /"WAL-MART, NATIONAL CITY"/)
})

test('a field with a double quote is quoted and its quotes doubled', () => {
  assert.match(transactionsCsv([L({ payee: 'THE "BEST" DINER' })], CATS), /"THE ""BEST"" DINER"/)
})

test('a field with a newline is quoted', () => {
  assert.match(transactionsCsv([L({ payee: 'LINE ONE\nLINE TWO' })], CATS), /"LINE ONE\nLINE TWO"/)
})

// Excel and Google Sheets EXECUTE a field starting =, +, - or @. Payees come
// from the bank, so they are untrusted text in a file opened elsewhere.
test('a field that a spreadsheet would execute is neutralised', () => {
  for (const bad of ['=SUM(A1:A9)', '+1+1', '-1+1', '@SUM(A1)']) {
    const row = lines(transactionsCsv([L({ payee: bad })], CATS))[1]
    assert.ok(row.includes(`'${bad}`), `expected an apostrophe prefix for ${bad}, got: ${row}`)
  }
})

// A negative amount must NOT be mistaken for a formula — it is the common case.
test('a negative amount is not treated as a formula', () => {
  assert.equal(lines(transactionsCsv([L({ amountCents: -1000 })], CATS))[1].endsWith(',-10.00,'), true)
})

test('the file opens with a UTF-8 BOM so Excel reads accented payees', () => {
  assert.equal(transactionsCsv([], CATS).charCodeAt(0), 0xfeff)
})

test('the filename names the range', () => {
  assert.equal(csvFilename('2026-07-01', '2026-09-30'),
    'smith-audio-transactions-2026-07-01-to-2026-09-30.csv')
})
