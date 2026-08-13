# Emailing invoices

**Status:** approved 2026-08-13

## Context

The invoice can now be built, tracked and downloaded, but it still has to be
attached to an email by hand. This is the step that actually retires the
spreadsheet: the Apps Script's whole job was to produce a PDF that then got
emailed.

Two things are already decided and are not reopened here. Email goes out through
**Resend on a sending subdomain**, so the root domain's live Google Workspace MX
and SPF records are never touched — that is the entire reason for the subdomain.
And every message carries `Reply-To: dan@theaudiosmith.com`, so a client's reply
lands in the inbox he actually reads.

Decided 2026-08-13: a client receives **both** an attached PDF and a link to view
the invoice online. The link exists because corporate mail filters strip
attachments, and "can you resend it, the PDF didn't come through" is a real cost.

## Decisions

| Question | Decision |
|---|---|
| Delivery | PDF attached **and** a link to a public page |
| Send flow | Preview recipient, subject and body; editable note; explicit confirm |
| Public page data access | A security-definer Postgres function, NOT the service-role key |
| Link lifetime | No expiry. Revocable by clearing the token. |
| Status change | `draft → sent` and `sent_at`, recorded **after** a successful send |
| Clients with no email | Send disabled, with a link to the client editor |

## Prerequisites (Dan's, not the code's)

The feature cannot send until these exist. They are independent of the build.

1. A Resend account and an API key.
2. A verified **sending subdomain** — the DNS records Resend issues (DKIM, SPF,
   and an MX for the subdomain only). **Every record is shown before anything is
   added to the domain.** The root domain's records are not touched.
3. Three environment variables in Vercel, and in `.env.local` for development:

   | Variable | Example | Why it is not hardcoded |
   |---|---|---|
   | `RESEND_API_KEY` | `re_…` | Secret. |
   | `INVOICE_FROM_EMAIL` | `invoices@mail.theaudiosmith.com` | The subdomain is not chosen until Resend is set up, and it must never be guessed in code. |
   | `APP_URL` | `https://billing.theaudiosmith.com` | The public link must be absolute in an email. Deriving it from request headers is wrong for a server-side send, which has no request. |

Until `RESEND_API_KEY` is present, `sendInvoiceEmail` returns an error saying
email is not configured. Nothing crashes and nothing else in the app degrades —
the download button, the tracker and the invoice screens are untouched.

`INVOICE_FROM_EMAIL` and `APP_URL` are read at send time, not at
module scope, for the same reason the Resend client is: a missing value must
produce a message, not a failed build.

## Architecture

### `lib/invoiceEmail.ts`

Build and send are separate functions, following CrewTracker's `inviteEmail.ts`:

```ts
export type InvoiceEmailInput = {
  to: string
  invoice: DocumentData      // the same type the renderers take
  publicUrl: string
  note: string | null        // Dan's per-send message, may be empty
  fromName: string
  replyTo: string
}

export function buildInvoiceEmail(input: InvoiceEmailInput):
  { subject: string; text: string; html: string }

export async function sendInvoiceEmail(
  input: InvoiceEmailInput & { pdf: Buffer },
): Promise<{ error?: string }>
```

`buildInvoiceEmail` is pure, so the wording, the figures and the absence of bank
details are all unit-testable without touching the network.

**`new Resend(key)` is constructed per call, never at module scope.** A top-level
client throws during `next build` wherever the key is absent — the failure that
broke every CrewTracker preview deployment until 2026-07-27.

The send returns `{ error }` rather than throwing, so a failed email never
destroys the record of what was being sent.

**Content.** Subject: `Invoice #386 from The Audio Smith`. Body: the amount due,
the due date, Dan's optional note, a link to the online copy, a line saying the
PDF is attached, and the remit-to text. Both `text` and `html` are produced; a
plain-text alternative measurably helps deliverability and costs nothing.

**`settings.ach_details` appears in neither body.** Bank numbers on a forwarded
email are the same exposure as bank numbers on a forwarded PDF.

### The public page

`invoices` gains one column:

```
public_token  uuid  null  unique
```

Nullable on purpose. The 105 imported invoices never had a link and must not
silently acquire one; a token is minted on first send. Clearing it revokes the
link, which is the whole of revocation — no expiry, because an invoice link that
dies is worse than one that lives, and it is read-only and unguessable
(`gen_random_uuid`, 122 bits).

