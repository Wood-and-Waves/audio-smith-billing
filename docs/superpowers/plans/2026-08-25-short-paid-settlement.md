# Short-Paid Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Dan settle an invoice from the invoice page by linking the deposit that actually paid it, even when the amount differs, with the shortfall (or overage) shown permanently on the invoice.

**Architecture:** A new pure lib derives how much was really paid from the deposit already linked to the invoice — nothing new is stored. The invoice page reads it and prints "Paid $590.00 · $10.00 short". A new client panel lets him pick an unlinked deposit and confirm the gap, calling the EXISTING `acceptIncomeMatch` server action, which already writes the link and marks the invoice paid on the deposit's own date.

**Tech Stack:** Next.js 16 (App Router, RSC), Supabase/Postgres, Tailwind, `node --test`.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-08-25-short-paid-settlement-design.md`. Dan's four decisions bind: entry point is the INVOICE page; any gap is shown plainly with ONE confirm (no thresholds); overpayment works the same way; the invoice is the ONLY place it appears (no report, no yearly total, no CPA-export line).
- **NO migration and NO new server action.** The shortfall is derived from `ledger_transaction_invoices`; `acceptIncomeMatch` (`app/money/actions.ts`) already does the write. If a task feels like it needs either, stop and escalate.
- Dan is on **cash basis** (his own confirmation, 2026-08-25): the money that never arrived was never income, so nothing here may touch reports, totals, or the ledger's own figures.
- Pure libs (`lib/*.ts`): relative `.ts` imports, no `@/`, no JSX, no clock reads.
- **Unknown must never resolve to a guess** (the invoice page's own doctrine, stated in its link-query comment): when the data needed to classify a settlement cannot be read, render NOTHING rather than a figure that might be wrong.
- Do not touch `MarkPaidButton`, `setInvoiceStatus`, `unlinkTransaction`, or the Matches queue. Unlinking already restores an invoice to `sent`; that is the way back out and needs no changes.
- The new reads rely on RLS for owner scoping, exactly as every other read on this page already does (the page holds no `user` object and adds no `getUser` call for them). The writes are `acceptIncomeMatch`'s, which already walks ownership itself.
- Gates before every commit: `npm test` (912 currently), cold tsc (`rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`), `npm run build`. Never `npm run dev` — the preview tool only.

## Model tiering
Task 1 cheap (complete code given) · Tasks 2–3 standard · final review top model.

---

### Task 1: `lib/invoicePayment.ts` — the settlement math (TDD)

**Files:**
- Create: `lib/invoicePayment.ts`
- Test: `scripts/test/invoicePayment.test.ts`

**Interfaces — Produces (later tasks import these exact names):**
- `type SettlementLink = { amountCents: number; invoiceCount: number }`
- `type Settlement = { paidCents: number; deltaCents: number; state: 'unpaid' | 'exact' | 'short' | 'over' }`
- `settlementFor(totalCents: number, link: SettlementLink | null): Settlement`

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/invoicePayment.test.ts`:

```ts
// Run: npm test -- scripts/test/invoicePayment.test.ts
//
// Dan's invoice #385 was paid $10 short because the client keyed the wrong
// amount. He is not chasing it. On cash basis the $10 was never income, so
// the BOOKS need no correction — what was missing was a way to record that
// the invoice is settled anyway, and why it does not tie out. These tests
// pin that arithmetic, including the one case that could invent money out
// of nothing: a single deposit covering several invoices.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settlementFor } from '../../lib/invoicePayment.ts'

test('no link at all reads as unpaid, with the whole total outstanding', () => {
  assert.deepEqual(settlementFor(60000, null), {
    paidCents: 0, deltaCents: -60000, state: 'unpaid',
  })
})

test('a deposit matching to the penny is exact', () => {
  assert.deepEqual(settlementFor(60000, { amountCents: 60000, invoiceCount: 1 }), {
    paidCents: 60000, deltaCents: 0, state: 'exact',
  })
})

test("Dan's own case: a $10 short check settles as short, and reports what actually arrived", () => {
  assert.deepEqual(settlementFor(60000, { amountCents: 59000, invoiceCount: 1 }), {
    paidCents: 59000, deltaCents: -1000, state: 'short',
  })
})

test('an overpayment is the same mechanism with the opposite sign', () => {
  assert.deepEqual(settlementFor(60000, { amountCents: 61000, invoiceCount: 1 }), {
    paidCents: 61000, deltaCents: 1000, state: 'over',
  })
})

test('a COMBO link reads exact — attributing the whole deposit would invent a phantom overpayment', () => {
  // The matcher only ever proposes a 2-or-3-invoice combo when the totals
  // sum to the deposit exactly, so this invoice's share is its own total.
  // Reading amountCents here would report a $1,200 overpayment on a $600
  // invoice that was in fact paid precisely.
  assert.deepEqual(settlementFor(60000, { amountCents: 180000, invoiceCount: 3 }), {
    paidCents: 60000, deltaCents: 0, state: 'exact',
  })
  assert.deepEqual(settlementFor(60000, { amountCents: 120000, invoiceCount: 2 }), {
    paidCents: 60000, deltaCents: 0, state: 'exact',
  })
})

test('the sign of deltaCents is the ONLY thing separating short from over', () => {
  const short = settlementFor(50000, { amountCents: 49999, invoiceCount: 1 })
  const over = settlementFor(50000, { amountCents: 50001, invoiceCount: 1 })
  assert.equal(short.state, 'short')
  assert.equal(over.state, 'over')
  assert.equal(short.deltaCents, -1)
  assert.equal(over.deltaCents, 1)
})

test('a zero total needs no special case and gets none', () => {
  assert.deepEqual(settlementFor(0, null), { paidCents: 0, deltaCents: 0, state: 'unpaid' })
  assert.deepEqual(settlementFor(0, { amountCents: 0, invoiceCount: 1 }), {
    paidCents: 0, deltaCents: 0, state: 'exact',
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- scripts/test/invoicePayment.test.ts`
Expected: FAIL — cannot find module `../../lib/invoicePayment.ts`.

- [ ] **Step 3: Implement `lib/invoicePayment.ts`**

```ts
// How much of an invoice was actually paid, and by how much the payment
// missed (design: docs/superpowers/specs/
// 2026-08-25-short-paid-settlement-design.md).
//
// Dan, 2026-08-25: a client keyed the wrong amount and the check arrived $10
// short on invoice #385. He is not chasing the $10. On CASH BASIS — his own
// confirmation — that $10 was never income, so nothing in the books needs
// correcting and nothing here may reach a report or a total. What was
// missing was a way to say "settled" when the deposit does not match to the
// penny, and a durable note of WHY it does not.
//
// Nothing here is stored. The figure is derived from the deposit actually
// linked to the invoice (ledger_transaction_invoices), so the link stays the
// single source of truth and no second copy can drift away from it.

/** One invoice's link, as little of it as the arithmetic needs. */
export type SettlementLink = {
  /** The linked deposit's own amount, positive cents. */
  amountCents: number
  /** How many invoices that one deposit covers (1..3). */
  invoiceCount: number
}

