-- ============================================================================
-- NeuraFlix Labeler: hardening (Phase L7a)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again (CREATE OR REPLACE / IF NOT EXISTS / DROP
--      TRIGGER IF EXISTS).
--   4. Nothing in this repo runs it for you.
--
-- What this file changes
--   - Rolling one-hour submission limits, checked inside the database so a
--     direct RPC or PostgREST call cannot skip them:
--       instruction translations  60 per contributor per hour
--       conversation translations 30 per contributor per hour
--       plain text submissions    30 per contributor per hour
--     submit_instruction_translation and submit_conversation_translation are
--     re-created with the same behavior plus a RATE_LIMIT check at the top.
--     Plain text inserts go through an RLS policy, so a BEFORE INSERT trigger
--     enforces its limit instead of a function.
--   - Indexes for the two rate-limit counts. The text index already exists in
--     0005 as text_submissions_contributor_created_idx.
--   - health_ping(): a boolean, security definer, readable by anon and
--     authenticated, that reads nothing. /api/health calls it for the
--     keep-alive Action.
--   - Grants: the submit functions and the trigger helper stay authenticated
--     only; health_ping is the single anon exception.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Rate-limit indexes
-- ----------------------------------------------------------------------------
create index if not exists instruction_translations_rate_idx
  on public.instruction_translations (contributor_id, submitted_at desc);

create index if not exists conversation_translations_rate_idx
  on public.conversation_translations (contributor_id, submitted_at desc);


-- ----------------------------------------------------------------------------
-- 2. submit_instruction_translation: same as 0002, plus 60 per rolling hour.
--    The count runs before validation, so a contributor who is over the limit
--    is refused even if the payload is malformed. The request after the 60th
--    submission in the window is the first one refused.
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
  v_recent integer;
  v_status text;
  v_claim_expires timestamptz;
  v_already integer;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'submit_instruction_translation requires an authenticated session';
  end if;

  select count(*)::integer
    into v_recent
  from public.instruction_translations t
  where t.contributor_id = v_uid
    and t.submitted_at >= now() - interval '1 hour';

  if v_recent >= 60 then
    raise exception 'RATE_LIMIT';
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

  delete from public.claims
   where kind = 'instruction'
     and item_id = p_item_id
     and contributor_id = v_uid;

  -- Marks the item complete when submitted plus approved translations reach
  -- target_count (see refresh_instruction_item in 0001).
  perform public.refresh_instruction_item(p_item_id);

  return v_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. submit_conversation_translation: same as 0004, plus 30 per rolling hour.
