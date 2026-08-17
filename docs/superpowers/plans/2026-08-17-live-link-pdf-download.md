# Download PDF on the Live Invoice Link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public `/i/[token]/pdf` route that regenerates the invoice PDF on demand — invoice + frozen hours/expense itemization, receipt photos omitted — and a Download PDF button on the public invoice page.

**Architecture:** Extract the PDF render out of `sendInvoice` into a shared server-only `renderInvoicePdf(data)` so the email and the link render identically. Add a pure `publicBackup()` that maps a frozen `backup_snapshot` to a `DocumentData.backup` with receipt images/paths removed. Add a security-definer `public_invoice_backup(p_token)` so the public route can read the frozen backup by token without service-role or storage access. The route reads `public_invoice` (document) + `public_invoice_backup` (backup, images nulled), renders, and streams a PDF download.

**Tech Stack:** Next.js 16 App Router (Node runtime route handler), React 19, TypeScript, `@react-pdf/renderer`, Supabase (security-definer RPC). Tests: `node --test` (`npm test`).

## Global Constraints

- **No receipt images, no private-storage access, no service-role on the public route.** Every expense in the public PDF has `receiptDataUri: null`.
- **`receipt_path` strings are stripped in the route** and never serialized to the browser (the browser receives only PDF bytes).
- **`ach_details` is unreachable** — neither `public_invoice` nor `public_invoice_backup` selects it; `buildInvoicePdf` never renders it.
- **Void invoices are excluded** from `public_invoice_backup` (matching `public_invoice`).
- **The emailed PDF and the in-app authenticated download must stay byte-for-byte unchanged** — `sendInvoice` still builds its `data` with receipt images and calls the shared `renderInvoicePdf`; the shared function is a verbatim relocation of the existing render block.
- **`renderInvoicePdf` is `server-only`** (reads the serverless filesystem for the font/logo); it must NOT be imported by any `node --test` file or plain node script. `publicBackup` is pure (no `@/`, no `server-only`, no JSX) and IS unit-tested with relative imports.
- **Migration 0023 is additive** (a new read-only function). Apply it to the live database and record its checksum in `schema_migrations`, per this repo's migration workflow (`db:migrate` uses the blocked session pooler; `db:sql` uses the working transaction pooler).
- **A malformed or non-matching token returns 404**, never a 500 that would confirm the token shape; a real RPC/render failure returns a generic 500 that never leaks `error.message`.

---

### Task 1: Extract `renderInvoicePdf` and use it in `sendInvoice`

Relocate the PDF render block into one shared server-only function so the email and the public link cannot drift. Output is unchanged.

**Files:**
- Create: `lib/renderInvoicePdf.ts`
- Modify: `app/invoices/actions.ts` (call the shared function; drop the now-unused `buildInvoicePdf` import)

**Interfaces:**
- Consumes: `buildInvoicePdf` (`@/lib/invoicePdf`), `DocumentData` (`@/components/InvoiceDocument`).
- Produces: `renderInvoicePdf(data: DocumentData): Promise<Buffer>` — dynamically imports `@react-pdf/renderer`, registers Oswald, renders `buildInvoicePdf(...)` with the logo, returns the Buffer. Throws on failure (callers wrap it).

- [ ] **Step 1: Create `lib/renderInvoicePdf.ts`**

