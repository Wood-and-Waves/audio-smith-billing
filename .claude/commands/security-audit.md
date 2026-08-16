---
description: Full security audit for a Next.js + Supabase + Vercel project
argument-hint: [pass number 1-7, or "all"]
allowed-tools: Read, Grep, Glob, Bash(git log:*), Bash(git diff:*), Bash(npm audit:*), Write
---

You are performing a security audit of a Next.js (App Router) + Supabase + Vercel
application. Work in READ-ONLY mode except for writing findings to
`security-audit/findings-pass-N.md`. Do not fix anything yet.

Requested pass: $ARGUMENTS

Run each pass as a separate sub-agent task so context stays clean. For every
finding, record: file:line, severity (critical/high/medium/low), a concrete
attack path (who calls what, with which token, to get which data), and the
minimal fix. Assign a confidence score 1-10 and drop anything below 6.
Do not report findings in markdown/docs files. Do not report theoretical
best-practice violations with no exploit path.

Known, deliberate design decisions — verify each still holds rather than
re-litigating it, and flag only if the implementation has drifted:
- `SUPABASE_SERVICE_ROLE_KEY` and the three `DROPBOX_*` variables are read in
  exactly one file: `app/api/cron/reminders/route.ts`.
- The dev-login route exists but must 404 outside development.
- `settings.ach_details` must never reach an invoice, an email body, the public
  page, or any browser payload. `remit_to` prints; ACH is given only on request.
- `/i/[token]` and `/api/cron/reminders` are intentionally unauthenticated /
  secret-gated respectively — audit their scope, not their existence.

## Pass 1 — Secrets and public surface
- Every `NEXT_PUBLIC_*` variable: confirm it is safe to ship to the browser.
- `SUPABASE_SERVICE_ROLE_KEY` (and any admin client): every import path must be
  server-only. Trace each importer transitively — flag any module reachable from
  a `"use client"` component or from middleware. Check for `import "server-only"`.
- `DROPBOX_REFRESH_TOKEN` explicitly: it is a standing grant on a personal
  Dropbox account holding financial records. Same confinement trace as the
  service key, plus: confirm no code path can echo it into a response, a log
  line, or an error message.
- Hardcoded keys, JWTs, connection strings, webhook secrets in source or in
  committed `.env*` files. Check `git log -p --all -- .env*` for historical leaks.
- Source maps enabled in production (`productionBrowserSourceMaps`).

## Pass 2 — Database authorization (read `security-audit/schema.sql` and `security-audit/policies.txt`)
- Any table in an API-exposed schema with RLS disabled = readable/writable by the
  anon key. Flag every one as CRITICAL.
- Tables with RLS enabled but zero policies (silently deny — flag if the app
  appears to rely on them).
- Policies with `USING` but no `WITH CHECK` on INSERT/UPDATE (users can write rows
  they cannot read — cross-tenant write).
- Policies referencing `auth.uid()` through a joined table that is itself
  unprotected, or using `auth.jwt()` claims a user can influence.
- Views and functions marked `SECURITY DEFINER` that read RLS-protected tables;
  views without `security_invoker = on`.
- Grants to the `anon` and `authenticated` roles beyond what is needed.
- Storage buckets marked public, and missing `storage.objects` policies.
- Edge functions with JWT verification disabled, or that trust a `user_id` from
  the request body instead of the verified JWT.

## Pass 3 — Auth boundary
- Any use of `getSession()` in server code where the result gates access:
  it reads the cookie without revalidating. Server-side gating must use
  `getUser()`. Flag each occurrence.
- Middleware used as the only authorization check. Middleware is a routing
  concern, not an authorization boundary — every protected route handler, server
  action, and data fetch must re-check identity AND permission itself.
- Middleware `matcher` gaps that leave protected paths unmatched. This app's
  proxy allowlists `/api/cron` and the public invoice route — confirm the
  allowlist is exactly those and nothing broader.
- Session/cookie flags, token refresh handling, sign-out completeness.
- Open redirects from `?next=` / `?redirectTo=` params passed to `redirect()`.
- The dev-login route: confirm the environment gate cannot be satisfied in
  production, not merely that it exists.

## Pass 4 — Server Actions and Route Handlers
Enumerate every `"use server"` function and every `app/**/route.ts` export.
Treat each as a public, unauthenticated HTTP POST endpoint that an attacker can
invoke directly, regardless of what the UI renders. For each one report whether
it has: (a) authentication check, (b) authorization check for the *specific*
resource, (c) input validation/parsing, (d) rate limiting. Missing (b) on any
action that takes an id is an IDOR — flag as high or critical.

