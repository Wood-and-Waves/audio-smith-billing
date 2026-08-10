-- 0002 — allocate invoice numbers atomically
--
-- Read-then-write from application code can hand the same number to two
-- drafts. A single UPDATE ... RETURNING can't: Postgres serialises the row.
--
-- The number is claimed when a draft is created, so gaps appear if a draft is
-- deleted. That matches the existing history, which already has 9 genuinely
-- unused numbers (368-376), so nothing downstream may assume gapless numbering.

create or replace function allocate_invoice_number()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed int;
begin
  update settings
     set next_invoice_number = next_invoice_number + 1
   where id = 1 and owner_id = auth.uid()
  returning next_invoice_number - 1 into claimed;

  if claimed is null then
    raise exception 'No settings row for the current user';
  end if;

  return claimed;
end $$;

revoke all on function allocate_invoice_number() from public, anon;
grant execute on function allocate_invoice_number() to authenticated;