```ts
import 'server-only'
import { buildInvoicePdf } from '@/lib/invoicePdf'
import type { DocumentData } from '@/components/InvoiceDocument'

// The one place an invoice PDF is rendered — shared by the email send
// (lib/invoiceEmail via app/invoices/actions.ts) and the public download route
// (app/i/[token]/pdf), so the attachment and the link can never render
// differently for the same invoice.
//
// SERVER ONLY: it reads the Oswald font and the logo off the serverless
// filesystem. Absolute paths from process.cwd(), never relative — the working
// directory is not something to depend on, and next.config must trace these
// files into every route bundle that calls this (see outputFileTracingIncludes).
//
// It THROWS on failure rather than swallowing: each caller has its own
// contract for a render error (the action returns { error }; the route returns
// a 500), so the catch lives at the call site, not here.
export async function renderInvoicePdf(data: DocumentData): Promise<Buffer> {
  const { join } = await import('node:path')
  const { Document, Page, Text, View, Image, Font, renderToBuffer } =
    await import('@react-pdf/renderer')
  Font.register({
    family: 'Oswald',
    src: join(process.cwd(), 'public', 'fonts', 'Oswald-Bold.ttf'),
    fontWeight: 700,
  })
  return renderToBuffer(
    buildInvoicePdf(
      { Document, Page, Text, View, Image },
      data,
      { logoSrc: join(process.cwd(), 'public', 'logo.png') },
    ),
  )
}
```

- [ ] **Step 2: Replace the inline render block in `sendInvoice`**

In `app/invoices/actions.ts`, find the render block:

```ts
  let pdf: Buffer
  try {
    const { join } = await import('node:path')
    const { Document, Page, Text, View, Image, Font, renderToBuffer } =
      await import('@react-pdf/renderer')
    Font.register({
      family: 'Oswald',
      src: join(process.cwd(), 'public', 'fonts', 'Oswald-Bold.ttf'),
      fontWeight: 700,
    })
    pdf = await renderToBuffer(
      buildInvoicePdf(
        { Document, Page, Text, View, Image },
        data,
        { logoSrc: join(process.cwd(), 'public', 'logo.png') },
      ),
    )
  } catch (e) {
    return {
      error: 'The invoice PDF could not be rendered: ' +
        (e instanceof Error ? e.message : 'unknown error.'),
    }
  }
```

Replace it with:

```ts
  let pdf: Buffer
  try {
    pdf = await renderInvoicePdf(data)
  } catch (e) {
    return {
      error: 'The invoice PDF could not be rendered: ' +
        (e instanceof Error ? e.message : 'unknown error.'),
    }
  }
```

The comment block just above `let pdf: Buffer` (about absolute paths / next.config tracing / the never-throw contract) may stay or be trimmed — leave it; it still explains why the call is wrapped.

- [ ] **Step 3: Fix imports in `app/invoices/actions.ts`**

Add near the other `@/lib` imports:

```ts
import { renderInvoicePdf } from '@/lib/renderInvoicePdf'
```

Remove the now-unused `buildInvoicePdf` import (line 7 — after Step 2 it is referenced nowhere else in the file):

```ts
import { buildInvoicePdf } from '@/lib/invoicePdf'
```

- [ ] **Step 4: Confirm `buildInvoicePdf` is gone from the file and typecheck**

Run: `grep -n "buildInvoicePdf" app/invoices/actions.ts`
Expected: no output.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Build and render-smoke**

Run: `npm run build`
Expected: clean.

Run: `npm run pdf:sample`
Expected: renders a sample PDF without error (proves the `buildInvoicePdf` path this refactor relocates still works; `pdf:sample` uses `buildInvoicePdf` directly, not `renderInvoicePdf`, so it is unaffected by the extraction and confirms the builder itself is intact).

- [ ] **Step 6: Run the test suite**

Run: `npm test`
Expected: unchanged pass count (this task adds no tests and changes no tested logic).

- [ ] **Step 7: Commit**

```bash
git add lib/renderInvoicePdf.ts app/invoices/actions.ts
git commit -m "Extract renderInvoicePdf shared by the email and the public link"
```

---

### Task 2: `publicBackup` — strip images and paths from a frozen snapshot

A pure mapper from a raw `backup_snapshot` (as stored / returned by `public_invoice_backup`) to a `DocumentData.backup` with every `receiptDataUri` null and no `receipt_path`.

**Files:**
- Create: `lib/publicInvoiceBackup.ts`
- Test: `scripts/test/publicInvoiceBackup.test.ts`

