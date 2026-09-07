-- 0050 — receipts forwarded by email, waiting to be filed
--
-- Dan labels a receipt `audiosmith_receipts` in Gmail and the app collects it
-- here. Nothing files itself: an item waits until he says where it belongs,
-- which is the same judgement the Matches queue already makes.
--
-- WHY A STAGING TABLE rather than writing straight to an expense: an emailed
-- receipt arrives with no idea what it is for, and the app's two homes for a
-- receipt want different things. His own question settled it (2026-09-07):
-- "What if the receipt I forward is not from a show, say Spotify?" — expenses
-- carry a NOT NULL show_id and feed a client's invoice, so a subscription is
-- not an expense in this app's sense at all. It belongs on the BANK ROW for
-- that charge (ledger_transactions.receipt_path, migration 0031). So an item
-- here can end up either place, and the two nullable filed_* columns below
-- record which.
--
-- The FILE bytes are not stored here. Attachments go to the existing private
-- `receipts` bucket under {owner_id}/inbox/, which already scopes every object
-- by its first path segment (0010) — no new bucket, no new policy.
--
-- ADDITIVE ONLY, per the 0020 rule.

create table receipt_inbox (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,

  -- Gmail's own message id. The dedupe key: the poller re-reads the whole
  -- label every run (Gmail has no "since" cursor worth trusting across
  -- relabelling), so the unique constraint below is what makes a second pass
  -- a no-op instead of a duplicate.
  gmail_message_id  text not null check (length(btrim(gmail_message_id)) > 0),

  from_email        text not null default '',
  subject           text not null default '',
  received_at       timestamptz,

  -- What extraction read, or null where it could not tell. Deliberately
  -- nullable and deliberately NOT trusted: Dan confirms every one before it
  -- becomes money anywhere.
  vendor            text,
  amount_cents      int check (amount_cents is null or amount_cents > 0),
  spent_on          date,

  -- Every attachment kept, as [{filename, mimeType, path, size}]. All of them,
  -- never a chosen one: ElevenLabs sends an Invoice-*.pdf AND a Receipt-*.pdf,
  -- and while "receipt" is the one worth reading first, that naming is
  -- Stripe's convention rather than a standard. Discarding the other to save
  -- a few KB would be the wrong trade the first time the guess is wrong.
  attachments       jsonb not null default '[]'::jsonb,

  -- The attachment chosen to show and extract from, or null when the body
  -- carried everything (an amount in the text and nothing attached).
  primary_path      text,

  status            text not null default 'new'
                      check (status in ('new', 'filed', 'dismissed')),

  -- Exactly one is set once filed, and both stay null while status is 'new'.
  -- ON DELETE SET NULL, not CASCADE: deleting the transaction a receipt was
  -- filed against must not delete the record that it arrived.
  filed_transaction_id uuid references ledger_transactions(id) on delete set null,
  filed_expense_id     uuid references expenses(id) on delete set null,

  created_at        timestamptz not null default now(),

  constraint receipt_inbox_msg_uniq unique (owner_id, gmail_message_id),
  constraint receipt_inbox_one_destination check (
    filed_transaction_id is null or filed_expense_id is null
  )
);

comment on table receipt_inbox is
  'Receipts forwarded from Gmail, staged until Dan files them. An item goes '
  'to a BANK ROW (overhead — Spotify, software) or to a SHOW as an expense '
  '(client-billable). Nothing files automatically; extraction proposes and he '
  'confirms.';

comment on column receipt_inbox.gmail_message_id is
  'Gmail''s message id, unique per owner. The poller re-reads the whole label '
  'each run, so this is what makes a second pass a no-op.';

comment on column receipt_inbox.attachments is
  'Every attachment: [{filename, mimeType, path, size}]. All kept; '
  'primary_path names the one worth reading first.';

create index receipt_inbox_owner_status_idx on receipt_inbox (owner_id, status, received_at desc);

alter table receipt_inbox enable row level security;
create policy receipt_inbox_owner_all on public.receipt_inbox
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.receipt_inbox from anon;
grant select, insert, update, delete on public.receipt_inbox to authenticated;
grant all on public.receipt_inbox to service_role;
