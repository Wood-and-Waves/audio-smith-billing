// The transaction export Dan hands his accountant.
//
// This file is opened on someone ELSE'S machine, which is why two of the
// functions below are about safety rather than formatting: RFC 4180 escaping,
// because his payees arrive from bank exports and contain commas routinely;
// and a formula guard, because Excel and Google Sheets execute a field that
// begins = + - or @, and a payee is untrusted text from an external system.
//
// One row per split leg, by Dan's decision (2026-09-09): the file exists so
// his accountant can check the categorization, and a single parent row would
// show one category for money that went two places. The amount column then
// sums to the real total and reconciles against the P&L.
//
// No '@/' imports and no JSX — exercised by node --test.

import { formatAmount } from './money.ts'
import type { ReportCategory } from './ledgerReports.ts'
import type { ReportLine } from './ledgerSplits.ts'

const HEADER = ['Date', 'Payee', 'Category', 'Group', 'Kind', 'Amount', 'Split']

/**
 * A spreadsheet executes a cell beginning = + - or @. Prefixing with an
 * apostrophe forces it to text; Excel and Sheets both strip the apostrophe on
 * display. Applied to TEXT fields only — an amount like -10.00 must stay a
 * number, and it is generated here rather than supplied by anyone.
 */
function neutralise(field: string): string {
  return /^[=+\-@]/.test(field) ? `'${field}` : field
}

/** RFC 4180: quote when the field contains a comma, a quote or a newline. */
function escape(field: string): string {
  return /[",\n\r]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field
}

const text = (field: string) => escape(neutralise(field))

export function transactionsCsv(lines: ReportLine[], categories: ReportCategory[]): string {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const rows = [HEADER.join(',')]
  for (const l of lines) {
    const category = l.categoryId === null ? null : byId.get(l.categoryId) ?? null
    rows.push([
      l.date,
      text(l.payee),
      text(category ? category.name : '(uncategorized)'),
      text(category ? category.grp : ''),
      l.kind,
      formatAmount(l.amountCents),
      l.isSplitLeg ? 'split' : '',
    ].join(','))
  }
  // The BOM is what makes Excel read this as UTF-8 rather than mangling an
  // accented payee.
  return `﻿${rows.join('\n')}\n`
}

export function csvFilename(from: string, to: string): string {
  return `smith-audio-transactions-${from}-to-${to}.csv`
}