**Interfaces:**
- Consumes: `DocumentData` (type only, `../components/InvoiceDocument.tsx`).
- Produces: `publicBackup(snapshot: unknown): DocumentData['backup'] | undefined` — returns `undefined` for a null/non-object snapshot; otherwise the hours fields preserved and each expense mapped to `{ category, where_spent, amount_cents, spent_on, receiptDataUri: null }` (dropping `receipt_path` and any image).

- [ ] **Step 1: Write the failing test**

Create `scripts/test/publicInvoiceBackup.test.ts`:

```ts
// publicBackup is the guard that keeps receipt PHOTOS and storage PATHS out of
// the public download: it maps a frozen snapshot to the PDF's backup shape with
// every image nulled and every path dropped, while preserving the hours and
// expense itemisation the client already saw in the emailed PDF.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicBackup } from '../../lib/publicInvoiceBackup.ts'

const SNAPSHOT = {
  show_hours: true,
  shows: [{
    name: 'Willow Creek', zone_label: 'Chicago',
    days: [{
      day: '2026-08-01', in: '09:00', out: '17:00', meal_minutes: 30,
      net_hours: 7.5, st_hours: 7.5, ot_hours: 0, dt_hours: 0,
      travel_in: false, travel_out: false, half_day: false, meal_penalties: 0,
    }],
  }],
  total_net: 7.5, total_st: 7.5, total_ot: 0, total_dt: 0,
  expenses: [{
    category: 'meals', where_spent: 'Panera', amount_cents: 1875, spent_on: '2026-08-01',
    receipt_path: 'owner-uuid/receipt-abc.jpg',
  }],
}

test('a null or non-object snapshot yields undefined (no backup pages)', () => {
  assert.equal(publicBackup(null), undefined)
  assert.equal(publicBackup(undefined), undefined)
  assert.equal(publicBackup('nope'), undefined)
})

test('expense images are nulled and receipt paths are dropped', () => {
  const b = publicBackup(SNAPSHOT)
  assert.ok(b, 'a snapshot produces a backup')
  assert.equal(b.expenses.length, 1)
  const e = b.expenses[0]
  assert.equal(e.receiptDataUri, null, 'no image')
  assert.ok(!('receipt_path' in e), 'no storage path carried through')
  assert.equal(e.category, 'meals')
  assert.equal(e.where_spent, 'Panera')
  assert.equal(e.amount_cents, 1875)
  assert.equal(e.spent_on, '2026-08-01')
})

test('hours itemisation is preserved', () => {
  const b = publicBackup(SNAPSHOT)
  assert.ok(b)
  assert.equal(b.show_hours, true)
  assert.equal(b.total_net, 7.5)
  assert.equal(b.shows.length, 1)
  assert.equal(b.shows[0].days[0].net_hours, 7.5)
})

test('a snapshot with no expenses maps to an empty expense list', () => {
  const b = publicBackup({ ...SNAPSHOT, expenses: [] })
  assert.ok(b)
  assert.deepEqual(b.expenses, [])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Write `lib/publicInvoiceBackup.ts`**

```ts
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
```

If the `shows` conditional type proves awkward under the compiler, type `shows` as `NonNullable<DocumentData['backup']>['shows']` instead — the runtime behavior (pass the shows array through unchanged) is what matters; the array is already in the exact shape the PDF wants.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — the four `publicInvoiceBackup` tests pass; the rest of the suite is unchanged.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/publicInvoiceBackup.ts scripts/test/publicInvoiceBackup.test.ts
git commit -m "Add publicBackup: itemization without receipt photos or paths"
```

---

### Task 3: Migration 0023 — `public_invoice_backup(p_token)`

Write the security-definer function that returns the frozen backup by token. **This task writes the SQL file only; the controller applies it to the live database and records the checksum** (a production-DB touch handled outside the subagent).

**Files:**
- Create: `scripts/sql/migrations/0023_public_invoice_backup.sql`

- [ ] **Step 1: Write the migration**

Create `scripts/sql/migrations/0023_public_invoice_backup.sql`:

