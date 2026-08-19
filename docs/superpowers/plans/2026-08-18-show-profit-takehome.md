# Per-Show Profit + Take-Home Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on every show page, what the show really earns Dan: revenue − every expense he paid = profit, then a configurable tax set-aside → estimated take-home.

**Architecture:** Migration 0026 (`settings.tax_setaside_bp integer not null default 0`) is ALREADY APPLIED to dev and committed. A pure `showProfit()` does the math (tested). Settings gains the rate (edited as a percent, stored as basis points). The show page joins the show's invoice, sums ALL expenses (billable ones net to zero against their reimbursement lines in revenue; my-cost ones don't — that asymmetry IS the feature), and renders a Profit section between Preview and Actions.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase. `npm test` (node --test; no typechecking — `npx tsc --noEmit` is the type gate; ALWAYS clear `tsconfig.tsbuildinfo` + `.next/cache/.tsbuildinfo` before gate runs).

## Global Constraints

- **Estimates, never tax advice.** The card's set-aside line is labeled an estimate; the rate is Dan's/his CPA's number. Rate 0 = unset → the card shows a muted nudge to Settings instead of inventing a number.
- **Profit subtracts ALL expenses Dan paid** (billable + my-cost). Billable ones appear in revenue too (reimbursement) so they net to zero; my-cost ones reduce profit. Pinned by test.
- **No set-aside on a loss or at rate 0** — `setasideCents = 0`, take-home = profit.
- Money: integer cents, `roundCents`, `formatUSD`. Rate: basis points (3000 = 30%), validated integer 0–10000.
- Pure module `lib/showProfit.ts`: no `@/`/JSX/server-only; relative imports; tested.
- The Profit section is Dan's view only — nothing here reaches any client-facing surface.
- Migration 0026 exists; do not write migrations.

---

### Task 1: `showProfit` (pure, tested) + the Settings rate field

**Files:**
- Create: `lib/showProfit.ts`; Test: `scripts/test/showProfit.test.ts`
- Modify: `app/settings/actions.ts`, `app/settings/page.tsx`, `components/SettingsEditor.tsx`

**Interfaces:**
- Produces: `showProfit({ revenueCents, expensesPaidCents, setasideBp }): { profitCents, setasideCents, takeHomeCents }`; `SettingsInput.tax_setaside_bp: number`; `EditorSettings.tax_setaside_bp: number`.

- [ ] **Step 1: Failing tests** — `scripts/test/showProfit.test.ts`:

```ts
// The take-home math is an ESTIMATE Dan parameterizes — the rate is his
// CPA's number, never the app's. Pure, so the asymmetry that makes it
// honest (reimbursed expenses net to zero, my-cost ones don't) is pinned
// here without a database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { showProfit } from '../../lib/showProfit.ts'

test('profit, set-aside and take-home for a plain show', () => {
  // $600 day, no expenses, 30%
  assert.deepEqual(
    showProfit({ revenueCents: 60000, expensesPaidCents: 0, setasideBp: 3000 }),
    { profitCents: 60000, setasideCents: 18000, takeHomeCents: 42000 },
  )
})

test('a reimbursed expense nets to zero: only labor is profit', () => {
  // $780 labor + $120 reimbursed baggage billed = $900 revenue; Dan paid the $120.
  const p = showProfit({ revenueCents: 90000, expensesPaidCents: 12000, setasideBp: 3000 })
  assert.equal(p.profitCents, 78000, 'profit is the labor, the reimbursement washed out')
})

test('a per-diem show: allowance in, my-cost meals out — the margin is the profit', () => {
  // $600 day + $65 per-diem line = $665 revenue; $41.20 of meals Dan paid, never billed.
  const p = showProfit({ revenueCents: 66500, expensesPaidCents: 4120, setasideBp: 0 })
  assert.equal(p.profitCents, 62380)
  assert.equal(p.setasideCents, 0, 'rate unset: no invented estimate')
  assert.equal(p.takeHomeCents, 62380)
})

test('set-aside rounds like money everywhere else (half away from zero)', () => {
  // 33.33% of $100.01 = 3333.3333 cents -> 3333
  assert.equal(
    showProfit({ revenueCents: 10001, expensesPaidCents: 0, setasideBp: 3333 }).setasideCents,
    3333,
  )
})

test('a loss sets nothing aside', () => {
  const p = showProfit({ revenueCents: 10000, expensesPaidCents: 15000, setasideBp: 3000 })
  assert.deepEqual(p, { profitCents: -5000, setasideCents: 0, takeHomeCents: -5000 })
})
```

