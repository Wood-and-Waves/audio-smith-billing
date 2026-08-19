-- 0030 — business envelopes (YNAB Rule 1, scoped to the business account)
--
-- The working balance divides into named envelopes plus "Available to
-- allocate"; every allocation is an IMMUTABLE move between Available (a null
-- envelope id) and an envelope. Balances are nothing but sums over moves —
-- no mutable balance column to drift. A mistaken move is corrected by a
-- counter-move, so the history stays honest. ADDITIVE ONLY, per the 0020 rule.

create table ledger_envelopes (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  sort       int  not null default 0,
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index ledger_envelopes_owner_name_uniq
  on ledger_envelopes (owner_id, name);

create table ledger_envelope_moves (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  -- null = the Available pool.
  from_envelope_id uuid references ledger_envelopes(id) on delete restrict,
  to_envelope_id   uuid references ledger_envelopes(id) on delete restrict,
  amount_cents     bigint not null check (amount_cents > 0),
  moved_on         date not null,
  note             text,
  created_at       timestamptz not null default now(),

  -- Available -> Available would be a no-op pretending to be a move.
  constraint lem_somewhere check (from_envelope_id is not null or to_envelope_id is not null),
  constraint lem_direction check (from_envelope_id is distinct from to_envelope_id)
);

create index lem_owner_created_idx
  on ledger_envelope_moves (owner_id, created_at desc, id desc);

do $$
declare t text;
begin
  foreach t in array array['ledger_envelopes','ledger_envelope_moves']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t || '_owner_all', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
