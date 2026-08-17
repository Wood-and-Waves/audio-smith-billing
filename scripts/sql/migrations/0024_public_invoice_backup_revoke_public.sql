-- 0024 — least-privilege fix for public_invoice_backup (0023)
--
-- `create function` grants EXECUTE to PUBLIC by default. 0006 revokes that for
-- public_invoice, but 0023 created public_invoice_backup without the matching
-- revoke, so PUBLIC kept the default grant. No API-reachable role gains anything
-- (anon and authenticated are the intended callers; service_role bypasses this
-- regardless), but the whole codebase's convention is to strip the PUBLIC grant
-- and name the callers explicitly. This restores that, and re-grants to be
-- explicit. Idempotent and safe to run against the already-created function.
revoke all on function public.public_invoice_backup(uuid) from public;
grant execute on function public.public_invoice_backup(uuid) to anon, authenticated;