- [ ] **Step 2: `npm test`** — new file fails, rest green.
- [ ] **Step 3: `lib/showProfit.ts`:**

```ts
// One show's money, from Dan's side of the table.
//
// revenue − every dollar Dan paid = profit. Billable expenses appear in BOTH
// numbers (billed to the client, paid by Dan) so a reimbursement-style show
// nets them to zero by construction; my-cost (per-diem) expenses appear only
// as cost, which is exactly why per-diem margins finally become visible.
//
// The set-aside is an ESTIMATE: profit × a rate Dan (or his CPA) configured.
// S-Corp tax is annual and entity-level, not per-show — this is a jar to
// fill, not a tax computation. Rate 0 means "unset": nothing is estimated.
//
// No '@/' imports and no JSX — exercised by node --test.

import { roundCents } from './money.ts'

export function showProfit(input: {
  revenueCents: number
  expensesPaidCents: number
  /** Basis points, 3000 = 30%. 0 = unset. */
  setasideBp: number
}): { profitCents: number; setasideCents: number; takeHomeCents: number } {
  const profitCents = input.revenueCents - input.expensesPaidCents
  // Never on a loss: there is nothing to set aside out of.
  const setasideCents = profitCents > 0 && input.setasideBp > 0
    ? roundCents((profitCents * input.setasideBp) / 10000)
    : 0
  return { profitCents, setasideCents, takeHomeCents: profitCents - setasideCents }
}
```

- [ ] **Step 4: `npm test`** — all green.
- [ ] **Step 5: Settings plumbing.**

`app/settings/actions.ts`: `SettingsInput` gains `tax_setaside_bp: number` (after `default_terms_days`, with a comment: basis points, 3000 = 30%, estimate-only). In `saveSettings`, after the `next_invoice_number` integer check, add:

```ts
  if (
    !Number.isInteger(input.tax_setaside_bp) ||
    input.tax_setaside_bp < 0 || input.tax_setaside_bp > 10000
  ) {
    return { error: 'Tax set-aside must be between 0% and 100%.' }
  }
```

and add `tax_setaside_bp: input.tax_setaside_bp,` to the `row`.

`app/settings/page.tsx`: add `tax_setaside_bp` to the select list.

`components/SettingsEditor.tsx`: `EditorSettings` gains `tax_setaside_bp: number`. State (percent string, near the other numerics): `const [taxSetasidePct, setTaxSetasidePct] = useState(initial.tax_setaside_bp === 0 ? '' : String(initial.tax_setaside_bp / 100))`. `submit()` passes `tax_setaside_bp: taxSetasidePct.trim() === '' ? 0 : Math.round(Number(taxSetasidePct) * 100)`. In the **Invoicing** grid add a third field:

```tsx
        <div>
          <label className="eyebrow block mb-2" htmlFor="tax-setaside">Tax set-aside (%)</label>
          <input id="tax-setaside" type="number" min={0} max={100} step="0.25"
                 className={FIELD_FULL} value={taxSetasidePct} placeholder="e.g. 30"
                 onChange={(e) => setTaxSetasidePct(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">
            Used only to estimate per-show take-home. Ask your CPA for the number;
            leave blank to skip the estimate.
          </p>
        </div>
```

- [ ] **Step 6: Gates** — clear TS caches, then `npx tsc --noEmit && npm run build && npm test` all clean/green.
- [ ] **Step 7: Commit** — `git add lib/showProfit.ts scripts/test/showProfit.test.ts app/settings/actions.ts app/settings/page.tsx components/SettingsEditor.tsx && git commit -m "showProfit math + tax set-aside rate in Settings"`

---

### Task 2: The Profit card on the show page

**Files:**
- Modify: `app/shows/[id]/page.tsx` (only file)

**Interfaces:** consumes `showProfit` (Task 1), the existing `previewTotal`/`lines`/`locked`, `formatUSD`.

- [ ] **Step 1: Join the invoice + load the rate.** `ShowRow` gains `invoices: { number: number; status: string; total_cents: number } | null` (the to-one embed through `invoice_id` — the same embed `unlinkShow` already uses). The query's select gains `invoices(number, status, total_cents)` after `clients(name),`. After `const s = data as unknown as ShowRow`, load the rate (RLS scopes it to the owner, like every read on this page):

