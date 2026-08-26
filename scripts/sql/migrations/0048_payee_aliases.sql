-- 0048 — payee aliases: Chase's descriptor -> the name Dan uses
--
-- He has 18 rows categorized under `Starbucks`. Chase sends
-- `STARBUCKS 8007827282 800-782-728`. lib/payeeMemory.ts keys on the exact
-- payee string, so his memory never matched an import and every statement
-- arrived uncategorized. This table is what closes that gap: one confirmed
-- alias per merchant, applied at import BEFORE the memory lookup, so the
-- category memory he has been building for months finally fires.
--
-- raw_payee is stored ALREADY NORMALIZED (lib/payeeMemory.ts's
-- normalizePayee: trimmed, whitespace-collapsed, lowercased) so a lookup can
-- never miss on spacing or case. ADDITIVE ONLY, per the 0020 rule.

create table ledger_payee_aliases (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  raw_payee    text not null check (length(btrim(raw_payee)) > 0),
  display_name text not null check (length(btrim(display_name)) > 0),
  created_at   timestamptz not null default now(),

  constraint ledger_payee_aliases_uniq unique (owner_id, raw_payee)
);

comment on table ledger_payee_aliases is
  'One confirmed rename per bank descriptor. raw_payee is normalized on the '
  'way in (normalizePayee) so lookups cannot miss on case or spacing; '
  'display_name is what Dan typed. Applied by the OFX importer to NEW rows '
  'before payee memory runs, so an aliased payee inherits the category his '
  'existing rows already teach.';

create index ledger_payee_aliases_owner_idx on ledger_payee_aliases (owner_id);

alter table ledger_payee_aliases enable row level security;
create policy ledger_payee_aliases_owner_all on public.ledger_payee_aliases
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.ledger_payee_aliases from anon;
grant select, insert, update, delete on public.ledger_payee_aliases to authenticated;
grant all on public.ledger_payee_aliases to service_role;