```sql
-- 0023 — the frozen backup behind the public Download-PDF button
--
-- The public page reads through public_invoice() (0006), which returns only the
-- invoice document — no backup. The Download-PDF button on that page needs the
-- frozen hours/expense backup so the downloaded PDF matches the emailed one,
-- MINUS the receipt photos. This is the narrow, token-scoped reader for exactly
-- that: it returns one invoice's backup_snapshot and nothing else.
--
-- Same trust model as public_invoice: security definer with a pinned
-- search_path, keyed only on the unguessable token, void invoices excluded, and
-- no path for a caller to widen. ach_details is not in backup_snapshot, so bank
-- details remain unreachable. The snapshot's receipt_path strings are stripped
-- in the route (lib/publicInvoiceBackup) and never reach the browser; the
-- receipt IMAGES live in private storage this function never touches.
create function public.public_invoice_backup(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $fn$
  select i.backup_snapshot
  from invoices i
  where i.public_token = p_token
    and i.status <> 'void'
$fn$;

-- anon is the public page's role; authenticated is Dan. Both may read the
-- backup for a token they hold. No other privilege is granted.
grant execute on function public.public_invoice_backup(uuid) to anon, authenticated;
```

- [ ] **Step 2: Commit the migration file**

```bash
git add scripts/sql/migrations/0023_public_invoice_backup.sql
git commit -m "Migration 0023: public_invoice_backup security-definer reader"
```

**Application (controller-run, after this task's review — NOT part of the subagent's work):**
- Try `npm run db:migrate` (records the checksum automatically). If the session pooler times out on the current network, fall back:
  - Apply the DDL: `npm run db:sql -- scripts/sql/migrations/0023_public_invoice_backup.sql`
  - Compute the checksum: `node -e "const{createHash}=require('crypto');const{readFileSync}=require('fs');console.log(createHash('sha256').update(readFileSync('scripts/sql/migrations/0023_public_invoice_backup.sql')).digest('hex').slice(0,16))"`
  - Record it: run a one-line `insert into public.schema_migrations (filename, checksum) values ('0023_public_invoice_backup.sql', '<checksum>');` via `db:sql`.
- Verify: `select public_invoice_backup('00000000-0000-0000-0000-000000000000'::uuid);` returns `null` with no error, and `select filename from schema_migrations where filename = '0023_public_invoice_backup.sql';` returns the row.

---

### Task 4: Public PDF route, file tracing, and the Download button

Wire the route that reads the two RPCs, renders images-nulled, and streams the download; trace the font/logo into its bundle; add the button.

**Files:**
- Create: `app/i/[token]/pdf/route.ts`
- Modify: `next.config.ts` (trace fonts/logo into the new route)
- Modify: `app/i/[token]/page.tsx` (Download PDF button)

**Interfaces:**
- Consumes: `createClient` (`@/lib/supabase/server`), `renderInvoicePdf` (Task 1), `publicBackup` (Task 2), `invoiceFilename` (`@/lib/invoicePdf`), `DocumentData` (`@/components/InvoiceDocument`), and the two RPCs `public_invoice` / `public_invoice_backup` (Task 3).

- [ ] **Step 1: Create `app/i/[token]/pdf/route.ts`**

