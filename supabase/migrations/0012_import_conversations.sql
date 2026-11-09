-- ============================================================================
-- NeuraFlix Labeler: browser conversation import (Phase L8b)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again (CREATE OR REPLACE / guarded grants).
--   4. Nothing in this repo runs it for you.
--
-- What this file changes
--   - import_conversation_hash: the same normalized string as
--     src/lib/khowar.ts conversationHashSource and the 0004 backfill.
--   - import_parse_conversation: validates one conversation row with the same
--     rules as scripts/import-conversations.ts. Invalid rows return ok = false
--     instead of raising.
--   - admin_import_create_source: accepts the conversation kind.
--   - admin_import_text_chunk: picks the parser and the target table from the
--     source kind, and pauses on the matching open queue. Instruction imports
--     behave exactly as they did in 0010.
--
-- Important
--   - The tables and provenance columns already exist from 0010. This file
--     only replaces functions, so re-running it cannot create or remove rows.
--   - Duplicates stay defined by the unique english_hash index.
--   - Helper functions are internal. The admin RPCs are authenticated only.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Hash helper. For each turn in order: role, a newline, content, with NFC,
--    whitespace runs collapsed to one space and both parts trimmed. Turns are
--    joined with a blank line.
-- ----------------------------------------------------------------------------
create or replace function public.import_conversation_hash(p_turns jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(
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
            from jsonb_array_elements(p_turns) with ordinality as t(turn, ord)
        ),
        'UTF8'
      )
    ),
    'hex'
  );
$$;

comment on function public.import_conversation_hash(jsonb) is
  'The same normalized string as src/lib/khowar.ts conversationHashSource and the 0004 backfill.';


-- ----------------------------------------------------------------------------
-- 2. Row parser. Two to twenty turns, an optional single system turn only at
--    the start, then user and assistant alternating, starting with user and
--    ending with assistant. At least two body turns. Content is trimmed and
--    limited to 4000 characters. Source is optional and at most 120 characters.
-- ----------------------------------------------------------------------------
create or replace function public.import_parse_conversation(
  p_raw text,
  p_file_source text
)
returns table (
  ok boolean,
  reason text,
  detail text,
  english jsonb,
  source text,
  english_hash text
)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_json jsonb;
  v_raw_turns jsonb;
  v_turn jsonb;
  v_clean jsonb := '[]'::jsonb;
  v_role text;
  v_content text;
  v_source text;
  v_count integer;
  v_system_count integer;
  v_start integer := 0;
  v_i integer;
  v_expected text;
