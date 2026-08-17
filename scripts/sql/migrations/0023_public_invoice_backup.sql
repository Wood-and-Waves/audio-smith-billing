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
