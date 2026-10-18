-- ============================================================================
-- NeuraFlix Labeler: instructions module (Phase L1)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again (IF NOT EXISTS / CREATE OR REPLACE / guarded).
--   4. Nothing in this repo runs it for you.
--
-- What this file changes
--   - instruction_items.english_hash: sha256 (hex) of the normalized English
--     instruction plus the normalized optional input, unique. Conservative
--     rows are backfilled below. The string that is hashed is:
--       nfc(instruction) <newline> nfc(input or "")
--     with whitespace runs collapsed to one space and both parts trimmed. The
--     import script uses the same string (src/lib/khowar.ts englishHashSource).
--   - claims: unique index on (kind, item_id, contributor_id) so one
--     contributor can never hold two claims for the same item.
--   - claim_next(kind) rewritten. Bug in 0001: it inserted a new claim row on
--     every call, so a page reload left the contributor holding several claims
--     for one item. That inflated the active claim count (which the
--     target_count comparison reads) and could push an item past target_count.
--     claim_next now renews the caller's own unexpired claim instead of
--     inserting a duplicate, and skips items another contributor is holding.
--   - release_claim(item_id): release the caller's own claim (the Skip action).
--   - submit_instruction_translation(...): one transaction that rechecks the
--     claim, inserts the translation as submitted, deletes the claim and marks
--     the item complete once submitted plus approved translations reach
--     target_count. Returns the new translation id.
--   - Grants: the three functions are executable by authenticated only. The
--     internal refresh helpers lose their default PUBLIC execute.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. instruction_items.english_hash
-- ----------------------------------------------------------------------------
alter table public.instruction_items
  add column if not exists english_hash text;

comment on column public.instruction_items.english_hash is
  'sha256 hex of nfc(instruction) || E''\n'' || nfc(coalesce(input, '''')), whitespace runs collapsed and trimmed. Written by scripts/import-english.ts.';

-- Backfill rows that predate the column. Guarded: a missing normalize() or an
-- unexpected payload must not abort the migration. The script fills new rows.
do $$
begin
  update public.instruction_items
     set english_hash = encode(
           sha256(
             convert_to(
               btrim(regexp_replace(normalize(coalesce(english ->> 'instruction', ''), NFC), '[[:space:]]+', ' ', 'g'))
               || E'\n' ||
               btrim(regexp_replace(normalize(coalesce(english ->> 'input', ''), NFC), '[[:space:]]+', ' ', 'g')),
               'UTF8'
             )
           ),
           'hex'
         )
   where english_hash is null;
exception when others then
  raise notice 'english_hash backfill skipped: %. New rows still get a hash from the import script.', sqlerrm;
end;
$$;

create unique index if not exists instruction_items_english_hash_key
  on public.instruction_items (english_hash);


-- ----------------------------------------------------------------------------
-- 2. claims: one claim per contributor per item
-- ----------------------------------------------------------------------------
-- First collapse anything 0001 left behind, keeping the newest expiry.
with ranked as (
  select id,
         row_number() over (
           partition by kind, item_id, contributor_id
           order by expires_at desc, id
         ) as rn
  from public.claims
)
delete from public.claims c
using ranked r
where c.id = r.id
  and r.rn > 1;

create unique index if not exists claims_kind_item_contributor_key
  on public.claims (kind, item_id, contributor_id);


-- ----------------------------------------------------------------------------
-- 3. release_claim(item_id): drop the caller's own claim (Skip, Report)
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

  delete from public.claims
   where item_id = p_item_id
     and contributor_id = v_uid;
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
-- 5. claim_next(kind) without the 0001 duplicate-claim bug
-- ----------------------------------------------------------------------------
create or replace function public.claim_next(p_kind text)
returns table (
  item_id uuid,
  english jsonb,
  source text,
  target_count integer,
  claimed_until timestamptz
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
  delete from public.claims
   where contributor_id = v_uid
     and expires_at <= now();

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
-- 6. Grants: authenticated only. Functions get PUBLIC execute by default.
-- ----------------------------------------------------------------------------
revoke all on function public.claim_next(text) from public, anon;
revoke all on function public.submit_instruction_translation(uuid, text, text, text) from public, anon;
revoke all on function public.release_claim(uuid) from public, anon;
revoke all on function public.refresh_instruction_item(uuid) from public, anon;
revoke all on function public.refresh_conversation_item(uuid) from public, anon;

grant execute on function public.claim_next(text) to authenticated;
grant execute on function public.submit_instruction_translation(uuid, text, text, text) to authenticated;
grant execute on function public.release_claim(uuid) to authenticated;
