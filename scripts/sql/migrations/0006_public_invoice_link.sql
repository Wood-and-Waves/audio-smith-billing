-- 0006 — a public, read-only link to one invoice
--
-- Clients receive the PDF as an attachment, but corporate mail filters strip
-- attachments, so each sent invoice also gets a link to an online copy.
--
-- The token is NULLABLE on purpose. The 105 imported invoices never had a link
-- and must not silently acquire one; a token is minted on first send. Clearing
-- it revokes the link, which is the whole of revocation — there is no expiry,
-- because an invoice link that dies is worse than one that lives, and the token
-- is unguessable and the page read-only.
alter table invoices
  add column public_token uuid unique;

-- How the public page reads.
--
-- The alternative was the service-role key, which is deliberately absent from
-- Vercel and bypasses every policy in this database — one careless select in
-- page code would become total exposure. This function is the narrow version of
-- the same capability: it can only ever return the row whose token matches,
-- there is no filter for a caller to widen, and ach_details is not in its select
-- list, so bank details are unreachable from the public side by construction
-- rather than by remembering.
--
-- security definer + a pinned search_path: the function runs as its owner, so
-- search_path must not be attacker-influenced.
--
-- A void invoice is excluded. Voiding an invoice must take it away from the
-- client too, not merely hide it in the app.
create function public.public_invoice(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public
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

-- create function grants EXECUTE to PUBLIC by default, so the revoke is not
-- redundant — without it, every role would get this.
revoke all on function public.public_invoice(uuid) from public;
grant execute on function public.public_invoice(uuid) to anon, authenticated;