--    The limit check sits above the turns validation for the same reason as
--    the instruction function.
-- ----------------------------------------------------------------------------
create or replace function public.submit_conversation_translation(
  p_item_id uuid,
  p_turns jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_recent integer;
  v_status text;
  v_english_turns jsonb;
  v_claim_expires timestamptz;
  v_already integer;
  v_expected integer;
  v_given integer;
  v_index integer;
  v_role_expected text;
  v_content text;
  v_turns_clean jsonb;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'submit_conversation_translation requires an authenticated session';
  end if;

  select count(*)::integer
    into v_recent
  from public.conversation_translations t
  where t.contributor_id = v_uid
    and t.submitted_at >= now() - interval '1 hour';

  if v_recent >= 30 then
    raise exception 'RATE_LIMIT';
  end if;

  if p_turns is null or jsonb_typeof(p_turns) <> 'array' then
    raise exception 'INVALID_TURNS: the turns payload must be a JSON array';
  end if;

  -- Lock the item row so a claim or release cannot interleave with the insert.
  select i.status, i.english -> 'turns'
    into v_status, v_english_turns
    from public.conversation_items i
   where i.id = p_item_id
     for update;

  if v_status is null then
    raise exception 'Unknown conversation item %', p_item_id;
  end if;

  if v_english_turns is null or jsonb_typeof(v_english_turns) <> 'array' then
    raise exception 'Unknown conversation item %', p_item_id;
  end if;

  select count(*)
    into v_already
    from public.conversation_translations t
   where t.item_id = p_item_id
     and t.contributor_id = v_uid;

  if v_already > 0 then
    raise exception 'ALREADY_SUBMITTED';
  end if;

  select max(c.expires_at)
    into v_claim_expires
    from public.claims c
   where c.kind = 'conversation'
     and c.item_id = p_item_id
     and c.contributor_id = v_uid;

  if v_claim_expires is null or v_claim_expires <= now() then
    if v_status <> 'open' then
      raise exception 'CLAIM_EXPIRED';
    end if;
  end if;

  v_expected := jsonb_array_length(v_english_turns);
  v_given := jsonb_array_length(p_turns);

  if v_expected = 0 then
    raise exception 'Unknown conversation item %', p_item_id;
  end if;

  if v_given <> v_expected then
    raise exception 'INVALID_TURNS: the conversation has % turns, % were sent', v_expected, v_given;
  end if;

  for v_index in 0 .. v_expected - 1 loop
    v_role_expected := v_english_turns -> v_index ->> 'role';
    if p_turns -> v_index ->> 'role' is distinct from v_role_expected then
      raise exception 'INVALID_TURNS: turn % must keep the role %',
        v_index + 1, coalesce(v_role_expected, 'unknown');
    end if;

    v_content := p_turns -> v_index ->> 'content';
    if v_content is null or btrim(v_content) = '' then
      raise exception 'INVALID_TURNS: turn % is empty', v_index + 1;
    end if;
    if char_length(v_content) > 4000 then
      raise exception 'INVALID_TURNS: turn % is longer than 4000 characters', v_index + 1;
    end if;
  end loop;

  select jsonb_agg(
           jsonb_build_object(
             'role', e.turn ->> 'role',
             'content', e.turn ->> 'content'
           )
           order by e.ord
         )
    into v_turns_clean
    from jsonb_array_elements(p_turns) with ordinality as e(turn, ord);

  insert into public.conversation_translations (
    item_id,
    contributor_id,
    turns,
    status,
    submitted_at
  )
  values (
    p_item_id,
    v_uid,
    v_turns_clean,
    'submitted',
    now()
  )
  returning id into v_id;

  delete from public.claims c
   where c.kind = 'conversation'
     and c.item_id = p_item_id
     and c.contributor_id = v_uid;

  -- Marks the item complete when submitted plus approved translations reach
  -- target_count (see refresh_conversation_item in 0001).
  perform public.refresh_conversation_item(p_item_id);

  return v_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. Plain text: 30 inserts per rolling hour. The insert policy from 0005
--    stays as it is; this BEFORE INSERT trigger adds the check the policy
--    cannot express.
--
--    A service-role or SQL-editor insert has no auth.uid(). Those already
--    bypass RLS and are admin work, so they are not rate limited. Every insert
--    that reaches the app has an authenticated caller.
-- ----------------------------------------------------------------------------
create or replace function public.text_submissions_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_recent integer;
begin
  if v_uid is null then
    return new;
  end if;

  select count(*)::integer
    into v_recent
  from public.text_submissions t
  where t.contributor_id = v_uid
    and t.created_at >= now() - interval '1 hour';

  if v_recent >= 30 then
    raise exception 'RATE_LIMIT';
  end if;

  return new;
end;
$$;

drop trigger if exists text_submissions_rate_limit on public.text_submissions;
create trigger text_submissions_rate_limit
  before insert on public.text_submissions
  for each row execute function public.text_submissions_rate_limit();


-- ----------------------------------------------------------------------------
-- 5. health_ping: the smallest possible keep-alive. It reads no table and
--    returns true. The keep-alive Action calls /api/health, which calls this
--    with the anon key; an anon grant is the one deliberate exception.
-- ----------------------------------------------------------------------------
create or replace function public.health_ping()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select true;
$$;

comment on function public.health_ping() is
  'Keep-alive probe for /api/health. Returns true and reads no data.';


-- ----------------------------------------------------------------------------
-- 6. Grants. Re-created functions keep their existing grants, but state them
--    again so a fresh database and an upgraded one end in the same place.
-- ----------------------------------------------------------------------------
revoke all on function public.submit_instruction_translation(uuid, text, text, text) from public, anon;
revoke all on function public.submit_conversation_translation(uuid, jsonb) from public, anon;
revoke all on function public.text_submissions_rate_limit() from public, anon;

grant execute on function public.submit_instruction_translation(uuid, text, text, text) to authenticated;
grant execute on function public.submit_conversation_translation(uuid, jsonb) to authenticated;
grant execute on function public.text_submissions_rate_limit() to authenticated;

revoke all on function public.health_ping() from public, anon, authenticated;
grant execute on function public.health_ping() to anon, authenticated;
