-- ============================================================================
-- NeuraFlix Labeler: ambiguous PL/pgSQL names in the claim RPCs (Phase L1 fix)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again: the claim_next drop is guarded and the other
--      functions use CREATE OR REPLACE.
--   4. Nothing in this repo runs it for you.
--
-- Why
--   Postgres was raising:
--     column reference "item_id" is ambiguous. It could refer to either a
--     PL/pgSQL variable or a table column. (SQLSTATE 42702)
--   Every name in a RETURNS TABLE (...) clause is a PL/pgSQL variable inside the
--   function body, so claim_next's output columns (item_id, english, source,
--   target_count) collided with the columns of the tables the body reads. The
--   same collision is possible for any variable or parameter whose name matches
--   a column that a statement references, and PL/pgSQL only reports it when the
--   statement first runs, which is why the error appeared at claim time.
--
-- What this file changes
--   1. claims_kind_item_contributor_key: created by 0002, re-asserted here with
--      IF NOT EXISTS because claim_next's renewal path depends on it (the
--      ON CONFLICT clause that renews the caller's own claim).
--   2. claim_next(text): output columns renamed to out_item_id, out_english,
--      out_source, out_target_count and out_claimed_until, so no output name can
--      shadow a column again, and every column reference is qualified with its
--      table alias. Behaviour is unchanged from 0002: renew the caller's own
--      unexpired claim, skip items the caller already translated, skip items
--      another contributor is holding unexpired, expire claims after 30 minutes.
--   3. release_claim(uuid) and submit_instruction_translation(uuid, text, text,
--      text): same signatures and same behaviour, every column reference
--      qualified with its table alias.
--   4. Grants: the three functions stay executable by authenticated only.
--
-- The other plpgsql functions from 0001 (handle_new_user, guard_profile_role,
-- refresh_instruction_item, refresh_conversation_item and the two translation
-- trigger functions) were checked: none of their parameters or variables share a
-- name with a column they reference, so they are left untouched.
--
-- Client note: PostgREST returns the renamed output columns, so the TypeScript
-- callers read out_item_id, out_english, out_source, out_target_count and
-- out_claimed_until.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. claims: one claim per contributor per item
-- ----------------------------------------------------------------------------
create unique index if not exists claims_kind_item_contributor_key
  on public.claims (kind, item_id, contributor_id);


-- ----------------------------------------------------------------------------
-- 2. claim_next(kind): hand the caller one open item they have not done yet.
--    FOR UPDATE SKIP LOCKED keeps two contributors off the same row; the claim
--    expires after 30 minutes. SECURITY DEFINER, so it can read the item tables
--    that contributors cannot select directly.
--    The output columns are out_* so they cannot shadow item columns.
-- ----------------------------------------------------------------------------
drop function if exists public.claim_next(text);