begin
  if p_raw is null or btrim(p_raw) = '' then
    return query select false, 'empty_row'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  if octet_length(p_raw) > 524288 then
    return query select false, 'row_too_large'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  begin
    v_json := p_raw::jsonb;
  exception when others then
    return query select false, 'invalid_json'::text, left(p_raw, 300), null::jsonb, null::text, null::text;
    return;
  end;

  if v_json is null or jsonb_typeof(v_json) <> 'object' then
    return query select false, 'not_an_object'::text, left(p_raw, 300), null::jsonb, null::text, null::text;
    return;
  end if;

  -- turns wins, messages is the alias, matching `record.turns ?? record.messages`.
  if v_json -> 'turns' is not null
     and jsonb_typeof(v_json -> 'turns') <> 'null' then
    v_raw_turns := v_json -> 'turns';
  else
    v_raw_turns := v_json -> 'messages';
  end if;

  if v_raw_turns is null or jsonb_typeof(v_raw_turns) <> 'array' then
    return query select false, 'invalid_turns'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  v_count := jsonb_array_length(v_raw_turns);
  if v_count < 2 then
    return query select false, 'too_few_turns'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;
  if v_count > 20 then
    return query select false, 'too_many_turns'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  if v_json ? 'source'
     and jsonb_typeof(v_json -> 'source') <> 'null'
     and jsonb_typeof(v_json -> 'source') <> 'string' then
    return query select false, 'invalid_source'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  v_source := nullif(btrim(coalesce(v_json ->> 'source', '')), '');
  if v_source is not null and char_length(v_source) > 120 then
    return query select false, 'source_too_long'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  for v_i in 0 .. v_count - 1 loop
    v_turn := v_raw_turns -> v_i;

    if v_turn is null or jsonb_typeof(v_turn) <> 'object' then
      return query select false, 'invalid_turn'::text, null::text, null::jsonb, null::text, null::text;
      return;
    end if;

    v_role := v_turn ->> 'role';
    if v_role is null or v_role not in ('system', 'user', 'assistant') then
      return query select false, 'invalid_role'::text, null::text, null::jsonb, null::text, null::text;
      return;
    end if;

    if v_turn ? 'content' and jsonb_typeof(v_turn -> 'content') <> 'string' then
      return query select false, 'invalid_content'::text, null::text, null::jsonb, null::text, null::text;
      return;
    end if;

    v_content := btrim(
      regexp_replace(
        regexp_replace(coalesce(v_turn ->> 'content', ''), '^[[:space:]]+', '', 'g'),
        '[[:space:]]+$',
        '',
        'g'
      )
    );
    if v_content = '' then
      return query select false, 'missing_content'::text, null::text, null::jsonb, null::text, null::text;
      return;
    end if;
    if char_length(v_content) > 4000 then
      return query select false, 'content_too_long'::text, null::text, null::jsonb, null::text, null::text;
      return;
    end if;

    v_clean := v_clean || jsonb_build_array(
      jsonb_build_object('role', v_role, 'content', v_content)
    );
  end loop;

  select count(*)::integer
    into v_system_count
  from jsonb_array_elements(v_clean) as t(turn)
  where t.turn ->> 'role' = 'system';

  if v_system_count > 1 then
    return query select false, 'multiple_system'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  if v_system_count = 1 and (v_clean -> 0 ->> 'role') <> 'system' then
    return query select false, 'system_not_first'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  v_start := v_system_count;
  if v_count - v_start < 2 then
    return query select false, 'too_few_turns'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  for v_i in v_start .. v_count - 1 loop
    v_expected := case when (v_i - v_start) % 2 = 0 then 'user' else 'assistant' end;
    if (v_clean -> v_i ->> 'role') <> v_expected then
      return query select false, 'roles_not_alternating'::text, null::text, null::jsonb, null::text, null::text;
      return;
    end if;
  end loop;

  if (v_count - v_start) % 2 <> 0 then
    return query select false, 'must_end_assistant'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  return query select
    true,
    null::text,
    null::text,
    jsonb_build_object('turns', v_clean),
    coalesce(v_source, p_file_source),
    public.import_conversation_hash(v_clean);
end;
$$;

comment on function public.import_parse_conversation(text, text) is
  'Validates one conversation row with the same rules as scripts/import-conversations.ts. Invalid rows return ok = false instead of raising.';


