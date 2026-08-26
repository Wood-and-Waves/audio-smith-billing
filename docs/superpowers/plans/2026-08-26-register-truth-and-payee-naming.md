# Register Truth + Payee Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the register honest — imported rows sit inline in the ledger and count in the budget immediately, marked unreviewed rather than falsely labelled "Pending" — and teach the app that Chase's `STARBUCKS 8007827282 800-782-728` is the `Starbucks` Dan already has 18 categorized rows for.

**Architecture:** The budget gate is two `continue` lines in one pure lib; deleting them changes every category-shaped consumer at once. The register drops its approval-keyed section, renders every row by date, and marks unreviewed ones bold plus a rail dot — which also removes the `opacity-70` that was trapping the category dropdown. Payee naming adds an alias table, a pure suggestion function, and a confirm-once control in the row's existing edit mode.

**Tech Stack:** Next.js 16 (App Router, RSC), Supabase/Postgres, Tailwind, `node --test`.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-08-25-register-truth-and-payee-naming-design.md`. Dan's five decisions bind: imported rows count in the budget immediately; payee naming SUGGESTS and he confirms once (never silent auto-merging); a renamed payee REPLACES Chase's text; NO chip — unreviewed is bold + a rail dot; "Pending" means UNCLEARED.
- **THE SHIP GATE IS A NUMBER.** After this wave `npm run parity` must show **all 25 categories still exact** and **Ready to Assign moving from $1.01 to −$146.84** (his 8 unreviewed rows = 6 uncategorized totalling −$147.85, plus 2 Temporary Transfer rows netting exactly $0.00). Anything else means something is wrong: STOP, do not ship, report.
- Migration ADDITIVE ONLY: `scripts/sql/migrations/0048_payee_aliases.sql`. **SHIP ORDER: prod migration FIRST, then merge.**
- Pure libs (`lib/*.ts`): relative `.ts` imports, no `@/`, no JSX, no clock reads.
- **`opacity` (or any other stacking-context creator — transform, filter, isolation) must NEVER be applied to a container that holds a popover.** That is the root cause of the dropdown bug and the reason the fade is being removed rather than re-tuned. Do not add a z-index to "fix" it; no z-index changes at all.
- `lib/budget.ts` arithmetic is untouchable.
- Owner-scoping: the alias table is RLS'd owner-scoped like every sibling; the rename action walks ownership rather than trusting a caller-supplied value.
- Gates before every commit: `npm test` (925 currently), cold tsc (`rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`), `npm run build`. Never `npm run dev` — the preview tool only.

## Model tiering
Tasks 1 and 3 standard · Tasks 2 and 4 standard (UI judgment) · final review top model.

---

### Task 1: Remove the budget gate

**Files:**
- Modify: `lib/ledgerSplits.ts`
- Modify: `app/money/actions.ts` (the reconcile refusal and its import)
- Modify: `app/money/page.tsx`, `app/money/forecast/page.tsx`, `app/money/reports/page.tsx`, `app/money/budget/data.ts` (drop the now-unused field)
- Modify: `scripts/parity/ynab-live.mjs`
- Test: `scripts/test/ledgerSplits.test.ts`

**Interfaces — Produces:** `TxnForExplode` and `ReportTxnForExplode` no longer carry `enteredAt`. `pendingBlocksReconcile` no longer exists.

- [ ] **Step 1: Invert the tests**

In `scripts/test/ledgerSplits.test.ts`: every test asserting a pending row yields nothing must now assert it yields its line like any other row. Find them by searching the file for `enteredAt: null`. Rewrite each so the expectation is the ordinary one, and change the test names to say so. Add this test, which is the one that pins the decision:

```ts
test('an unreviewed row now counts like any other — entered_at is a review marker, not an accounting gate', () => {
  // Dan, 2026-08-25: imported rows must hit the budget immediately. Before
  // this they yielded nothing, which is what kept a real $592 charge out of
  // his budget until he clicked Enter.
  const lines = explodeForCategories([
    { month: '2026-08', categoryId: 'cat-a', amountCents: -1788, legs: undefined },
    { month: '2026-08', categoryId: null, amountCents: -2263, legs: undefined },
  ])
  assert.deepEqual(lines, [
    { month: '2026-08', categoryId: 'cat-a', amountCents: -1788 },
    { month: '2026-08', categoryId: null, amountCents: -2263 },
  ])
})
```

Delete the whole `pendingBlocksReconcile` describe/test block (search the file for `pendingBlocksReconcile`) — the function is going away, so its tests go with it. Remove it from the file's import list.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- scripts/test/ledgerSplits.test.ts`
Expected: FAIL — the file still imports `pendingBlocksReconcile` from a module that still exports it, but the inverted expectations fail because the `continue` lines are still there.

- [ ] **Step 3: Remove the exclusion**

In `lib/ledgerSplits.ts`, in BOTH `explodeForCategories` and `explodeForReports`, delete this line (it appears once in each):

```ts
    if (txn.enteredAt === null) continue // pending: yields nothing, legs included
```

Remove `enteredAt: string | null` from both `TxnForExplode` and `ReportTxnForExplode`, and rewrite the doc comments above each function that describe the pending exclusion. The replacement comment, on `explodeForCategories`:

```ts
 * Every row yields its line. An UNREVIEWED row (entered_at null) is no
 * exception — Dan's 2026-08-25 decision: imported rows count in the budget
 * the moment they land, and entered_at means only "I have looked at this".
 * Wave C had this the other way round, which kept real spending out of his
 * budget until he clicked Enter.
```

Delete the `pendingBlocksReconcile` function and its doc comment entirely.

- [ ] **Step 4: Remove the reconcile refusal**

In `app/money/actions.ts`, delete `pendingBlocksReconcile` from the `@/lib/ledgerSplits` import, and delete this whole block (its comment included) — it starts at the comment beginning "Reconcile refuses while any pending row":

```ts
  const pendingAtOrBeforeStatement = rows.filter((r) => r.entered_at === null)
  if (pendingBlocksReconcile(pendingAtOrBeforeStatement, input.reconciledOn)) {
    const n = pendingAtOrBeforeStatement.length
    return {
      error: `${n} pending transaction${n === 1 ? '' : 's'} dated on or before the statement date ` +
        `${input.reconciledOn} — enter or reject ${n === 1 ? 'it' : 'them'} first, then reconcile.`,
    }
  }
```

Leave every other guard in that action exactly as it is.

- [ ] **Step 5: Drop the field at every call site**

Remove the `enteredAt: t.entered_at,` line from the explode inputs in `app/money/page.tsx`, `app/money/forecast/page.tsx`, `app/money/reports/page.tsx` and `app/money/budget/data.ts`. In `scripts/parity/ynab-live.mjs` remove `enteredAt: r.entered_at,` from the object it builds, drop `entered_at` from its `select`, and correct the comment there that explains the pending drop-out.

- [ ] **Step 6: Gates and commit**

`npm test` (green, with the inverted expectations), cold tsc, `npm run build`.

```bash
git add lib/ledgerSplits.ts app/money/actions.ts app/money/page.tsx app/money/forecast/page.tsx app/money/reports/page.tsx app/money/budget/data.ts scripts/parity/ynab-live.mjs scripts/test/ledgerSplits.test.ts
git commit -m "feat: imported rows count in the budget immediately"
```

---

### Task 2: The register stops lying

**Files:**
- Modify: `components/MoneyRegister.tsx`
- Modify: `app/money/page.tsx`

**Interfaces — Consumes:** nothing new. **Produces:** the `pendingRows` prop is gone from `MoneyRegister`.

- [ ] **Step 1: Merge the queue back into the register**

In `components/MoneyRegister.tsx`, REPLACE the `pendingRows` prop with `toReviewIds: string[]` (in the destructured parameter list and the props type). This matters: `transactions` is the DISPLAY-FILTERED set (`?filter=uncategorized` narrows it), so counting unreviewed rows from it would under-count and `Enter All` would silently reach fewer rows than it claims. `toReviewIds` is built server-side from the unfiltered set — the same reason Wave C's queue was its own unfiltered prop. Document that on the prop.

Then replace the partition:

```ts
  const pendingQueue = pendingRows
  const nonPending = transactions.filter((t) => t.entered_at !== null)
```

with the honest one — every row renders, and the two groups are now the BANK's axis:

```ts
  // Dan, 2026-08-25: "In YNAB 'pending' is a not cleared transaction." Wave
  // C hung this section on entered_at (has he reviewed it) and labelled it
  // with YNAB's word for `cleared` (has the BANK posted it), so every row in
  // it showed a PENDING chip AND a green cleared badge. Every row now
  // renders in date order whatever its entered_at; `Pending` below means
  // uncleared, which is what it meant before Wave C took the word.
  const toReviewCount = toReviewIds.length
```

Everywhere below that referenced `nonPending`, use `transactions` instead — the desktop table, `unclearedRows`, `clearedRows` and the phone `dateGroups` all derive from the full set now. Rename the phone group's `"Uncleared"` heading to `"Pending"`.

- [ ] **Step 2: Delete the section, add the review line**

Delete the entire `{pendingQueue.length > 0 && ( … )}` block (the one whose comment begins "Pending (Wave C Task 4) — pinned above EVERYTHING"), including its header, its `Enter All` button, its `pendingColumnHeader()` call and both row maps. Delete the now-unused `pendingColumnHeader` helper.

In its place, immediately above the register body, add:

```tsx
      {/* Dan's own words for the action ("Enter Now" / "Enter All") on a
          line that replaces Wave C's whole section. Counted over the FULL
          `transactions` set, never a filtered view — a display filter must
          never shrink what Enter All reaches. */}
      {toReviewCount > 0 && (
        <div className="mb-3 flex items-center justify-between">
          <p className="eyebrow">
            {toReviewCount} to review
          </p>
          <button
            type="button"
            onClick={enterAll}
            disabled={pending}
            className="text-xs font-semibold text-accent hover:opacity-80 disabled:opacity-40"
          >
            Enter All
          </button>
        </div>
      )}