Classify each endpoint first: AUTHENTICATED (must have a-d), INTENTIONALLY
PUBLIC (`/i/[token]`), or SECRET-GATED (`/api/cron/reminders`). For the public
and secret-gated ones, audit the scope of what they return and the strength of
their gate — do not flag the absence of user auth itself, which is by design.
A finding that says "the cron has no session" is noise; a finding that says
"the cron's dry-run response leaks X to a holder of a stale secret" is signal.

Also check: cron routes verifying `CRON_SECRET` (constant-time); webhook routes
verifying the provider signature against the raw body; file-upload routes
validating type/size; the OCR action (`extractReceipt`) confirming the storage
path it reads is prefixed by the caller's own user id.

## Pass 5 — Data exposure to the client
- Server components passing whole DB rows into client components: the full object
  is serialized into the RSC payload and visible in the browser. Look for
  password hashes, internal flags, other users' PII, provider customer ids.
- `unstable_cache` / `revalidate` / cached `fetch` applied to per-user data —
  cross-user cache poisoning.
- Error responses that return raw Postgres or Supabase errors to the client.
- `dangerouslySetInnerHTML` with any value not provably static.
- Logging of tokens, keys, or full request bodies.

## Pass 6 — Platform configuration
- `next.config.*`: `images.remotePatterns` wildcards (SSRF / open image proxy),
  `dangerouslyAllowSVG`, `ignoreBuildErrors`, custom rewrites/proxies.
- Security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy) in
  `next.config` or `vercel.json`.
- CORS on route handlers — reflected origin or `*` alongside credentials.
- `npm audit --omit=dev` and outdated `next` / `@supabase/*` versions.
- Flag for manual check (you cannot verify these from the repo): Vercel
  deployment protection on preview URLs, environment-scoping of secrets to
  Production only, and whether previews point at the production Supabase project.

## Pass 7 — Data that leaves on purpose
The passes above audit whether an attacker can get in. This pass audits the
surfaces where data goes OUT by design, which is where a billing app's real
exposure lives.

- **The public invoice link (`/i/[token]`).** Unauthenticated by design. Audit:
  exactly which fields the public payload carries, at the RPC/query level —
  compare against the minimum a client needs to pay an invoice. Does a token
  stop working when its invoice is unlinked, voided, or deleted? Is there any
  revocation path at all? How are tokens minted (entropy, single mint per
  invoice)? Known live instance to verify: invoice #379 carries a stray token
  from testing — confirm whether it still resolves, and report what it shows.
- **Email.** Trace every send: invoice sends, client reminders, overdue alerts,
  the Monday digest. For each: where does the recipient address come from, and
  what validates it? What does the body/attachment contain — confirm by
  construction (types, not string tests alone) that `ach_details` cannot reach
  any template. The digest carries client names and amounts — confirm its
  recipient can only ever be the owner's own settings email.
- **Signed receipt URLs.** One-hour Supabase Storage URLs. Enumerate every place
  one is minted and where it travels: RSC payloads, email bodies, PDF pipelines,
  client-side fetches. A signed URL in an email or a cached payload is a
  shareable financial document for its lifetime.
- **Third-party data flows, as one inventory table.** Anthropic (receipt images
  for OCR), Resend (invoice PDFs, reminder bodies), Dropbox (receipt originals,
  permanently), Supabase (everything), Vercel (logs). For each: what it holds,
  how long, and under whose account. This section is for conscious acceptance,
  not findings — but flag any flow NOT on this list that the code reveals.
- **Git history, beyond `.env*`.** The raw sheet export (client data with bank
  routing/account numbers in a Notes column) and the `receipts/` photo folder
  were gitignored — confirm via `git log` that neither ever entered history
  under any path. Check for any other committed file that looks like an export,
  dump, or backup.
- **Cron responses land in Vercel logs.** The JSON includes invoice numbers,
  amounts, and receipt filenames containing vendor names and prices. Visibility
  is Dan-only via the Vercel dashboard — record it on the manual-check list with
  what a Vercel account compromise would read from retained logs.

## Output
Write `security-audit/findings-pass-N.md` per pass, then a consolidated
`security-audit/REPORT.md` ordered by severity, with a short "verify manually"
section for anything you could not confirm from the code.

`security-audit/` must be gitignored before anything is written into it — the
report is a map of attack paths against a live billing system and the repo is
on GitHub.
