-- 0045 — replace_transaction_splits learns an optional parent patch
--
-- Dan's ask (2026-08-25, hitting it live on the 3/5 merge): "Shouldn't I be
-- able to edit all figures at one time? That is how YNAB works. The only
-- time YNAB won't let me save is when the splits don't reconcile to $0."
-- Today the register's split save writes legs ONLY — an amount typed into
-- the edit row's own Outflow/Inflow box in the same session is silently
-- ignored (the SplitEditor validated legs against the row's SAVED amount,
-- so his 2,512.60 + 400 legs read as "−$400.00 remaining" against a total
-- he had already retyped to 2,912.60), and a payee/memo edit made in the
-- same session is discarded outright.
--
-- The two 0042 triggers force the fix INSIDE this RPC rather than as a
-- second write from application code:
--   * ledger_transactions_refuse_amount_edit_with_legs (immediate) refuses
--     any amount change while legs exist — so "update the parent, then
--     replace the legs" can never run in that order from outside;
--   * ledger_transaction_splits_integrity (deferred) requires legs to sum
--     to the parent AT COMMIT — so "replace the legs, then the parent"
--     fails in the other order, since the legs' own commit still sees the
--     old total.
-- Only a single transaction that deletes the old legs, patches the parent
-- while the row is momentarily unsplit (the immediate trigger's exists()
-- sees this transaction's own delete), and inserts the new legs can land
-- the whole edit — and at commit the deferred trigger validates the FINAL
-- amount against the FINAL leg set, exactly the invariant Dan expects:
-- save refuses only when the splits don't reconcile to $0.
--
-- p_parent_patch is a jsonb OBJECT (null = no patch, the pre-0045 call
-- shape — deployed code calling with two args keeps working through the
-- default, which is what makes migrate-first-then-deploy safe). Recognized
-- keys, each applied only when PRESENT so the caller states exactly what
-- it means to change: date, payee, memo, show_id, amount_cents, kind.
-- memo/show_id are nullable — an explicit null clears them, same as
-- updateLedgerTransaction's own write. category_id is deliberately NOT a
-- patch key: this function only ever clears a split parent's category
-- (0042's rule — a split parent has no single category), never sets one.
--
-- The patch body validates nothing about kind/sign/balance itself, the
-- same division of labor 0042 states for legs: lt_kind_sign (0027) is the
-- backstop for a kind/sign mismatch, the deferred trigger for the sums,
-- and the application action (app/money/actions.ts replaceSplits) refuses
-- earlier in its own friendly voice.
--
-- A function's signature cannot gain a parameter via `create or replace`
-- (Postgres would create an overload beside the old one, and a 2-arg call
-- would then be ambiguous) — so the 2-arg function is dropped and the
-- 3-arg one created, with 0042's grants and 0043's anon revoke re-issued
-- on the new signature. Additive in the sense that matters: same name,
-- every existing call shape still valid, nothing about the schema removed.

drop function public.replace_transaction_splits(uuid, jsonb);

create function public.replace_transaction_splits(
  p_transaction_id uuid,
  p_legs jsonb,
  p_parent_patch jsonb default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id  uuid;
  v_leg_count int;
begin
  select owner_id into v_owner_id
    from ledger_transactions
   where id = p_transaction_id
     and owner_id = auth.uid();

  if v_owner_id is null then
    raise exception 'Transaction % not found, or not owned by the caller.', p_transaction_id;
  end if;

  if p_legs is not null and jsonb_typeof(p_legs) <> 'array' then
    raise exception 'p_legs must be a jsonb array.';
  end if;

  if p_parent_patch is not null and jsonb_typeof(p_parent_patch) <> 'object' then
    raise exception 'p_parent_patch must be a jsonb object.';
  end if;

  delete from ledger_transaction_splits
   where transaction_id = p_transaction_id
     and owner_id = v_owner_id;

  -- Between the delete above and the insert below the row is momentarily
  -- unsplit, which is the ONE moment 0042's immediate amount-edit trigger
  -- permits an amount change — see this migration's header for why the
  -- patch cannot live anywhere else. Presence-checked per key: an absent
  -- key means "leave it alone", a present null (memo/show_id) means
  -- "clear it".
  if p_parent_patch is not null then
    update ledger_transactions
       set date         = case when p_parent_patch ? 'date'
                               then (p_parent_patch->>'date')::date else date end,
           payee        = case when p_parent_patch ? 'payee'
                               then p_parent_patch->>'payee' else payee end,
           memo         = case when p_parent_patch ? 'memo'
                               then p_parent_patch->>'memo' else memo end,
           show_id      = case when p_parent_patch ? 'show_id'
                               then (p_parent_patch->>'show_id')::uuid else show_id end,
           amount_cents = case when p_parent_patch ? 'amount_cents'
                               then (p_parent_patch->>'amount_cents')::bigint else amount_cents end,
           kind         = case when p_parent_patch ? 'kind'
                               then p_parent_patch->>'kind' else kind end
     where id = p_transaction_id;
  end if;

  insert into ledger_transaction_splits
    (owner_id, transaction_id, category_id, amount_cents, kind, note)
  select
    v_owner_id,
    p_transaction_id,
    (leg->>'category_id')::uuid,
    (leg->>'amount_cents')::bigint,
    leg->>'kind',
    leg->>'note'
  from jsonb_array_elements(coalesce(p_legs, '[]'::jsonb)) as leg;

  get diagnostics v_leg_count = row_count;

  -- Only clears category_id when legs now exist; an unsplit (v_leg_count
  -- = 0) matches zero rows here and leaves category_id untouched.
  update ledger_transactions
     set category_id = null
   where id = p_transaction_id
     and v_leg_count > 0;
end $$;

-- 0042's grant discipline plus 0043's lesson, on the new signature in one
-- go: revoke from public AND anon explicitly (create function grants
-- EXECUTE to PUBLIC by default, and Supabase's default privileges hand
-- anon its own grant on top — 0002's one-statement revoke shape).
revoke all on function public.replace_transaction_splits(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.replace_transaction_splits(uuid, jsonb, jsonb) to authenticated;