-- ----------------------------------------------------------------------------
-- 3. Create or resume a source. Same as 0010, with the conversation kind
--    accepted. The signature is unchanged, so existing grants stay in place.
-- ----------------------------------------------------------------------------
create or replace function public.admin_import_create_source(
  p_kind text,
  p_file_name text,
  p_file_size bigint,
  p_file_hash text,
  p_source_label text,
  p_target_count integer,
  p_chunk_size integer
)
returns table (
  source_id uuid,
  batch_id uuid,
  kind text,
  file_name text,
  file_size bigint,
  file_hash text,
  source_label text,
  target_count integer,
  chunk_size integer,
  status text,
  next_offset bigint,
  next_row bigint,
  next_chunk_index integer,
  loaded_rows integer,
  skipped_rows integer,
  invalid_rows integer,
  resumed boolean,
  last_chunk_index integer,
  last_chunk_start bigint,
  last_chunk_end bigint,
  last_chunk_hash text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.import_sources%rowtype;
  v_last_chunk_index integer;
  v_last_chunk_start bigint;
  v_last_chunk_end bigint;
  v_last_chunk_hash text;
  v_batch_id uuid;
  v_source_id uuid;
  v_chunk_size integer;
begin
  if v_uid is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;

  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  if p_kind is null or p_kind not in ('instruction', 'conversation') then
    raise exception 'IMPORT_KIND_UNSUPPORTED';
  end if;

  if btrim(coalesce(p_file_name, '')) = '' or char_length(btrim(p_file_name)) > 255 then
    raise exception 'IMPORT_INVALID_FILE_NAME';
  end if;

  if p_file_size is null or p_file_size < 1 or p_file_size > 209715200 then
    raise exception 'IMPORT_INVALID_FILE_SIZE';
  end if;

  if p_file_hash is null or p_file_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'IMPORT_INVALID_FILE_HASH';
  end if;

  if btrim(coalesce(p_source_label, '')) = '' or char_length(btrim(p_source_label)) > 120 then
    raise exception 'IMPORT_INVALID_SOURCE_LABEL';
  end if;

  if p_target_count is null or p_target_count < 1 or p_target_count > 5 then
    raise exception 'IMPORT_INVALID_TARGET_COUNT';
  end if;

  if p_chunk_size is null or p_chunk_size < 20 or p_chunk_size > 1000 then
    raise exception 'IMPORT_INVALID_CHUNK_SIZE';
  end if;

  -- Serialize source creation so the same file cannot make two sources.
  perform pg_advisory_xact_lock(hashtext('admin_import_create_source'));

  select *
    into v_existing
  from public.import_sources s
  where s.kind = p_kind
    and s.file_hash = p_file_hash;

  if found then
    select c.chunk_index, c.start_offset, c.end_offset, c.content_hash
      into v_last_chunk_index, v_last_chunk_start, v_last_chunk_end, v_last_chunk_hash
    from public.import_source_chunks c
    where c.import_source_id = v_existing.id
    order by c.chunk_index desc
    limit 1;

    v_chunk_size := coalesce(
      (select b.chunk_size from public.import_batches b where b.id = v_existing.batch_id),
      p_chunk_size
    );

    return query select
      v_existing.id,
      v_existing.batch_id,
      v_existing.kind,
      v_existing.file_name,
      v_existing.file_size,
      v_existing.file_hash,
      v_existing.source_label,
      v_existing.target_count,
      v_chunk_size,
      v_existing.status,
      v_existing.next_offset,
      v_existing.next_row,
      v_existing.next_chunk_index,
      v_existing.loaded_rows,
      v_existing.skipped_rows,
      v_existing.invalid_rows,
      (v_existing.status in ('active', 'paused') and v_existing.next_offset > 0) as resumed,
      v_last_chunk_index,
      v_last_chunk_start,
      v_last_chunk_end,
      v_last_chunk_hash;
    return;
  end if;

  insert into public.import_batches (kind, label, chunk_size, total_files, created_by)
  values (p_kind, btrim(p_source_label), p_chunk_size, 1, v_uid)
  returning id into v_batch_id;

  insert into public.import_sources (
    batch_id,
    kind,
    file_name,
    file_size,
    file_hash,
    source_label,
    target_count,
    created_by
  ) values (
    v_batch_id,
    p_kind,
    btrim(p_file_name),
    p_file_size,
    p_file_hash,
    btrim(p_source_label),
    p_target_count,
    v_uid
  )
  returning id into v_source_id;

  return query select
    v_source_id,
    v_batch_id,
    p_kind,
    btrim(p_file_name),
    p_file_size,
    p_file_hash,
    btrim(p_source_label),
    p_target_count,
    p_chunk_size,
    'active'::text,
    0::bigint,
    0::bigint,
    0,
    0,
    0,
    0,
    false,
    null::integer,
    null::bigint,
    null::bigint,
    null::text;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. Commit one text chunk. Same as 0010, with the parser, the target table
--    and the queue pause check picked from the source kind. The signature is
--    unchanged, so existing grants stay in place.
-- ----------------------------------------------------------------------------
create or replace function public.admin_import_text_chunk(
  p_source_id uuid,
  p_chunk_index integer,
  p_start_offset bigint,
  p_end_offset bigint,
  p_content_hash text,
  p_rows jsonb
)
returns table (
  loaded_rows integer,
  skipped_rows integer,
  invalid_rows integer,
  next_offset bigint,
  next_row bigint,
  status text,
  already_committed boolean,
  errors jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_source public.import_sources%rowtype;
  v_chunk public.import_source_chunks%rowtype;
  v_state record;
  v_row jsonb;
  v_ord bigint;
  v_row_index bigint;
  v_raw text;
  v_parsed record;
  v_loaded integer := 0;
  v_skipped integer := 0;
  v_invalid integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_count integer;
  v_raw_bytes bigint;
  v_item_id uuid;
  v_next_offset bigint;
  v_next_row bigint;
  v_status text;
  v_reason text;
  v_detail text;
begin
  if v_uid is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;

  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  if p_source_id is null then
    raise exception 'IMPORT_SOURCE_NOT_FOUND';
  end if;

  if p_chunk_index is null or p_chunk_index < 0 then
    raise exception 'IMPORT_INVALID_CHUNK';
  end if;

  if p_start_offset is null or p_start_offset < 0 then
    raise exception 'IMPORT_INVALID_OFFSET';
  end if;

  if p_end_offset is null or p_end_offset < 0 then
    raise exception 'IMPORT_INVALID_OFFSET';
  end if;

  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'IMPORT_INVALID_CHUNK_HASH';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'IMPORT_INVALID_ROWS';
  end if;

  -- One text chunk commits at a time, so the queue threshold cannot be raced.
  perform pg_advisory_xact_lock(hashtext('admin_import_text_chunk'));

  select *
    into v_source
  from public.import_sources s
  where s.id = p_source_id
  for update;

  if not found then
    raise exception 'IMPORT_SOURCE_NOT_FOUND';
  end if;

  if v_source.kind not in ('instruction', 'conversation') then
    raise exception 'IMPORT_KIND_UNSUPPORTED';
  end if;

  -- A retry of an already committed chunk returns the stored result.
  select *
    into v_chunk
  from public.import_source_chunks c
  where c.import_source_id = p_source_id
    and c.chunk_index = p_chunk_index;

  if found then
    if v_chunk.content_hash <> p_content_hash then
      raise exception 'IMPORT_CHUNK_CONFLICT';
    end if;

    return query select
      v_chunk.loaded_rows,
      v_chunk.skipped_rows,
      v_chunk.invalid_rows,
      v_source.next_offset,
      v_source.next_row,
      v_source.status,
      true,
      coalesce(
        (
          select jsonb_agg(
                   jsonb_build_object(
                     'row_index', e.row_index,
                     'reason', e.reason,
                     'detail', e.detail
                   )
                   order by e.row_index
                 )
          from (
            select x.row_index, x.reason, x.detail
            from public.import_source_errors x
            where x.import_source_id = p_source_id
              and x.row_index between v_chunk.start_row and v_chunk.end_row
            order by x.row_index
            limit 20
          ) e
        ),
        '[]'::jsonb
      );
    return;
  end if;

  if v_source.status = 'paused' then
    raise exception 'IMPORT_PAUSED';
  end if;

  if v_source.status = 'completed' then
    raise exception 'IMPORT_COMPLETED';
  end if;

  if v_source.status <> 'active' then
    raise exception 'IMPORT_SOURCE_CLOSED';
  end if;

  if p_chunk_index <> v_source.next_chunk_index then
    raise exception 'IMPORT_CHUNK_OUT_OF_ORDER';
  end if;

  if p_start_offset <> v_source.next_offset then
    raise exception 'IMPORT_OFFSET_MISMATCH';
  end if;

  if p_end_offset <= p_start_offset or p_end_offset > v_source.file_size then
    raise exception 'IMPORT_INVALID_OFFSET';
  end if;

  if p_end_offset - p_start_offset > 1048576 then
    raise exception 'IMPORT_CHUNK_TOO_LARGE';
  end if;

  select count(*)::integer,
         coalesce(sum(octet_length(e.value ->> 'raw')), 0)::bigint
    into v_count, v_raw_bytes
  from jsonb_array_elements(p_rows) e;

  -- An empty final chunk is allowed when it only advances over trailing blank
  -- bytes to the end of the file.
  if v_count = 0 and p_end_offset < v_source.file_size then
    raise exception 'IMPORT_EMPTY_CHUNK';
  end if;

  if v_count > 1000 then
    raise exception 'IMPORT_INVALID_ROWS';
  end if;

  if v_raw_bytes > 1048576 then
    raise exception 'IMPORT_CHUNK_TOO_LARGE';
  end if;

  if v_source.next_row + v_count > 250000 then
    raise exception 'IMPORT_ROW_LIMIT';
  end if;

  select * into v_state from public.upload_pause_state();

  if v_state.db_paused then
    raise exception 'IMPORT_PAUSE_DB';
  end if;

  if v_source.kind = 'conversation' then
    if v_state.open_conversations >= v_state.pause_conversations then
      raise exception 'IMPORT_PAUSE_QUEUE';
    end if;
  else
    if v_state.open_instructions >= v_state.pause_instructions then
      raise exception 'IMPORT_PAUSE_QUEUE';
    end if;
  end if;

  for v_row, v_ord in
    select e.value, e.ord
    from jsonb_array_elements(p_rows) with ordinality as e(value, ord)
  loop
    v_row_index := v_source.next_row + v_ord;
    v_raw := v_row ->> 'raw';
    v_reason := null;
    v_detail := null;

    if v_raw is null then
      v_reason := 'missing_raw';
    else
      if v_source.kind = 'conversation' then
        select *
          into v_parsed
        from public.import_parse_conversation(
          v_raw,
          coalesce(v_source.source_label, v_source.file_name)
        );
      else
        select *
          into v_parsed
        from public.import_parse_instruction(
          v_raw,
          coalesce(v_source.source_label, v_source.file_name),
          v_source.target_count
        );
      end if;

      if not v_parsed.ok then
        v_reason := v_parsed.reason;
        v_detail := v_parsed.detail;
      end if;
    end if;

    if v_reason is not null then
      v_invalid := v_invalid + 1;

      insert into public.import_source_errors (import_source_id, row_index, reason, detail)
      values (p_source_id, v_row_index, left(v_reason, 120), left(v_detail, 300))
      on conflict (import_source_id, row_index) do nothing;

      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(
          jsonb_build_object(
            'row_index', v_row_index,
            'reason', v_reason,
            'detail', left(v_detail, 300)
          )
        );
      end if;

      continue;
    end if;

    v_item_id := null;

    begin
      if v_source.kind = 'conversation' then
        insert into public.conversation_items (
          english,
          source,
          status,
          target_count,
          english_hash,
          import_source_id,
          source_row_index
        ) values (
          v_parsed.english,
          v_parsed.source,
          'open',
          v_source.target_count,
          v_parsed.english_hash,
          p_source_id,
          v_row_index
        )
        on conflict (english_hash) do nothing
        returning id into v_item_id;
      else
        insert into public.instruction_items (
          english,
          source,
          status,
          target_count,
          english_hash,
          import_source_id,
          source_row_index
        ) values (
          v_parsed.english,
          v_parsed.source,
          'open',
          v_source.target_count,
          v_parsed.english_hash,
          p_source_id,
          v_row_index
        )
        on conflict (english_hash) do nothing
        returning id into v_item_id;
      end if;

      if v_item_id is null then
        v_skipped := v_skipped + 1;

        insert into public.import_source_errors (import_source_id, row_index, reason, detail)
        values (p_source_id, v_row_index, 'duplicate_hash', null)
        on conflict (import_source_id, row_index) do nothing;

        if jsonb_array_length(v_errors) < 20 then
          v_errors := v_errors || jsonb_build_array(
            jsonb_build_object(
              'row_index', v_row_index,
              'reason', 'duplicate_hash',
              'detail', null
            )
          );
        end if;
      else
        v_loaded := v_loaded + 1;
      end if;
    exception when others then
      v_invalid := v_invalid + 1;

      insert into public.import_source_errors (import_source_id, row_index, reason, detail)
      values (p_source_id, v_row_index, 'insert_failed', left(sqlerrm, 300))
      on conflict (import_source_id, row_index) do nothing;

      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(
          jsonb_build_object(
            'row_index', v_row_index,
            'reason', 'insert_failed',
            'detail', left(sqlerrm, 300)
          )
        );
      end if;
    end;
  end loop;

  insert into public.import_source_chunks (
    import_source_id,
    chunk_index,
    start_offset,
    end_offset,
    start_row,
    end_row,
    content_hash,
    loaded_rows,
    skipped_rows,
    invalid_rows
  ) values (
    p_source_id,
    p_chunk_index,
    p_start_offset,
    p_end_offset,
    v_source.next_row + 1,
    v_source.next_row + v_count,
    p_content_hash,
    v_loaded,
    v_skipped,
    v_invalid
  );

  v_next_offset := p_end_offset;
  v_next_row := v_source.next_row + v_count;
  v_status := case
    when p_end_offset >= v_source.file_size then 'completed'
    else 'active'
  end;

  update public.import_sources s
     set next_offset = v_next_offset,
         next_row = v_next_row,
         next_chunk_index = p_chunk_index + 1,
         loaded_rows = s.loaded_rows + v_loaded,
         skipped_rows = s.skipped_rows + v_skipped,
         invalid_rows = s.invalid_rows + v_invalid,
         status = v_status,
         completed_at = case
           when v_status = 'completed' then now()
           else s.completed_at
         end,
         updated_at = now()
   where s.id = p_source_id;

  if v_status = 'completed' then
    update public.import_batches b
       set processed_files = 1,
           status = 'completed',
           updated_at = now()
     where b.id = v_source.batch_id;
  end if;

  return query select
    v_loaded,
    v_skipped,
    v_invalid,
    v_next_offset,
    v_next_row,
    v_status,
    false,
    v_errors;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Grants. The two helpers are internal. The replaced RPCs keep their
--    authenticated-only execute grant from 0010.
-- ----------------------------------------------------------------------------
revoke all on function public.import_conversation_hash(jsonb) from public, anon, authenticated;
revoke all on function public.import_parse_conversation(text, text) from public, anon, authenticated;

revoke all on function public.admin_import_create_source(text, text, bigint, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_import_text_chunk(uuid, integer, bigint, bigint, text, jsonb) from public, anon, authenticated;

grant execute on function public.admin_import_create_source(text, text, bigint, text, text, integer, integer) to authenticated;
grant execute on function public.admin_import_text_chunk(uuid, integer, bigint, bigint, text, jsonb) to authenticated;
