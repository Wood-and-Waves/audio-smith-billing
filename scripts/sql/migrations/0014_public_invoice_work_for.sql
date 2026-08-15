-- 0014 — the public invoice link gains a FOR: heading
--
-- There are THREE places that assemble the document a client sees, not two.
-- The app page (app/invoices/[id]/page.tsx) and the emailed PDF
-- (app/invoices/actions.ts's sendInvoice) both print work_for as a FOR:
-- heading under BILL TO. public_invoice() (0006) builds its own jsonb
-- payload column by column and was never touched, so /i/<token> — the link
-- a client reaches when their mail filter strips the PDF attachment, which
-- is the exact reason this page exists — renders no FOR: line at all.
--
-- CREATE OR REPLACE FUNCTION, not ALTER FUNCTION: the jsonb payload itself
-- is changing, not just a function property. This restates 0006's body
-- verbatim plus one new key, and folds in 0007's search_path fix directly
-- (`set search_path = public, pg_temp`) — CREATE OR REPLACE does not carry
-- forward a config parameter attached afterwards by ALTER FUNCTION ... SET,
-- so omitting it here would silently un-pin pg_temp on this security
-- definer function. Nothing else about the function changes.
create or replace function public.public_invoice(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
stable
as $fn$
  select jsonb_build_object(
    'number',           i.number,
    'issue_date',       i.issue_date,
    'due_date',         i.due_date,
    'terms_days',       i.terms_days,
    'status',           i.status,
    'bill_to_snapshot', i.bill_to_snapshot,
    'subtotal_cents',   i.subtotal_cents,
    'tax_bp',           i.tax_bp,
    'tax_cents',        i.tax_cents,
    'deposit_cents',    i.deposit_cents,
    'total_cents',      i.total_cents,
    -- Mirrors app/invoices/[id]/page.tsx: an imported invoice's note is an
    -- internal remark about the import, not something a client should read.
    'notes',            case when i.imported then null else i.notes end,
    -- What the invoice is for — show names, frozen in at bill time. Null on
    -- every hand-written invoice and all invoices billed before this
    -- shipped, which render nothing here, exactly like the app page and the
    -- emailed PDF already do.
    'work_for',          i.work_for,
    'client', jsonb_build_object(
      'name',          c.name,
      'address_line1', c.address_line1,
      'address_line2', c.address_line2
    ),
    'lines', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',               l.id,
          'description',      l.description,
          'qty_hundredths',   l.qty_hundredths,
          'unit_price_cents', l.unit_price_cents,
          'line_total_cents', l.line_total_cents
        ) order by l.position
      )
      from invoice_lines l
      where l.invoice_id = i.id
    ), '[]'::jsonb),
    -- Exactly the seven columns InvoiceDocument consumes. ach_details is not
    -- among them and must never be added.
    'settings', (
      select jsonb_build_object(
        'business_name', s.business_name,
        'legal_name',    s.legal_name,
        'address_line1', s.address_line1,
        'address_line2', s.address_line2,
        'phone',         s.phone,
        'email',         s.email,
        'remit_to',      s.remit_to
      )
      from settings s where s.id = 1
    )
  )
  from invoices i
  left join clients c on c.id = i.client_id
  where i.public_token = p_token
    and i.status <> 'void';
$fn$;

-- CREATE OR REPLACE preserves ownership and existing grants (see the
-- CREATE FUNCTION docs), so the 0006 grants to anon/authenticated need no
-- restatement here.
