// Maps a frozen invoice backup_snapshot to the DocumentData.backup the PDF
// renderer consumes, with receipt PHOTOS and storage PATHS removed. This is the
// whole reason the public download can show the hours/expense itemisation
// without any access to private receipt storage: the snapshot text is safe to
// render; the images are simply never included.
//
// Pure and dependency-free (type-only import) so it is unit-tested without a DB
// or the PDF renderer. No '@/' imports and no server-only anything.

import type { DocumentData } from '../components/InvoiceDocument.tsx'

type RawExpense = {
  category: 'meals' | 'rides' | 'baggage' | 'other'
  where_spent: string
  amount_cents: number
  spent_on: string
  // receipt_path may be present on the stored snapshot; deliberately not copied.
}

export function publicBackup(snapshot: unknown): DocumentData['backup'] | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined
  const s = snapshot as {
    show_hours?: boolean
    shows?: NonNullable<DocumentData['backup']>['shows']
    total_net?: number; total_st?: number; total_ot?: number; total_dt?: number
    expenses?: RawExpense[]
  }
  return {
    show_hours: s.show_hours ?? false,
    shows: s.shows ?? [],
    total_net: s.total_net ?? 0,
    total_st: s.total_st ?? 0,
    total_ot: s.total_ot ?? 0,
    total_dt: s.total_dt ?? 0,
    expenses: (s.expenses ?? []).map((e) => ({
      category: e.category,
      where_spent: e.where_spent,
      amount_cents: e.amount_cents,
      spent_on: e.spent_on,
      receiptDataUri: null,
    })),
  }
}
