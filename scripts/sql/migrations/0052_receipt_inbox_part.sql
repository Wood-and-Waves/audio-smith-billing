-- 0052 — one email can hold many receipts
--
-- 0050 assumed one forwarded receipt per email, and its unique key says so:
-- (owner_id, gmail_message_id). That is wrong for the way Dan actually sends
-- expenses to a client. IllumiNations is ONE 16-page PDF holding an invoice, an
-- expense spreadsheet, and fourteen receipts — and a bundle like that has to
-- become fourteen filable items, not one.
--
-- `part` is the index of a receipt within its message. Every row written before
-- this migration keeps 0, so their uniqueness is exactly what it was; the
-- widened key is what lets a bundle explode.
--
-- ADDITIVE, per the 0020 rule: no column is dropped, no row is rewritten, and
-- the constraint is widened rather than removed — (owner_id, gmail_message_id)
-- stays unique for any message that yields a single receipt.
--
-- Not backfill-only scaffolding: this is also what the emailed-receipt inbox
-- needs the first time a client sends a bundle rather than a single receipt.

alter table receipt_inbox add column part int not null default 0;

comment on column receipt_inbox.part is
  'Index of this receipt within its Gmail message. 0 for a message that carried a single receipt, which is every row written before migration 0052.';

alter table receipt_inbox drop constraint receipt_inbox_msg_uniq;
alter table receipt_inbox add constraint receipt_inbox_msg_uniq
  unique (owner_id, gmail_message_id, part);
