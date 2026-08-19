'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD } from '@/lib/money'
import { importOfx } from '@/app/money/actions'

// Mirrors MAX_OFX_TEXT_LENGTH in app/money/actions.ts. A real statement is a
// few hundred KB; this is a fat-finger guard that rejects an oversized pick
// before the browser spends any time reading it into a string, not just
// after the server rejects the request it was mailed.
const MAX_OFX_TEXT_LENGTH = 2 * 1024 * 1024

type ImportSummary = {
  imported: number
  matched: number
  duplicates: number
  skipped: number
  statementBalanceCents: number | null
  autoCategorized: number
}

/** "Imported N", plus whichever other counts are nonzero — a clean re-import
 *  of the same file reads "Imported 0 · duplicates 42", not four zeros. */
function summaryLine(s: ImportSummary): string {
  const parts = [`Imported ${s.imported}`]
  if (s.matched > 0) parts.push(`matched ${s.matched}`)
  if (s.duplicates > 0) parts.push(`duplicates ${s.duplicates}`)
  if (s.skipped > 0) parts.push(`skipped ${s.skipped}`)
  if (s.autoCategorized > 0) parts.push(`${s.autoCategorized} auto-categorized`)
  return parts.join(' · ')
}

/**
 * The statement upload. Reads the picked file as text client-side — the
 * server action takes a string, not a File (Server Actions have no good way
 * to stream a File body, and lib/ofx's parser only ever wants text anyway) —
 * then hands it to importOfx. Styled after ExpenseLog's file-input row: the
 * same file: pseudo-element button, the same text-xs caption underneath.
 */
export default function LedgerImport({
  accountId, onReconcileNow,
}: {
  accountId: string
  /**
   * "Reconcile now" — set by the shared coordinator (components/
   * LedgerImportReconcile.tsx) so a statement's own ending balance can go
   * straight to LedgerReconcile instead of Dan retyping a number the file
   * already had. Optional: this component still works standalone (the
   * button just doesn't render) if a caller doesn't wire it up.
   */
  onReconcileNow?: (balanceCents: number) => void
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  function onPick(fileList: FileList | null) {
    const file = fileList?.[0]
    // Cleared immediately, not after the read finishes: re-picking the exact
    // same file (proving a second import is all duplicates) fires no change
    // event at all unless the input's own value was reset first.
    if (inputRef.current) inputRef.current.value = ''
    if (!file) return

    setError(null)
    setSummary(null)

    if (file.size > MAX_OFX_TEXT_LENGTH) {
      setError('That file is too large to import.')
      return
    }

    start(async () => {
      let text: string
      try {
        text = await file.text()
      } catch {
        setError('That file could not be read.')
        return
      }
      if (text.length > MAX_OFX_TEXT_LENGTH) {
        setError('That file is too large to import.')
        return
      }

      const result = await importOfx(accountId, text)
      if ('error' in result) { setError(result.error); return }
      setSummary(result)
      router.refresh()
    })
  }

  const statementBalanceCents = summary?.statementBalanceCents ?? null

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted">
        <input
          ref={inputRef}
          type="file"
          accept=".ofx,.qfx,application/x-ofx"
          disabled={pending}
          onChange={(e) => onPick(e.target.files)}
          className="text-xs text-muted file:mr-3 file:px-3 file:py-1.5 file:rounded-field
                     file:border file:border-line file:bg-transparent file:text-muted
                     file:text-xs file:font-semibold file:uppercase file:tracking-wider
                     disabled:opacity-40"
        />
        {pending ? ' Importing…' : ' Import statement'}
      </label>
      {summary && !error && (
        <>
          <p className="text-xs text-good">{summaryLine(summary)}</p>
          {/* A genuine const, not a re-read of summary.statementBalanceCents
              inline below — the same reason MoneyRegister's `account` gets
              its own const: narrowing a nullable property doesn't carry into
              the onClick closure the way narrowing a plain local does. */}
          {statementBalanceCents !== null && (
            <p className="text-xs text-muted flex flex-wrap items-center gap-x-2">
              Statement balance {formatUSD(statementBalanceCents)}
              {onReconcileNow && (
                <button
                  type="button"
                  onClick={() => onReconcileNow(statementBalanceCents)}
                  className="font-semibold text-accent hover:opacity-80"
                >
                  Reconcile now
                </button>
              )}
            </p>
          )}
        </>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  )
}