create function public.claim_next(p_kind text)
returns table (
  out_item_id uuid,
  out_english jsonb,
  out_source text,
  out_target_count integer,
  out_claimed_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_expires timestamptz := now() + interval '30 minutes';
  v_item_id uuid;
begin
  if v_uid is null then
    raise exception 'claim_next requires an authenticated session';
  end if;

  if p_kind not in ('instruction', 'conversation') then
    raise exception 'claim_next: unknown kind %', p_kind;
  end if;

  -- Expired claims reserve nothing, including for their own holder.
  delete from public.claims c
   where c.contributor_id = v_uid
     and c.expires_at <= now();

  if p_kind = 'instruction' then
    -- 1. Renew the caller's own unexpired claim instead of inserting a second
    --    row for the same item.
    select c.item_id
      into v_item_id
      from public.claims c
      join public.instruction_items i on i.id = c.item_id
     where c.kind = p_kind
       and c.contributor_id = v_uid
       and c.expires_at > now()
       and i.status = 'open'
       and not exists (
         select 1
           from public.instruction_translations t
          where t.item_id = i.id
            and t.contributor_id = v_uid
       )
     order by c.expires_at desc
     limit 1;

    if v_item_id is not null then
      insert into public.claims (kind, item_id, contributor_id, expires_at)
      values (p_kind, v_item_id, v_uid, v_expires)
      on conflict (kind, item_id, contributor_id)
        do update set expires_at = excluded.expires_at;

      return query
        select i.id, i.english, i.source, i.target_count, v_expires
          from public.instruction_items i
         where i.id = v_item_id;
      return;
    end if;

    -- 2. Drop claims of this caller that no longer qualify, so they cannot
    --    block the pick below.
    delete from public.claims c
     where c.kind = p_kind
       and c.contributor_id = v_uid
       and (
         not exists (
           select 1
             from public.instruction_items i
            where i.id = c.item_id
              and i.status = 'open'
         )
         or exists (
           select 1
             from public.instruction_translations t
            where t.item_id = c.item_id
              and t.contributor_id = v_uid
         )
       );

    -- 3. Oldest open item this user has not translated and nobody else holds.
    select i.id
      into v_item_id
      from public.instruction_items i
     where i.status = 'open'
       and not exists (
         select 1
           from public.instruction_translations t
          where t.item_id = i.id
            and t.contributor_id = v_uid
       )
       and not exists (
         select 1
           from public.claims c
          where c.kind = p_kind
            and c.item_id = i.id
            and c.contributor_id <> v_uid
            and c.expires_at > now()
       )
     order by i.created_at, i.id
     for update skip locked
     limit 1;

    if v_item_id is null then
      return;
    end if;

    insert into public.claims (kind, item_id, contributor_id, expires_at)
    values (p_kind, v_item_id, v_uid, v_expires)
    on conflict (kind, item_id, contributor_id)
      do update set expires_at = excluded.expires_at;

    return query
      select i.id, i.english, i.source, i.target_count, v_expires
        from public.instruction_items i
       where i.id = v_item_id;
  else
    -- Conversation items mirror the instruction logic. Phase L2 uses this.
    select c.item_id
      into v_item_id
      from public.claims c
      join public.conversation_items i on i.id = c.item_id
     where c.kind = p_kind
       and c.contributor_id = v_uid
       and c.expires_at > now()
       and i.status = 'open'
       and not exists (
         select 1
           from public.conversation_translations t
          where t.item_id = i.id
            and t.contributor_id = v_uid
       )
     order by c.expires_at desc
     limit 1;

    if v_item_id is not null then
      insert into public.claims (kind, item_id, contributor_id, expires_at)
      values (p_kind, v_item_id, v_uid, v_expires)
      on conflict (kind, item_id, contributor_id)
        do update set expires_at = excluded.expires_at;

      return query
        select i.id, i.english, i.source, i.target_count, v_expires
          from public.conversation_items i
         where i.id = v_item_id;
      return;
    end if;

    delete from public.claims c
     where c.kind = p_kind
       and c.contributor_id = v_uid
       and (
         not exists (
           select 1
             from public.conversation_items i
            where i.id = c.item_id
              and i.status = 'open'
         )
         or exists (
           select 1
             from public.conversation_translations t
            where t.item_id = c.item_id
              and t.contributor_id = v_uid
         )
       );

    select i.id
      into v_item_id
      from public.conversation_items i
     where i.status = 'open'
       and not exists (
         select 1
           from public.conversation_translations t
          where t.item_id = i.id
            and t.contributor_id = v_uid
       )
       and not exists (
         select 1
           from public.claims c
          where c.kind = p_kind
            and c.item_id = i.id
            and c.contributor_id <> v_uid
            and c.expires_at > now()
       )
     order by i.created_at, i.id
     for update skip locked
     limit 1;

    if v_item_id is null then
      return;
    end if;

    insert into public.claims (kind, item_id, contributor_id, expires_at)
    values (p_kind, v_item_id, v_uid, v_expires)
    on conflict (kind, item_id, contributor_id)
      do update set expires_at = excluded.expires_at;

    return query
      select i.id, i.english, i.source, i.target_count, v_expires
        from public.conversation_items i
       where i.id = v_item_id;
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. release_claim(p_item_id): drop the caller's own claim (Skip, Report)
-- ----------------------------------------------------------------------------
create or replace function public.release_claim(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'release_claim requires an authenticated session';
  end if;

  delete from public.claims c
   where c.item_id = p_item_id
     and c.contributor_id = v_uid;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. submit_instruction_translation(...): insert, release, complete
--    Allowed when the caller holds an unexpired claim on the item, or when the
--    claim expired but the item is still open and the caller has not
--    translated it yet. Raises CLAIM_EXPIRED / ALREADY_SUBMITTED otherwise so
--    the app can reload instead of losing typed text.
-- ----------------------------------------------------------------------------
create or replace function public.submit_instruction_translation(
  p_item_id uuid,
  p_khowar_instruction text,
  p_khowar_input text,
  p_khowar_response text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_claim_expires timestamptz;
  v_already integer;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'submit_instruction_translation requires an authenticated session';
  end if;

  if btrim(coalesce(p_khowar_instruction, '')) = '' then
    raise exception 'The Khowar instruction is empty';
  end if;

  if btrim(coalesce(p_khowar_response, '')) = '' then
    raise exception 'The Khowar response is empty';
  end if;

  -- Lock the item row so a claim or release cannot interleave with the insert.
  select i.status
    into v_status
    from public.instruction_items i
   where i.id = p_item_id
     for update;

  if v_status is null then
    raise exception 'Unknown instruction item %', p_item_id;
  end if;

  select count(*)
    into v_already
    from public.instruction_translations t
   where t.item_id = p_item_id
     and t.contributor_id = v_uid;

  if v_already > 0 then
    raise exception 'ALREADY_SUBMITTED';
  end if;

  select max(c.expires_at)
    into v_claim_expires
    from public.claims c
   where c.kind = 'instruction'
     and c.item_id = p_item_id
     and c.contributor_id = v_uid;

  if v_claim_expires is null or v_claim_expires <= now() then
    -- No live claim. The claim may have expired while the contributor typed;
    -- that is fine while the item is still open and untouched by this user.
    if v_status <> 'open' then
      raise exception 'CLAIM_EXPIRED';
    end if;
  end if;

  insert into public.instruction_translations (
    item_id,
    contributor_id,
    khowar_instruction,
    khowar_input,
    khowar_response,
    status,
    submitted_at
  )
  values (
    p_item_id,
    v_uid,
    p_khowar_instruction,
    nullif(p_khowar_input, ''),
    p_khowar_response,
    'submitted',
    now()
  )
  returning id into v_id;

  delete from public.claims c
   where c.kind = 'instruction'
     and c.item_id = p_item_id
     and c.contributor_id = v_uid;

  -- Marks the item complete when submitted plus approved translations reach
  -- target_count (see refresh_instruction_item in 0001).
  perform public.refresh_instruction_item(p_item_id);

  return v_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Grants: authenticated only. Dropping claim_next dropped its grants too,
--    and functions get PUBLIC execute by default.
-- ----------------------------------------------------------------------------
revoke all on function public.claim_next(text) from public, anon;
revoke all on function public.submit_instruction_translation(uuid, text, text, text) from public, anon;
revoke all on function public.release_claim(uuid) from public, anon;

grant execute on function public.claim_next(text) to authenticated;
grant execute on function public.submit_instruction_translation(uuid, text, text, text) to authenticated;
grant execute on function public.release_claim(uuid) to authenticated;