```ts
  // The set-aside rate is Dan's own settings row — RLS scopes the read the
  // same way the shows query above is scoped.
  const { data: settingsRow } = await supabase
    .from('settings').select('tax_setaside_bp').maybeSingle()
  const setasideBp = settingsRow?.tax_setaside_bp ?? 0
```

- [ ] **Step 2: The math.** After `previewTotal`:

```ts
  // Dan's side of the show. Revenue is the real invoice once billed (the
  // frozen truth), the live preview before that. Costs are EVERY expense he
  // paid: billable ones sit in revenue too and net to zero — which is what
  // makes a reimbursement show read as pure labor — while my-cost (per-diem)
  // ones only subtract. This card is the whole reason my-cost exists.
  const expensesPaidCents = (s.expenses ?? []).reduce((t, e) => t + e.amount_cents, 0)
  const revenueCents = locked && s.invoices ? s.invoices.total_cents : previewTotal
  const profit = showProfit({ revenueCents, expensesPaidCents, setasideBp })
```

- [ ] **Step 3: The card.** Between the Preview `</section>` and the Actions section, rendered only when there is anything to say (`lines.length > 0 || expensesPaidCents > 0`):

```tsx
      {(lines.length > 0 || expensesPaidCents > 0) && (
        <section className="mb-10">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
            <h2 className="eyebrow">Profit</h2>
            <p className="text-xs text-muted">estimate — your money, never on the invoice</p>
          </div>
          <ul className="border-t border-line text-sm">
            <li className="flex items-baseline justify-between gap-x-4 border-b border-line py-2">
              <span>
                Revenue
                {locked && s.invoices && (
                  <span className="text-muted"> · invoice #{s.invoices.number} · {s.invoices.status}</span>
                )}
                {!locked && <span className="text-muted"> · preview</span>}
              </span>
              <span className="tabular font-semibold">{formatUSD(revenueCents)}</span>
            </li>
            {expensesPaidCents > 0 && (
              <li className="flex items-baseline justify-between gap-x-4 border-b border-line py-2">
                <span>Expenses you paid</span>
                <span className="tabular">−{formatUSD(expensesPaidCents)}</span>
              </li>
            )}
            <li className="flex items-baseline justify-between gap-x-4 border-b border-line py-2">
              <span className="font-semibold">Profit</span>
              <span className="tabular font-semibold">{formatUSD(profit.profitCents)}</span>
            </li>
            {setasideBp > 0 && profit.setasideCents > 0 && (
              <>
                <li className="flex items-baseline justify-between gap-x-4 border-b border-line py-2">
                  <span>Set aside for taxes ({setasideBp % 100 === 0 ? setasideBp / 100 : (setasideBp / 100).toFixed(2)}%)</span>
                  <span className="tabular">−{formatUSD(profit.setasideCents)}</span>
                </li>
                <li className="flex items-baseline justify-between gap-x-4 border-b border-line py-2">
                  <span className="font-semibold">Take-home</span>
                  <span className="tabular font-semibold text-good">{formatUSD(profit.takeHomeCents)}</span>
                </li>
              </>
            )}
          </ul>
          {setasideBp === 0 && (
            <p className="text-xs text-muted mt-2">
              Set a tax set-aside rate in <Link href="/settings" className="underline hover:text-ink">Settings</Link> to
              estimate take-home.
            </p>
          )}
        </section>
      )}
```

Add `showProfit` to the imports (`@/lib/showProfit`) and `Link` from `next/link` if the page doesn't already import it. If `text-good` is not an existing token in this app, use the app's existing positive/ink emphasis convention instead — check `globals.css`/usage first.

- [ ] **Step 4: Gates** — clear TS caches; `npx tsc --noEmit && npm run build && npm test` clean/green (337 + Task 1's new tests).
- [ ] **Step 5: Commit** — `git add "app/shows/[id]/page.tsx" && git commit -m "Show page: profit, tax set-aside and take-home card"`

---

## Verification

Gates as above; then the sandbox walkthrough (dev server on `billing-audiosmith-dev`): set 30% in Settings; open a seeded show → Profit card shows preview revenue − expenses → set-aside → take-home; a billed sandbox show shows invoice-based revenue; clear the rate → nudge appears.

## Blast radius

One additive settings column (dev-only until Wave 3). New UI section on the show page + one new Settings field. Nothing touches invoices, PDFs, or any client-facing surface.
