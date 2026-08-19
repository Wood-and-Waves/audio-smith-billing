'use client'

import { useState } from 'react'
import LedgerImport from '@/components/LedgerImport'
import LedgerReconcile from '@/components/LedgerReconcile'

/**
 * Only reason this exists: importOfx's return (statementBalanceCents) lives
 * in LedgerImport, and LedgerReconcile's prefill input is a sibling
 * component's prop, not its own state — "Reconcile now" needs to hand one
 * straight to the other. Lifted here, not persisted: a fresh page load
 * starts with no prefill, same as before this existed, and every click
 * creates a brand-new object literal (even a same-cents repeat click), which
 * is exactly what LedgerReconcile's effect needs to fire again.
 */
export default function LedgerImportReconcile({ accountId }: { accountId: string }) {
  const [prefill, setPrefill] = useState<{ balanceCents: number } | null>(null)

  return (
    <>
      <LedgerImport
        accountId={accountId}
        onReconcileNow={(balanceCents) => setPrefill({ balanceCents })}
      />
      <LedgerReconcile
        accountId={accountId}
        prefill={prefill}
        onPrefillUsed={() => setPrefill(null)}
      />
    </>
  )
}