export type Settlement = {
  paidCents: number
  /** paid − total. Negative = short, positive = over, 0 = exact. */
  deltaCents: number
  state: 'unpaid' | 'exact' | 'short' | 'over'
}

export function settlementFor(
  totalCents: number,
  link: SettlementLink | null,
): Settlement {
  if (link === null) {
    return { paidCents: 0, deltaCents: -totalCents, state: 'unpaid' }
  }

  // A COMBO — one deposit covering several invoices — is only ever created
  // by the matcher, and it proposes one solely when the invoice totals sum
  // to the deposit EXACTLY. So this invoice's share is precisely its own
  // total. Reading the whole deposit here would report a huge phantom
  // overpayment on an invoice that was in fact paid to the penny.
  const paidCents = link.invoiceCount > 1 ? totalCents : link.amountCents
  const deltaCents = paidCents - totalCents

  return {
    paidCents,
    deltaCents,
    state: deltaCents === 0 ? 'exact' : deltaCents < 0 ? 'short' : 'over',
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npm test -- scripts/test/invoicePayment.test.ts` → all pass.
Then `npm test` (full suite, 912 + these), then cold tsc.

- [ ] **Step 5: Commit**

```bash
git add lib/invoicePayment.ts scripts/test/invoicePayment.test.ts
git commit -m "feat: derive an invoice's real settlement from its linked deposit"
```

---

### Task 2: The invoice page shows the shortfall

**Files:**
- Modify: `app/invoices/[id]/page.tsx`

**Interfaces — Consumes:** `settlementFor`, `type Settlement` from `lib/invoicePayment.ts` (Task 1).

- [ ] **Step 1: Widen the link query**

In the `Promise.all` at the top of the page, the `ledger_transaction_invoices` query currently selects `'ledger_transactions(date)'`. Keep its comment and its `.order('created_at', { ascending: true }).limit(1)` EXACTLY as they are (that determinism is deliberate — see the comment above it), and widen only the select:

```ts
      .select('transaction_id, ledger_transactions(id, date, amount_cents)')
```

- [ ] **Step 2: Read the link's invoice count, and compute the settlement**

Replace the existing `depositRow` / `deposit` extraction with this. The added query runs only when a link exists:

```ts
  // Extract the paying deposit from the first ledger transaction (or null).
  // The query itself already narrowed this to one deterministic row (oldest
  // link first) via .order + .limit(1) above.
  const depositRow = (depositTxns ?? [])[0] as unknown as
    | {
        transaction_id: string
        ledger_transactions: { id: string; date: string; amount_cents: number } | null
      }
    | undefined
  const deposit = depositRow?.ledger_transactions ?? null

  // How many invoices this ONE deposit covers. A combo (the matcher's two-
  // or three-invoice match) is exact by construction, and settlementFor
  // needs the count to tell a combo from a lone link. null means "could not
  // find out" — on this page an unknown must never resolve to a guess, so
  // the settlement line below simply does not render in that case rather
  // than risk printing a shortfall that isn't real.
  let linkInvoiceCount: number | null = null
  if (depositRow) {
    const { data: siblingLinks, error: siblingError } = await supabase
      .from('ledger_transaction_invoices')
      .select('invoice_id')
      .eq('transaction_id', depositRow.transaction_id)
    if (!siblingError) linkInvoiceCount = (siblingLinks ?? []).length
  }

  const settlement: Settlement | null =
    deposit && linkInvoiceCount !== null
      ? settlementFor(inv.total_cents, {
          amountCents: deposit.amount_cents,
          invoiceCount: linkInvoiceCount,
        })
      : null
```

Add the import beside the other lib imports at the top of the file:

```ts
import { settlementFor, type Settlement } from '@/lib/invoicePayment'
```

- [ ] **Step 3: Render it on the deposit line**

Replace the existing deposit block:

```tsx
          {deposit && (
            <p className="text-xs text-muted mt-1">
              Bank deposit · {formatDateShort(deposit.date)}
              {/* Only a real mismatch earns extra words. An exact settlement
                  reads exactly as it did before this feature, and 'unpaid'
                  renders nothing at all — it is reachable on an invoice
                  hand-marked paid that carries no link, where printing
                  "unpaid" beside a Paid badge would flatly contradict it. */}
              {settlement && (settlement.state === 'short' || settlement.state === 'over') && (
                <>
                  {' · '}Paid {formatUSD(settlement.paidCents)}
                  {' · '}{formatUSD(Math.abs(settlement.deltaCents))}{' '}
                  {settlement.state === 'short' ? 'short' : 'over'}
                </>
              )}
            </p>
          )}
```

- [ ] **Step 4: Gates**

`npm test`, cold tsc, `npm run build` — all clean. (No new tests here; the arithmetic is Task 1's and the rest is rendering.)

- [ ] **Step 5: Commit**

```bash
git add app/invoices/\[id\]/page.tsx
git commit -m "feat: show a short or over settlement on the invoice"
```

---

### Task 3: "Link a payment" on the invoice

**Files:**
- Create: `components/LinkPaymentPanel.tsx`
- Modify: `app/invoices/[id]/page.tsx`

**Interfaces — Consumes:** `settlementFor` from `lib/invoicePayment.ts`; `acceptIncomeMatch` from `@/app/money/actions` with signature `acceptIncomeMatch({ transactionId: string; invoiceIds: string[] }): Promise<{ error: string } | { ok: true }>`.
**Produces:** `type PaymentCandidate = { id: string; date: string; payee: string; amountCents: number }` exported from `components/LinkPaymentPanel.tsx`.

- [ ] **Step 1: Fetch the candidates on the page**

Add after the settlement computation from Task 2:

```ts
  // Candidates for "Link a payment": recent deposits not already spoken for.
  // PostgREST has no clean NOT IN subquery, so this reads the newest deposits
  // plus both link tables' transaction ids and filters in memory — the same
  // fetch-then-filter idiom the rest of /money uses. Fail CLOSED: if any of
  // the three reads errors, the taken-set would be incomplete and the panel
  // would offer a deposit that is already linked, so offer nothing instead.
  const canLinkPayment = !deposit && (inv.status === 'sent' || inv.status === 'paid')
  let paymentCandidates: PaymentCandidate[] = []
  if (canLinkPayment) {
    const [recentRes, invLinkRes, expLinkRes] = await Promise.all([
      supabase
        .from('ledger_transactions')
        .select('id, date, payee, amount_cents')
        .eq('kind', 'income')
        .gt('amount_cents', 0)
        .order('date', { ascending: false })
        .limit(40),
      supabase.from('ledger_transaction_invoices').select('transaction_id'),
      supabase.from('ledger_transaction_expenses').select('transaction_id'),
    ])
    if (!recentRes.error && !invLinkRes.error && !expLinkRes.error) {
      const taken = new Set<string>([
        ...((invLinkRes.data ?? []) as { transaction_id: string }[]).map((r) => r.transaction_id),
        ...((expLinkRes.data ?? []) as { transaction_id: string }[]).map((r) => r.transaction_id),
      ])
      paymentCandidates = ((recentRes.data ?? []) as {
        id: string; date: string; payee: string; amount_cents: number
      }[])
        .filter((t) => !taken.has(t.id))
        .map((t) => ({ id: t.id, date: t.date, payee: t.payee, amountCents: t.amount_cents }))
    }
  }
```

Add the imports:

```ts
import LinkPaymentPanel, { type PaymentCandidate } from '@/components/LinkPaymentPanel'
```

- [ ] **Step 2: Render the panel**

Immediately AFTER the action-bar `</div>` (the flex row holding `MarkPaidButton`, `SendReminderButton`, `DownloadInvoiceButton` and the Edit link) and BEFORE the `{inv.notes && inv.imported && …}` block:

```tsx
      {canLinkPayment && (
        <LinkPaymentPanel
          invoiceId={inv.id}
          invoiceNumber={inv.number}
          totalCents={inv.total_cents}
          candidates={paymentCandidates}
        />
      )}
```

- [ ] **Step 3: Write the component**

Create `components/LinkPaymentPanel.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'
import { acceptIncomeMatch } from '@/app/money/actions'
import { settlementFor } from '@/lib/invoicePayment'

export type PaymentCandidate = {
  id: string
  date: string
  payee: string
  amountCents: number
}

/**
 * Linking the deposit that actually paid this invoice — including when it
 * does not match to the penny (design: docs/superpowers/specs/
 * 2026-08-25-short-paid-settlement-design.md).
 *
 * Dan's #385 was paid $10 short because the client keyed the wrong amount.
 * The matcher only ever proposes an EXACT amount match, so that deposit
 * never surfaced in the Matches queue and the invoice sat unpaid forever.
 * This is the by-hand path: pick the deposit, see the gap stated plainly,
 * confirm once.
 *
 * It also appears on an invoice already marked paid that carries no link —
 * the ones hand-marked during the 2026-08-21 cleanup, whose `paid_at` is
 * the day of the cleanup rather than a real payment date. Attaching the
 * true deposit fixes the date and leaves an audit trail.
 *
 * The write is the EXISTING `acceptIncomeMatch`: it validates the row is a
 * real deposit, refuses a double link, requires the invoice be sent or
 * paid, and marks it paid on the DEPOSIT'S own date. It deliberately never
 * compared amounts, which is exactly what makes settling short possible.
 * Getting back out needs nothing new either — unlinking the transaction in
 * the register restores the invoice to sent.
 */
export default function LinkPaymentPanel({
  invoiceId, invoiceNumber, totalCents, candidates,
}: {
  invoiceId: string
  invoiceNumber: number
  totalCents: number
  candidates: PaymentCandidate[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<PaymentCandidate | null>(null)

  // invoiceCount is 1 by construction: this panel only ever links ONE
  // invoice, so a combo cannot arise from here.
  const settlement = picked
    ? settlementFor(totalCents, { amountCents: picked.amountCents, invoiceCount: 1 })
    : null

  function confirm() {
    if (!picked) return
    setError(null)
    start(async () => {
      const result = await acceptIncomeMatch({ transactionId: picked.id, invoiceIds: [invoiceId] })
      if ('error' in result) { setError(result.error); return }
      setPicked(null)
      router.refresh()
    })
  }

  return (
    <section className="mb-8 rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-3">Link a payment</h2>

      {candidates.length === 0 ? (
        <p className="text-sm text-muted">
          No unlinked deposits to choose from. Import or add the deposit on the ledger first.
        </p>
      ) : (
        <ul className="space-y-1">
          {candidates.map((c) => {
            const isPicked = picked?.id === c.id
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setPicked(isPicked ? null : c)}
                  disabled={pending}
                  className={`w-full flex items-baseline justify-between gap-3 rounded-field px-2 py-1.5
                              text-left text-sm transition-colors disabled:opacity-40
                              ${isPicked ? 'bg-accent-surface text-accent-ink' : 'hover:bg-surface-2'}`}
                >
                  <span className="truncate">
                    {formatDateShort(c.date)} · {c.payee}
                  </span>
                  <span className="tabular shrink-0">{formatUSD(c.amountCents)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {settlement && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-sm">
            {settlement.state === 'exact'
              ? `Settle #${invoiceNumber} — ${formatUSD(totalCents)}.`
              : `${formatUSD(Math.abs(settlement.deltaCents))} ${
                  settlement.state === 'short' ? 'short of' : 'over'
                } ${formatUSD(totalCents)}. Settle #${invoiceNumber} anyway?`}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={confirm}
              disabled={pending}
              className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                         border border-line text-muted hover:text-ink disabled:opacity-40"
            >
              {pending ? 'Settling…' : settlement.state === 'exact' ? 'Settle' : `Settle ${settlement.state}`}
            </button>
            <button
              type="button"
              onClick={() => setPicked(null)}
              disabled={pending}
              className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    </section>
  )
}
```

- [ ] **Step 4: Gates**

`npm test`, cold tsc, `npm run build` — all clean.

- [ ] **Step 5: Commit**

```bash
git add components/LinkPaymentPanel.tsx app/invoices/\[id\]/page.tsx
git commit -m "feat: link a payment to an invoice by hand, short or over"
```

---

### Task 4: Docs, review, walkthrough, ship

- [ ] **Docs:** in `docs/BACKLOG.md`, add a SHIPPED entry under the Money module's remaining phases recording this feature, Dan's four decisions, the cash-basis premise, and the residual that TRUE partial payments (more money still coming) remain deferred and deliberately distinct from "settled short"; in `CLAUDE.md`'s invoice/bridge paragraph add one line — an invoice's real settlement is DERIVED from its linked deposit via `lib/invoicePayment.ts`, never stored, and a combo link reads exact by construction.
- [ ] **Final review** (top model, whole branch, via `scripts/review-package <merge-base> HEAD`): lens = Global Constraints. Especially: no migration and no new server action; the combo case cannot report a phantom overpayment; the candidates read fails CLOSED so an already-linked deposit is never offered; `'unpaid'` renders nothing; nothing reaches reports, totals, or the CPA export; the panel never appears on a draft or void invoice; and that `acceptIncomeMatch`'s existing guards (deposit shape, double-link refusal, sent-or-paid requirement) are relied on rather than duplicated.
- [ ] **Walkthrough** (preview tool, dev sandbox): seed a sandbox invoice and a deposit $10 short of it; open the invoice → Link a payment lists the deposit → pick it → the panel reads "$10.00 short of $X. Settle #N anyway?" → confirm → the invoice reads Paid with the DEPOSIT'S date and the line shows "Paid $… · $10.00 short"; then unlink it in the register and confirm the invoice returns to Sent and the panel comes back. Repeat once with an overpayment. Screenshot both for Dan; remove the seeded rows afterward.
- [ ] **Ship (Dan's gate):** no migration, so merge → push → prod smoke (`/invoices` 307). Then tell Dan to settle the real #385.

## Verification

Task 4's walkthrough plus the gates at every commit: the new `invoicePayment` tests, full `npm test`, cold `npx tsc --noEmit`, `npm run build`.