```

`enterAll` currently reads `pendingRows.map((t) => t.id)`. Change that one line to:

```ts
    const ids = toReviewIds
```

- [ ] **Step 2b: Uncleared rows group under "Pending" on desktop too**

The desktop table currently renders `nonPending` in one flat list. Render `unclearedRows` first under a `Pending` sub-header, then the rest, so the word means the same thing in both layouts:

```tsx
            {unclearedRows.length > 0 && (
              <>
                <p className="eyebrow mt-3 mb-1">Pending ({unclearedRows.length})</p>
                {unclearedRows.map(renderDesktopRow)}
              </>
            )}
            {clearedRows.map(renderDesktopRow)}
```

- [ ] **Step 3: Replace the fade and the chip with bold + a rail dot**

In `renderDesktopRow`, the row wrapper currently ends its className with:

```
          } ${isPending ? 'opacity-70' : ''}`
```

Replace that with `` } ${isPending ? 'font-semibold' : ''}` `` — bold, not faded. **This is the dropdown fix**: `opacity` below 1 creates a CSS stacking context, which both faded the open category menu and trapped it beneath the sticky header despite its higher z-index. Never put opacity (or transform/filter/isolation) on a row that contains a popover.

Do the same in `renderPhoneRow` — its wrapper carries the identical `${isPending ? 'opacity-70' : ''}`.

Delete the `PENDING` chip block in `renderDesktopRow` (the `{isPending && ( … Pending … )}` span beside the payee) and the matching one in `renderPhoneRow`.

Add the rail dot. `renderDesktopRow`'s first grid cell is `<ReceiptControl row={t} … />`; wrap it so the dot sits beside it:

```tsx
        <span className="relative flex items-center justify-center">
          <ReceiptControl row={t} pending={pending} onView={openReceipt} onAttach={openAttach} />
          {/* Unreviewed marker (Dan's decision: no chip). Paired with the
              bold row above; both clear the moment he enters the row. */}
          {isPending && (
            <span
              aria-hidden
              className="absolute -left-1 h-1.5 w-1.5 rounded-full bg-accent"
            />
          )}
        </span>