Route: `app/i/[token]/page.tsx`, rendering `InvoiceDocument` — the same white
paper as the PDF, so the online copy and the attachment are the same document. It
also shows the status (paid, or overdue by N days), which is the one thing a
client wants that the PDF cannot express.

`/i` must be added to `PUBLIC_PREFIXES` in `proxy.ts`. Every route that answers
without a session has to be allowlisted there or it silently 307s to `/login`,
and the file's own header comment already names "a public invoice link" as the
case to watch.

### Why not the service-role key

The obvious way to read one invoice without a session is
`SUPABASE_SERVICE_ROLE_KEY`. That key is deliberately absent from Vercel today,
and it bypasses every policy in the database — a mistake in page code becomes
total exposure.

Instead, a **security-definer function**, granted `EXECUTE` to `anon` and to
nobody else:

```sql
create function public_invoice(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
```

Its body is a single `select` building one `jsonb` object from
`invoices where public_token = p_token`, joined to its `invoice_lines` ordered by
`position`, to `clients` for `name, address_line1, address_line2`, and to
`settings` for exactly seven columns: `business_name, legal_name, address_line1,
address_line2, phone, email, remit_to`. Those seven are precisely what
`InvoiceDocument` consumes — no more.

`revoke all on function public_invoice(uuid) from public;` then
`grant execute on function public_invoice(uuid) to anon, authenticated;` — so the
grant is explicit rather than inherited from `PUBLIC`.

Three properties matter:

- It can only ever return the row whose token matches. There is no filter for a
  caller to widen and no `select *` for a later edit to loosen.
- `anon` keeps **zero table privileges**. The security posture is unchanged
  except for this one function.
- `ach_details` is not in its select list, so the column is unreachable from the
  public side by construction rather than by remembering.

A null or unmatched token returns null, and the page renders a plain "not found"
— never an error that distinguishes "wrong token" from "no such invoice".

### The send action and its ordering

`sendInvoice(invoiceId, note)`:

1. Refuse if not signed in, if the client has no billing email — naming the
   client in the message — or if the invoice is `void`. **`draft`, `sent` and
   `paid` are all sendable:** a draft is the normal case, a `sent` invoice being
   sent again is a resend (the common real reason to press the button twice),
   and a `paid` one is occasionally wanted as a receipt. Only `void` is refused,
   because a voided invoice must never reach a client.
2. Mint `public_token` if absent.
3. Render the PDF server-side from `buildInvoicePdf` + `renderToBuffer`, the
   same builder the download button uses, so the attachment cannot differ from
   what was approved on screen.
4. Send.
5. **Only on success:** stamp `sent_at` and move `draft → sent`.

**The ordering is deliberate and its failure mode is stated.** If step 5 fails
after step 4 succeeded, the client has an invoice the app still calls a draft —
visible, and correctable by hand. The reverse ordering would mark an invoice sent
that never left, which nobody would ever notice. An invoice already `sent` can be
sent again; that is a resend, and it updates `sent_at`.

### `SendInvoicePanel`

Shows the real recipient address, the real subject, the rendered body, and a
textarea for a per-send note. Nothing sends until Confirm. The panel is where a
wrong address gets caught, which is the only place it can be caught — email is
irreversible.

## Testing

- `buildInvoiceEmail` is pure: assert the subject carries the invoice number, the
  body carries `formatUSD(total_cents)` and the due date via `formatDateLong`,
  and the link contains the token.
- Passing a settings object carrying `ach_details` — cast past the type, the way
  a careless widening would — must produce a body containing neither the routing
  nor the account number.
- An empty note must not leave a stray blank paragraph or a dangling label.
- **Query `public_invoice` as the `anon` role** and assert: a valid token returns
  exactly one invoice; a random token returns null; the payload contains none of
  `ach_details`, and no second invoice's number appears. This is the security
  claim, so it is tested against the database rather than reasoned about.
- Confirm `anon` still holds zero table privileges after the migration.

**Test sends go only to Dan's own address.** No test, script or verification step
sends to a real client. Sending to a client is a deliberate act behind the
confirm button.

## Out of scope

- Reminders for upcoming and overdue invoices. That is the next phase, and it
  depends on this one working.
- Any client-side action on the public page — no "mark as paid", no payment
  link, no comment box. It is read-only.
- Open and click tracking. It would require either a tracking pixel or rewritten
  links, both of which make an invoice email look like marketing to a spam
  filter.
- Backfilling tokens for the 105 historical invoices.
