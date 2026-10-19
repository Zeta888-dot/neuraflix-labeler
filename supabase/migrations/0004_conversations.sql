-- ============================================================================
-- NeuraFlix Labeler: conversations module (Phase L2)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again (IF NOT EXISTS / CREATE OR REPLACE / guarded).
--   4. Nothing in this repo runs it for you.
--
-- What this file changes
--   - conversation_items.english_hash: sha256 (hex) of the normalized joined
--     turns, unique. Rows that predate the column are backfilled below. The
--     string that is hashed is, for each turn in order:
--       nfc(role) <newline> nfc(content)
--     with whitespace runs collapsed to one space and both parts trimmed, and
--     the turns joined with a blank line. The import script uses the same string
--     (src/lib/khowar.ts conversationHashSource).
--   - submit_conversation_translation(p_item_id, p_turns): one transaction that
--     rechecks the claim, checks the turns against the English item, inserts the
--     translation as submitted, deletes the claim and marks the item complete
--     once submitted plus approved translations reach target_count. It returns
--     the new row id and raises CLAIM_EXPIRED / ALREADY_SUBMITTED / INVALID_TURNS
--     so the app can reload or explain instead of losing typed text.
--   - Grants: the new function is executable by authenticated only, and the
--     internal refresh helpers keep their revoked default.
--
-- Checked, no change needed
--   claim_next as re-created in 0003 already covers conversation items: it
--   filters c.kind = p_kind, returns out_item_id with the item's english jsonb
--   (the turns payload), skips items the caller already translated, skips items
--   another contributor holds unexpired, and renews the caller's own claim
--   through the ON CONFLICT upsert on (kind, item_id, contributor_id).
--   release_claim(p_item_id) in 0003 deletes the caller's own claim for that
--   item without a kind filter, so one function releases instruction and
--   conversation claims alike.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. conversation_items.english_hash
-- ----------------------------------------------------------------------------
alter table public.conversation_items
  add column if not exists english_hash text;

comment on column public.conversation_items.english_hash is
  'sha256 hex of the turns joined with a blank line, each turn written as role || E''\n'' || content with whitespace runs collapsed and trimmed. Written by scripts/import-conversations.ts.';

-- Backfill rows that predate the column. Guarded: a missing normalize() or an
-- unexpected payload must not abort the migration. The script fills new rows.
do $$
begin
  update public.conversation_items ci
     set english_hash = encode(
           sha256(
             convert_to(
               (
                 select string_agg(
                          btrim(regexp_replace(normalize(coalesce(t.turn ->> 'role', ''), NFC), '[[:space:]]+', ' ', 'g'))
                          || E'\n' ||
                          btrim(regexp_replace(normalize(coalesce(t.turn ->> 'content', ''), NFC), '[[:space:]]+', ' ', 'g')),
                          E'\n\n'
                          order by t.ord
                        )
                   from jsonb_array_elements(ci.english -> 'turns') with ordinality as t(turn, ord)
               ),
               'UTF8'
             )
           ),
           'hex'
         )
   where ci.english_hash is null
     and jsonb_typeof(ci.english -> 'turns') = 'array';
exception when others then
  raise notice 'english_hash backfill skipped: %. New rows still get a hash from the import script.', sqlerrm;
end;
$$;

create unique index if not exists conversation_items_english_hash_key
  on public.conversation_items (english_hash);


-- ----------------------------------------------------------------------------
-- 2. submit_conversation_translation(p_item_id, p_turns): insert, release,
--    complete. Allowed when the caller holds an unexpired claim on the item, or
--    when the claim expired but the item is still open and the caller has not
--    translated it yet. p_turns must be a JSON array with the same turns as the
--    English item: same count, same roles in the same order, every content
--    non-empty and at most 4000 characters. The stored turns are rebuilt from
--    role and content, so nothing else the client sends is kept.
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
    -- No live claim. The claim may have expired while the contributor typed;
    -- that is fine while the item is still open and untouched by this user.
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
-- 3. Grants: authenticated only. Functions get PUBLIC execute by default.
-- ----------------------------------------------------------------------------
revoke all on function public.submit_conversation_translation(uuid, jsonb) from public, anon;

grant execute on function public.submit_conversation_translation(uuid, jsonb) to authenticated;