```

Screen readers get the state from text, not the dot, so add to the payee cell, right after the payee span:

```tsx
          {isPending && <span className="sr-only"> (to review)</span>}
```

- [ ] **Step 4: The page stops splitting the rows**

In `app/money/page.tsx`, replace the `pendingRows` computation and prop with the id list, built from the UNFILTERED `sorted` set (`transactions` on the next line is built from `filtered`, which a display filter narrows — that is exactly what this must not inherit):

```ts
  // Unreviewed ids from the UNFILTERED set: the review count and Enter All
  // must never shrink because a display filter is on.
  const toReviewIds: string[] = sorted.filter((t) => t.entered_at === null).map((t) => t.id)
```

and pass `toReviewIds={toReviewIds}`. Note `transactions` already includes unreviewed rows (it is `filtered.map(toRow)` with no entered_at filter), so nothing else needs to change for them to render inline. The empty-state render near the top of the file passes `transactions={[]} pendingRows={[]}` — change that second one to `toReviewIds={[]}`. In the same file remove the matcher's pending filter:

```ts
  const matchRows: BankRow[] = allTxns.filter((t) => t.entered_at !== null).map((t) => ({
```

becomes

```ts
  // No pending filter (2026-08-25): an unreviewed deposit is ordinary money
  // now and can legitimately be the one that paid an invoice.
  const matchRows: BankRow[] = allTxns.map((t) => ({
```

Whatever `transactions` prop the register already receives must now include the unreviewed rows — verify it does; if the page was excluding them from that list, stop and report, because that is a data change this plan did not anticipate.

- [ ] **Step 5: Gates and commit**

`npm test`, cold tsc, `npm run build`.

```bash
git add components/MoneyRegister.tsx app/money/page.tsx
git commit -m "feat: cleared rows sit in the ledger; Pending means uncleared again"
```

---

### Task 3: The payee suggestion, and the alias table

**Files:**
- Create: `lib/payeeName.ts`
- Create: `scripts/sql/migrations/0048_payee_aliases.sql`
- Test: `scripts/test/payeeName.test.ts`

**Interfaces — Produces:** `suggestDisplayName(raw: string, knownPayees: string[]): string`

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/payeeName.test.ts`:

```ts
// Run: npm test -- scripts/test/payeeName.test.ts
//
// Dan has 18 rows categorized under `Starbucks`; Chase sends
// `STARBUCKS 8007827282 800-782-728`. Payee memory keys on the exact string,
// so it never matched and every import arrived uncategorized. This is the
// suggestion he confirms once per merchant.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestDisplayName } from '../../lib/payeeName.ts'

const KNOWN = ['Starbucks', 'Walmart', 'Uber', 'Uber Eats', 'Hyatt Regency Greenwich', 'Amazon']

test("his own real case: Chase's Starbucks string suggests the Starbucks he already uses", () => {
  assert.equal(suggestDisplayName('STARBUCKS 8007827282 800-782-728', KNOWN), 'Starbucks')
})

test('punctuation in the bank string does not defeat the match', () => {
  // He has `Walmart`; Chase sends `WAL-MART #5023 NATIONAL CITY CA`.
  assert.equal(suggestDisplayName('WAL-MART #5023 NATIONAL CITY CA', KNOWN), 'Walmart')
})

test('the LONGEST known payee wins, so Uber Eats never collapses into Uber', () => {
  assert.equal(suggestDisplayName('UBER EATS SAN FRANCISCO CA', KNOWN), 'Uber Eats')
  assert.equal(suggestDisplayName('UBER TRIP HELP.UBER.COM CA', KNOWN), 'Uber')
})

test('a merchant he has never seen falls back to a cleaned version of the raw string', () => {
  // Not "Grand Hyatt San Diego F San Dieg" — the trailing location noise and
  // the truncated tail go, and it is title-cased.
  assert.equal(suggestDisplayName('GRAND HYATT SAN DIEGO F SAN DIEG', []), 'Grand Hyatt')
  assert.equal(suggestDisplayName('TST*CRACK TACO - SEAPOR San Dieg', []), 'Crack Taco')
})

test('a different Hyatt does NOT get merged into his Greenwich one', () => {
  // The guard against silent wrong merges — his own example. "Hyatt Regency
  // Greenwich" is not a substring of the San Diego string, so no match.
  assert.equal(suggestDisplayName('GRAND HYATT SAN DIEGO F SAN DIEG', KNOWN), 'Grand Hyatt')
})

test('a suggestion can be imperfect, and that is the design — it costs one correction', () => {
  // His real string is `UBER *BUSINESS EATS SAN FRANCISC`, which contains
  // "uber" but not "ubereats", so it suggests `Uber`. He corrects it once and
  // the alias — keyed on the exact raw string — never asks again. Pinned so
  // nobody later "fixes" this into fuzzy matching that would merge his
  // Hyatt Regency into a Grand Hyatt.
  assert.equal(suggestDisplayName('UBER *BUSINESS EATS SAN FRANCISC', KNOWN), 'Uber')
})

test('an already-clean payee suggests itself unchanged', () => {
  assert.equal(suggestDisplayName('Starbucks', KNOWN), 'Starbucks')
})

test('never returns empty, whatever the input', () => {
  assert.notEqual(suggestDisplayName('', KNOWN), '')
  assert.notEqual(suggestDisplayName('   ', KNOWN), '')
  assert.notEqual(suggestDisplayName('#### 1234 5678', []), '')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- scripts/test/payeeName.test.ts`
Expected: FAIL — cannot find module `../../lib/payeeName.ts`.

- [ ] **Step 3: Implement `lib/payeeName.ts`**

```ts
// Turning a bank descriptor into the name Dan actually uses.
//
// He has 18 rows categorized under `Starbucks`; Chase sends
// `STARBUCKS 8007827282 800-782-728`. lib/payeeMemory.ts keys on the exact
// payee string, so it never matched and every import landed uncategorized.
//
// This only ever SUGGESTS (his decision, 2026-08-25): nothing is merged
// without him confirming, because a plausible-looking auto-merge would
// eventually fold his `Hyatt Regency Greenwich` into a Grand Hyatt in San
// Diego. A wrong suggestion costs one correction and is never repeated,
// because the alias it writes is keyed on the exact raw string.
//
// Pure — no I/O, no clock, relative imports only.

/** Letters and digits only, lowercased — so `WAL-MART` and `Walmart` meet. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Noise that trails a merchant name in a card descriptor. */
const NOISE = new Set([
  'llc', 'inc', 'co', 'com', 'corp', 'ltd',
  // US state codes — a descriptor almost always ends in one.
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
  'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
  'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
  'va','wa','wv','wi','wy',
])

function isNoiseWord(w: string): boolean {
  const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (bare === '') return true
  if (/\d/.test(bare)) return true          // store numbers, phone numbers
  return NOISE.has(bare)
}

function titleCase(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
}

/**
 * Clean a raw descriptor into something readable: drop a leading processor
 * prefix (`TST*`), keep words until the first noise word, title-case them,
 * and cap at TWO words so a long location tail cannot ride along.
 */
function cleanRaw(raw: string): string {
  const stripped = raw.replace(/^[A-Z]{2,4}\*/i, '').replace(/\*/g, ' ')
  const words = stripped.split(/\s+/).filter((w) => w !== '')
  const kept: string[] = []
  for (const w of words) {
    if (isNoiseWord(w)) break
    kept.push(titleCase(w.replace(/[^A-Za-z0-9&'-]/g, '')))
    // TWO words, not three: 'GRAND HYATT SAN DIEGO F SAN DIEG' has no noise
    // word to stop at, and three would keep the stray 'San'.
    if (kept.length === 2) break
  }
  const out = kept.join(' ').trim()
  return out === '' ? raw.trim() : out
}

/**
 * The name to suggest for `raw`.
 *
 * A known payee wins whenever its squashed form appears inside the squashed
 * raw string — that is what makes his existing `Starbucks` (and its 18
 * categorized rows) start paying off. The LONGEST such match wins, so
 * `Uber Eats` is never collapsed into `Uber`. With no match it falls back to
 * a cleaned form of the raw string; the result is never empty.
 */
export function suggestDisplayName(raw: string, knownPayees: string[]): string {
  const hay = squash(raw)
  let best = ''
  if (hay !== '') {
    for (const known of knownPayees) {
      const needle = squash(known)
      if (needle === '' || !hay.includes(needle)) continue
      if (needle.length > squash(best).length) best = known
    }
  }
  if (best !== '') return best
  const cleaned = cleanRaw(raw)
  return cleaned.trim() === '' ? 'Unknown payee' : cleaned
}
```

- [ ] **Step 4: Run to verify green**

Run: `npm test -- scripts/test/payeeName.test.ts` → all pass. Then `npm test` (full suite) and cold tsc.

If `'TST*CRACK TACO - SEAPOR San Dieg'` does not land on `'Crack Taco'`, fix `cleanRaw` until it does rather than weakening the test — that string is real, from his own statement.

- [ ] **Step 5: Write migration 0048**

Create `scripts/sql/migrations/0048_payee_aliases.sql`:

```sql
-- 0048 — payee aliases: Chase's descriptor -> the name Dan uses
--
-- He has 18 rows categorized under `Starbucks`. Chase sends
-- `STARBUCKS 8007827282 800-782-728`. lib/payeeMemory.ts keys on the exact
-- payee string, so his memory never matched an import and every statement
-- arrived uncategorized. This table is what closes that gap: one confirmed
-- alias per merchant, applied at import BEFORE the memory lookup, so the
-- category memory he has been building for months finally fires.
--
-- raw_payee is stored ALREADY NORMALIZED (lib/payeeMemory.ts's
-- normalizePayee: trimmed, whitespace-collapsed, lowercased) so a lookup can
-- never miss on spacing or case. ADDITIVE ONLY, per the 0020 rule.

create table ledger_payee_aliases (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  raw_payee    text not null check (length(btrim(raw_payee)) > 0),
  display_name text not null check (length(btrim(display_name)) > 0),
  created_at   timestamptz not null default now(),

  constraint ledger_payee_aliases_uniq unique (owner_id, raw_payee)
);

comment on table ledger_payee_aliases is
  'One confirmed rename per bank descriptor. raw_payee is normalized on the '
  'way in (normalizePayee) so lookups cannot miss on case or spacing; '
  'display_name is what Dan typed. Applied by the OFX importer to NEW rows '
  'before payee memory runs, so an aliased payee inherits the category his '
  'existing rows already teach.';

create index ledger_payee_aliases_owner_idx on ledger_payee_aliases (owner_id);

alter table ledger_payee_aliases enable row level security;
create policy ledger_payee_aliases_owner_all on public.ledger_payee_aliases
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.ledger_payee_aliases from anon;
grant select, insert, update, delete on public.ledger_payee_aliases to authenticated;
grant all on public.ledger_payee_aliases to service_role;
```

Run `npm run db:migrate` (DEV only — **never `--prod`**, the controller ships that at the gate). Verify with a `db:sql` information_schema check that the table and its unique constraint exist; delete the check file.

- [ ] **Step 6: Commit**

```bash
git add lib/payeeName.ts scripts/test/payeeName.test.ts scripts/sql/migrations/0048_payee_aliases.sql
git commit -m "feat: payee-name suggestion and the alias table"
```

---

### Task 4: Aliases on import, and confirm-once in the edit row

**Files:**
- Modify: `app/money/actions.ts` (apply aliases in the importer; new `setPayeeAlias` action)
- Modify: `app/money/page.tsx` (pass known payees and existing aliases)
- Modify: `components/MoneyRegister.tsx` (the suggestion chip and the remember checkbox)

**Interfaces — Consumes:** `suggestDisplayName(raw, knownPayees)` from `lib/payeeName.ts`; `normalizePayee` from `lib/payeeMemory.ts`.

- [ ] **Step 1: Apply aliases during import**

In `app/money/actions.ts`'s importer, the insert currently derives the category like this:

```ts
    const categoryId = remembered.get(memoryKey(ins.kind, ins.row.name)) ?? null
```

Before the insert loop, read the owner's aliases once:

```ts
  // Aliases first, memory second — the ORDER is the point. Renaming
  // `STARBUCKS 8007827282 800-782-728` to `Starbucks` before the memory
  // lookup is what lets his 18 existing categorized Starbucks rows teach
  // this row its category. The other order would rename a row that had
  // already failed to match.
  const { data: aliasRows, error: aliasError } = await supabase
    .from('ledger_payee_aliases').select('raw_payee, display_name').eq('owner_id', user.id)
  if (aliasError) return { error: aliasError.message }
  const aliases = new Map<string, string>(
    (aliasRows ?? []).map((a) => [a.raw_payee as string, a.display_name as string]),
  )
```

Then, for each inserted row, resolve the payee before both the memory lookup and the insert:

```ts
    const payee = aliases.get(normalizePayee(ins.row.name)) ?? ins.row.name
    const categoryId = remembered.get(memoryKey(ins.kind, payee)) ?? null
```

and use `payee` for the row's `payee` column instead of `ins.row.name`. Import `normalizePayee` alongside the existing `memoryKey` import.

- [ ] **Step 2: The `setPayeeAlias` action**

Add to `app/money/actions.ts`:

```ts
/**
 * Remember that a bank descriptor means this name, and apply it backwards.
 *
 * Dan confirms a suggestion once per merchant (his decision, 2026-08-25 — no
 * silent auto-merging). Writing the alias also renames every existing row
 * carrying that exact raw payee, so one confirmation cleans up the rows
 * already imported as well as every future one. `raw` is normalized on the
 * way in so a lookup can never miss on case or spacing.
 *
 * Upsert, not insert: confirming a different name for the same descriptor
 * later must correct the alias rather than fail on the unique constraint.
 */
export async function setPayeeAlias(
  rawPayee: string,
  displayName: string,
): Promise<Fail | { ok: true; renamed: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const raw = normalizePayee(rawPayee)
  const name = displayName.trim()
  if (raw === '') return { error: 'That payee is empty.' }
  if (name === '') return { error: 'Give the payee a name.' }

  const { error: upsertError } = await supabase
    .from('ledger_payee_aliases')
    .upsert(
      { owner_id: user.id, raw_payee: raw, display_name: name },
      { onConflict: 'owner_id,raw_payee' },
    )
  if (upsertError) return { error: upsertError.message }

  // Rename what is already in the books. Owner-scoped explicitly, not just
  // by RLS, because this is a bulk write keyed on a caller-supplied string.
  const { data: renamedRows, error: renameError } = await supabase
    .from('ledger_transactions')
    .update({ payee: name })
    .eq('owner_id', user.id)
    .eq('payee', rawPayee)
    .select('id')
  if (renameError) return { error: renameError.message }

  revalidatePath('/money')
  return { ok: true, renamed: (renamedRows ?? []).length }
}
```

- [ ] **Step 3: Feed the register what it needs**

In `app/money/page.tsx`, alongside the existing fetches, read the owner's aliases and build the known-payee list from rows that already carry a category (the same rows payee memory learns from):

```ts
  // The suggestion's raw material: payees he already uses, and the aliases he
  // has already confirmed. Both are small — a few hundred rows at most — and
  // the register needs them to decide whether to offer a rename at all.
  const { data: aliasRows } = await supabase
    .from('ledger_payee_aliases').select('raw_payee')
  const aliasedRaw: string[] = ((aliasRows ?? []) as { raw_payee: string }[]).map((a) => a.raw_payee)
  const knownPayees: string[] = [...new Set(
    allTxns.filter((t) => t.category_id !== null && t.payee.trim() !== '').map((t) => t.payee),
  )]
```

Pass both to `<MoneyRegister … knownPayees={knownPayees} aliasedRawPayees={aliasedRaw} />`.

- [ ] **Step 4: The confirm-once control**

In `components/MoneyRegister.tsx`, add the two props (`knownPayees: string[]`, `aliasedRawPayees: string[]`) to the signature and props type, import `suggestDisplayName` from `@/lib/payeeName`, `normalizePayee` from `@/lib/payeeMemory`, and `setPayeeAlias` from `@/app/money/actions`. Add state beside the other edit state:

```ts
  const [rememberPayee, setRememberPayee] = useState(true)
```

Reset it in `startEdit` (`setRememberPayee(true)`) so every edit starts with remembering on, which is the default Dan chose.

In `renderEditRow`, compute the offer:

```ts
    // Offer a rename only when this payee has never been confirmed and the
    // suggestion actually differs from what is there — no chip on a row he
    // has already named, and none that suggests what it already says.
    const rawNormalized = normalizePayee(t.payee)
    const alreadyAliased = aliasedRawPayees.includes(rawNormalized)
    const suggestion = alreadyAliased ? null : suggestDisplayName(t.payee, knownPayees)
    const offerRename = suggestion !== null && suggestion !== t.payee && suggestion !== editPayee
```

Render the chip immediately after the Payee input in BOTH the desktop and phone copies of the edit row:

```tsx
        {offerRename && (
          <button
            type="button"
            onClick={() => setEditPayee(suggestion)}
            className="text-[11px] font-semibold text-accent hover:opacity-80 truncate"
          >
            Use &ldquo;{suggestion}&rdquo;
          </button>
        )}
```

And the checkbox in the edit row's second line, beside the Show select:

```tsx
        {editPayee !== t.payee && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={rememberPayee}
              onChange={(e) => setRememberPayee(e.target.checked)}
              disabled={pending}
            />
            Remember this name for future imports
          </label>
        )}
```

- [ ] **Step 5: Write the alias on save**

`saveEdit` currently calls `updateLedgerTransaction` and, on success, closes the row. Extend that success branch — the alias is written only when the payee actually changed and the box is ticked:

```ts
      if ('error' in result) { setError(result.error); return }
      // The rename he confirmed, remembered for next month's import. Failing
      // here must not read as "the edit failed" — the row itself already
      // saved — so it surfaces as a note, not an error.
      if (rememberPayee && input.payee !== row.payee) {
        const aliased = await setPayeeAlias(row.payee, input.payee)
        if ('error' in aliased) {
          setError(`Saved — but the name wasn't remembered: ${aliased.error}`)
        }
      }
      setEditingId(null)
      router.refresh()
```

- [ ] **Step 6: Gates and commit**

`npm test`, cold tsc, `npm run build`.

```bash
git add app/money/actions.ts app/money/page.tsx components/MoneyRegister.tsx
git commit -m "feat: confirm a payee name once and every future import knows it"
```

---

### Task 5: Docs, review, walkthrough, ship

- [ ] **Docs:** `docs/BACKLOG.md` — a SHIPPED entry recording Dan's five decisions, that Wave C's pending model was wrong (the word was on the bank's axis, the section on the review axis), the dropdown root cause, and the residual that the `Pending` (uncleared) group will be empty for him by construction; `CLAUDE.md` — correct the Wave C pending doctrine to the new model (entered_at is a REVIEW MARKER, never an accounting gate; opacity must never wrap a popover; aliases apply before payee memory).
- [ ] **Final review** (top model, whole branch, via `scripts/review-package <merge-base> HEAD`): lens = Global Constraints. Especially: the budget gate is gone from BOTH explode helpers and no consumer still filters pending; `pendingBlocksReconcile` and its caller are fully removed; no `opacity`/transform/filter/isolation wraps any row containing a popover, and no z-index changed; `Enter All` counts the whole register; the alias is applied BEFORE the memory lookup; `setPayeeAlias` is owner-scoped on its bulk rename and upserts rather than failing; and that nothing writes to `lib/budget.ts`.
- [ ] **Walkthrough** (preview tool, dev sandbox — ask Dan to sign in if the session has lapsed): seed an unreviewed row; confirm it renders inline by date, bold, with the rail dot and NO chip; **open its category dropdown and confirm it draws solid and above the sticky header** (the reported bug); confirm `N to review · Enter All` appears and Enter clears the marks; confirm an uncleared row groups under `Pending`; then edit a row whose payee is a raw Chase string, confirm the `Use "…"` chip appears, accept it, save with the box ticked, and verify the alias row exists and sibling rows were renamed. Screenshot for Dan.
- [ ] **Ship (Dan's standing authorization, 2026-08-25, conditional):** `npm run db:migrate -- --prod` (0048) FIRST → merge → push → prod smoke (`/money` 307) → **`npm run parity`**. It MUST read 25/25 categories exact with Ready to Assign at −$146.84. If it reads anything else, the wave does NOT ship — revert the merge if it already landed, and report.

## Verification

Task 5's walkthrough and the parity gate, plus the gates at every commit: the inverted `ledgerSplits` tests, the new `payeeName` tests, full `npm test`, cold `npx tsc --noEmit`, `npm run build`.