```ts
import { createClient } from '@/lib/supabase/server'
import { renderInvoicePdf } from '@/lib/renderInvoicePdf'
import { publicBackup } from '@/lib/publicInvoiceBackup'
import { invoiceFilename } from '@/lib/invoicePdf'
import type { DocumentData } from '@/components/InvoiceDocument'

// The public Download-PDF endpoint. Same capability model as /i/[token]: gated
// only by the unguessable token, no session, no service role, no storage
// access. It reads the document (public_invoice) and the frozen backup
// (public_invoice_backup), strips receipt images/paths via publicBackup, renders
// with the shared renderInvoicePdf, and streams the file. Node runtime: the
// render reads the font/logo off the filesystem.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A malformed uuid is a driver error, not a null row; guard the shape so a bad
// token is a 404, never a 500 that would confirm the parameter is a uuid.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  if (!UUID.test(token)) return new Response('Not found', { status: 404 })

  const supabase = await createClient()
  const [{ data: doc, error: docErr }, { data: backup, error: backErr }] = await Promise.all([
    supabase.rpc('public_invoice', { p_token: token }),
    supabase.rpc('public_invoice_backup', { p_token: token }),
  ])

  // A DB error and a token that matches nothing are different answers: 500 for a
  // real failure (generic body — never error.message, which can carry schema
  // detail), 404 for a miss (so a stranger cannot tell a real token from a fake
  // one).
  if (docErr || backErr) {
    console.error('[public-invoice-pdf] rpc failed', {
      docCode: docErr?.code, backCode: backErr?.code,
    })
    return new Response('This invoice could not be loaded right now.', { status: 500 })
  }
  if (!doc) return new Response('Not found', { status: 404 })

  const data: DocumentData = {
    ...(doc as DocumentData),
    backup: publicBackup(backup),
  }

  let pdf: Buffer
  try {
    pdf = await renderInvoicePdf(data)
  } catch (e) {
    console.error('[public-invoice-pdf] render failed', e)
    return new Response('This invoice could not be rendered right now.', { status: 500 })
  }

  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoiceFilename(data)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
```

- [ ] **Step 2: Trace the font and logo into the new route**

In `next.config.ts`, add an entry to `outputFileTracingIncludes` alongside the existing `/invoices/[id]` one:

```ts
    '/i/[token]/pdf': ['./public/fonts/Oswald-Bold.ttf', './public/logo.png'],
```

- [ ] **Step 3: Add the Download PDF button to `app/i/[token]/page.tsx`**

In the returned JSX, immediately after `<InvoiceDocument data={invoice} />` and before the "Questions about this invoice?" paragraph, add:

```tsx
        <div className="mt-6 text-center">
          <a
            href={`/i/${token}/pdf`}
            className="inline-block px-5 py-2.5 bg-accent-surface text-accent-ink font-bold
                       uppercase tracking-wider text-sm rounded-field hover:opacity-90
                       transition-opacity"
          >
            Download PDF
          </a>
        </div>
```

(`token` is already in scope in this component.)

- [ ] **Step 4: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: both clean; the build output lists the `/i/[token]/pdf` route.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: unchanged pass count (this task adds no unit tests; the route is covered by manual verification).

- [ ] **Step 6: Commit**

```bash
git add app/i/[token]/pdf/route.ts next.config.ts app/invoices/[id]/page.tsx
```

(Note: the page changed is `app/i/[token]/page.tsx`, not `[id]` — stage that path.)

```bash
git add "app/i/[token]/pdf/route.ts" next.config.ts "app/i/[token]/page.tsx"
git commit -m "Add public Download-PDF route and button"
```

---

## Verification

- `npm test`, `npx tsc --noEmit`, `npm run build` — all clean; the build lists `/i/[token]/pdf`.
- `grep -n "buildInvoicePdf" app/invoices/actions.ts` — empty (the extraction is complete).
- Migration 0023 applied and verified (controller): `public_invoice_backup` returns null for a random token with no error, and `schema_migrations` has the 0023 row.
- **Manual, on a real sent invoice with expenses:** open `/i/<token>`, click **Download PDF**; the file downloads and opens showing the invoice + hours/expense itemization and **no receipt photos**. Confirm a bad token (`/i/not-a-uuid/pdf`) returns 404. Confirm the emailed PDF is unchanged (its `data` assembly and the shared render are unchanged; trust that plus the render-smoke, or send a test invoice to Dan's own address).

## Blast radius

Adds one server-only module, one pure module (+test), one additive DB function, one public route, one `next.config` entry, and one button. The refactor relocates the email's render call without changing its output. The existing `public_invoice` and the public page's data read are unchanged. No receipt-storage access is added anywhere. The only production-DB change is a new read-only, token-scoped, void-excluding function.

## Out of scope (backlog)

- Receipt photos in the public PDF (declined — would need private-storage access on a public route).
- Storing the emitted PDF bytes.
