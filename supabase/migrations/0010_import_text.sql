-- ============================================================================
-- NeuraFlix Labeler: browser text import foundation (Phase L8a)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again (IF NOT EXISTS / CREATE OR REPLACE / guarded
--      drops and inserts).
--   4. Nothing in this repo runs it for you.
--
-- What this file changes
--   - import_batches, import_sources, import_source_chunks and
--     import_source_errors. The browser reads a file in byte slices and
--     commits one slice at a time. A chunk is idempotent by chunk index and
--     SHA-256 content hash.
--   - instruction_items and conversation_items gain import_source_id and
--     source_row_index provenance. The existing english_hash unique indexes
--     stay the only duplicate rule.
--   - Admin-only security definer RPCs for creating a source, committing a
--     text chunk, pausing or resuming, listing sources, reading row errors and
--     reading the upload status.
--   - Settings for chunk sizes, pause thresholds and the database quota.
--
-- Important
--   - The RPCs are instruction-only in L8a. L8b extends the kind checks to
--     conversations. The tables already accept the conversation kind.
--   - db_quota_mb is seeded as 500, the Supabase Free plan database size.
--     Change it with SQL if the project is on a different plan.
--   - Every security definer function sets search_path and checks is_admin()
--     inside. Direct writes to the new tables are revoked; the RPCs are the
--     only writers.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Import tracking tables
-- ----------------------------------------------------------------------------
create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('instruction', 'conversation', 'ocr_page')),
  label text check (label is null or char_length(label) between 1 and 120),
  chunk_size integer not null check (chunk_size between 1 and 2000),
  total_files integer check (total_files is null or total_files >= 1),
  processed_files integer not null default 0 check (processed_files >= 0),
  status text not null default 'active'
    check (status in ('active', 'paused', 'completed', 'abandoned')),
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.import_batches is
  'One browser import session. Text sources finish as one file per batch; OCR batches group pages in L8c.';

create table if not exists public.import_sources (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.import_batches (id) on delete cascade,
  kind text not null check (kind in ('instruction', 'conversation', 'ocr_page')),
  file_name text not null check (char_length(file_name) between 1 and 255),
  file_size bigint not null check (file_size > 0),
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  source_label text check (source_label is null or char_length(source_label) between 1 and 120),
  target_count integer not null default 1 check (target_count between 1 and 5),
  status text not null default 'active'
    check (status in ('active', 'paused', 'completed', 'failed', 'abandoned')),
  next_offset bigint not null default 0 check (next_offset >= 0),
  next_row bigint not null default 0 check (next_row >= 0),
  next_chunk_index integer not null default 0 check (next_chunk_index >= 0),
  loaded_rows integer not null default 0 check (loaded_rows >= 0),
  skipped_rows integer not null default 0 check (skipped_rows >= 0),
  invalid_rows integer not null default 0 check (invalid_rows >= 0),
  failed_rows integer not null default 0 check (failed_rows >= 0),
  page_id uuid references public.ocr_pages (id) on delete set null,
  error text,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (kind, file_hash)
);

comment on table public.import_sources is
  'One selected file. file_hash identifies the exact bytes; next_offset and next_row are the resumable position.';

create index if not exists import_sources_created_idx
  on public.import_sources (created_at desc, id desc);

create table if not exists public.import_source_chunks (
  id uuid primary key default gen_random_uuid(),
  import_source_id uuid not null
    references public.import_sources (id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  start_offset bigint not null check (start_offset >= 0),
  end_offset bigint not null check (end_offset >= start_offset),
  start_row bigint not null default 0 check (start_row >= 0),
  end_row bigint not null default 0 check (end_row >= 0 and end_row >= start_row - 1),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  loaded_rows integer not null default 0 check (loaded_rows >= 0),
  skipped_rows integer not null default 0 check (skipped_rows >= 0),
  invalid_rows integer not null default 0 check (invalid_rows >= 0),
  created_at timestamptz not null default now(),
  unique (import_source_id, chunk_index)
);

comment on table public.import_source_chunks is
  'Committed byte slices. A retry with the same chunk_index and content_hash returns the stored counts.';

create table if not exists public.import_source_errors (
  id bigint generated always as identity primary key,
  import_source_id uuid not null
    references public.import_sources (id) on delete cascade,
  row_index bigint not null check (row_index >= 1),
  reason text not null check (char_length(reason) between 1 and 120),
  detail text check (detail is null or char_length(detail) <= 300),
  created_at timestamptz not null default now(),
  unique (import_source_id, row_index)
);

comment on table public.import_source_errors is
  'One row per invalid or duplicate source row. detail is a short excerpt, never the whole row.';

create index if not exists import_source_errors_source_idx
  on public.import_source_errors (import_source_id, row_index);


-- ----------------------------------------------------------------------------
-- 2. Provenance on the item tables
-- ----------------------------------------------------------------------------
alter table public.instruction_items
  add column if not exists import_source_id uuid
    references public.import_sources (id) on delete set null,
  add column if not exists source_row_index bigint;

alter table public.conversation_items
  add column if not exists import_source_id uuid
    references public.import_sources (id) on delete set null,
  add column if not exists source_row_index bigint;

create unique index if not exists instruction_items_import_row_key
  on public.instruction_items (import_source_id, source_row_index)
  where import_source_id is not null;

create unique index if not exists conversation_items_import_row_key
  on public.conversation_items (import_source_id, source_row_index)
  where import_source_id is not null;

comment on column public.instruction_items.import_source_id is
  'The import_sources row this item came from. Null for the local script and older rows.';
comment on column public.instruction_items.source_row_index is
  'One-based row number in the source file. Provenance only; english_hash stays the duplicate rule.';


-- ----------------------------------------------------------------------------
-- 3. Settings. Values are text in app_settings and read through helper
--    functions. Change them with SQL in the dashboard.
-- ----------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('db_quota_mb', '500'),
  ('upload_chunk_text_rows', '200'),
  ('upload_max_chunk_bytes', '716800'),
  ('upload_warn_percent', '60'),
  ('upload_warn_open_percent', '80'),
  ('upload_pause_open_instructions', '1000'),
  ('upload_pause_open_conversations', '1000'),
  ('upload_pause_open_ocr_pages', '60'),
  ('upload_pause_db_percent', '75'),
  ('upload_pause_ocr_percent', '80')
on conflict (key) do nothing;


-- ----------------------------------------------------------------------------
-- 4. Small helpers. These are not security definer and are not executable by
--    app users. The security definer RPCs below call them as their owner.
-- ----------------------------------------------------------------------------
create or replace function public.setting_int(p_key text, p_default integer)
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce(
    (
      select case
               when s.value ~ '^[0-9]+$' then s.value::integer
               else p_default
             end
        from public.app_settings s
       where s.key = p_key
    ),
    p_default
  );
$$;

comment on function public.setting_int(text, integer) is
  'Reads a non-negative integer app_settings value, or the default when the row is missing or malformed.';

create or replace function public.import_instruction_hash(
  p_instruction text,
  p_input text
)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(
    sha256(
      convert_to(
        btrim(regexp_replace(normalize(coalesce(p_instruction, ''), NFC), '[[:space:]]+', ' ', 'g'))
        || E'\n' ||
        btrim(regexp_replace(normalize(coalesce(p_input, ''), NFC), '[[:space:]]+', ' ', 'g')),
        'UTF8'
      )
    ),
    'hex'
  );
$$;

comment on function public.import_instruction_hash(text, text) is
  'The same normalized string as src/lib/khowar.ts englishHashSource and the 0002 backfill.';

create or replace function public.import_parse_instruction(
  p_raw text,
  p_file_source text,
  p_target_count integer
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
  v_instruction text;
  v_response text;
  v_input text;
  v_source text;
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

  if not (v_json ? 'instruction') or jsonb_typeof(v_json -> 'instruction') <> 'string' then
    return query select false, 'missing_instruction'::text, left(p_raw, 300), null::jsonb, null::text, null::text;
    return;
  end if;

  v_instruction := btrim(v_json ->> 'instruction');
  if v_instruction = '' then
    return query select false, 'empty_instruction'::text, left(p_raw, 300), null::jsonb, null::text, null::text;
    return;
  end if;
  if char_length(v_instruction) > 20000 then
    return query select false, 'instruction_too_long'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  v_response := case
    when jsonb_typeof(v_json -> 'response') = 'string' then btrim(v_json ->> 'response')
    when jsonb_typeof(v_json -> 'output') = 'string' then btrim(v_json ->> 'output')
    else null
  end;

  if v_response is null or v_response = '' then
    return query select false, 'missing_response'::text, left(p_raw, 300), null::jsonb, null::text, null::text;
    return;
  end if;
  if char_length(v_response) > 20000 then
    return query select false, 'response_too_long'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  if v_json ? 'input'
     and jsonb_typeof(v_json -> 'input') <> 'null'
     and jsonb_typeof(v_json -> 'input') <> 'string' then
    return query select false, 'invalid_input'::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  v_input := nullif(btrim(coalesce(v_json ->> 'input', '')), '');
  if v_input is not null and char_length(v_input) > 20000 then
    return query select false, 'input_too_long'::text, null::text, null::jsonb, null::text, null::text;
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

  return query select
    true,
    null::text,
    null::text,
    jsonb_build_object('instruction', v_instruction, 'response', v_response)
      || case when v_input is not null then jsonb_build_object('input', v_input) else '{}'::jsonb end,
    coalesce(v_source, p_file_source),
    public.import_instruction_hash(v_instruction, v_input);
end;
$$;

comment on function public.import_parse_instruction(text, text, integer) is
  'Validates one instruction row with the same rules as scripts/import-english.ts. Invalid rows return ok = false instead of raising.';


-- ----------------------------------------------------------------------------
-- 5. Upload status and pause state
-- ----------------------------------------------------------------------------
create or replace function public.upload_pause_state()
returns table (
  db_used_bytes bigint,
  db_quota_bytes bigint,
  db_percent integer,
  db_warning boolean,
  db_paused boolean,
  ocr_used_bytes bigint,
  ocr_quota_bytes bigint,
  ocr_percent integer,
  ocr_warning boolean,
  ocr_paused boolean,
  open_instructions integer,
  open_conversations integer,
  open_ocr_pool integer,
  pause_instructions integer,
  pause_conversations integer,
  pause_ocr_pool integer,
  warn_percent integer,
  open_warn_percent integer
)
language plpgsql
set search_path = public
as $$
declare
  v_db_used bigint;
  v_db_quota_mb integer;
  v_db_quota_bytes bigint;
  v_db_percent integer;
  v_ocr_used bigint;
  v_ocr_quota_mb integer;
  v_ocr_quota_bytes bigint;
  v_ocr_percent integer;
  v_warn_percent integer;
  v_open_warn_percent integer;
  v_pause_instructions integer;
  v_pause_conversations integer;
  v_pause_ocr_pool integer;
  v_open_instructions integer;
  v_open_conversations integer;
  v_open_ocr_pool integer;
begin
  v_db_used := pg_database_size(current_database());
  v_db_quota_mb := public.setting_int('db_quota_mb', 500);
  if v_db_quota_mb < 1 then
    v_db_quota_mb := 500;
  end if;
  v_db_quota_bytes := v_db_quota_mb::bigint * 1048576;

  select coalesce(sum(l.bytes), 0)::bigint
    into v_ocr_used
  from public.ocr_lines l
  where l.purged_at is null;

  v_ocr_quota_mb := public.setting_int('ocr_quota_mb', 400);
  if v_ocr_quota_mb < 1 then
    v_ocr_quota_mb := 400;
  end if;
  v_ocr_quota_bytes := v_ocr_quota_mb::bigint * 1048576;

  v_warn_percent := public.setting_int('upload_warn_percent', 60);
  v_open_warn_percent := public.setting_int('upload_warn_open_percent', 80);
  v_pause_instructions := public.setting_int('upload_pause_open_instructions', 1000);
  v_pause_conversations := public.setting_int('upload_pause_open_conversations', 1000);
  v_pause_ocr_pool := public.setting_int('upload_pause_open_ocr_pages', 60);

  select count(*)::integer
    into v_open_instructions
  from public.instruction_items i
  where i.status = 'open';

  select count(*)::integer
    into v_open_conversations
  from public.conversation_items i
  where i.status = 'open';

  -- 0011 adds the origin column. Before that, no contributor page uses the
  -- open status, so this is the pool count on both sides of the migration.
  select count(*)::integer
    into v_open_ocr_pool
  from public.ocr_pages p
  where p.status = 'open';

  v_db_percent := case
    when v_db_quota_bytes <= 0 then 100
    else least(100, round(v_db_used * 100.0 / v_db_quota_bytes)::integer)
  end;

  v_ocr_percent := case
    when v_ocr_quota_bytes <= 0 then 100
    else least(100, round(v_ocr_used * 100.0 / v_ocr_quota_bytes)::integer)
  end;

  return query select
    v_db_used,
    v_db_quota_bytes,
    v_db_percent,
    v_db_percent >= v_warn_percent,
    v_db_percent >= public.setting_int('upload_pause_db_percent', 75),
    v_ocr_used,
    v_ocr_quota_bytes,
    v_ocr_percent,
    v_ocr_percent >= v_warn_percent,
    v_ocr_percent >= public.setting_int('upload_pause_ocr_percent', 80),
    v_open_instructions,
    v_open_conversations,
    v_open_ocr_pool,
    v_pause_instructions,
    v_pause_conversations,
    v_pause_ocr_pool,
    v_warn_percent,
    v_open_warn_percent;
end;
$$;

comment on function public.upload_pause_state() is
  'Internal read used by the admin RPCs. Not executable by app users.';

create or replace function public.admin_upload_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state record;
begin
  if auth.uid() is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;

  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  select * into v_state from public.upload_pause_state();

  return jsonb_build_object(
    'generated_at', now(),
    'db', jsonb_build_object(
      'used_bytes', v_state.db_used_bytes,
      'quota_bytes', v_state.db_quota_bytes,
      'percent', v_state.db_percent,
      'warning', v_state.db_warning,
      'paused', v_state.db_paused
    ),
    'ocr', jsonb_build_object(
      'used_bytes', v_state.ocr_used_bytes,
      'quota_bytes', v_state.ocr_quota_bytes,
      'percent', v_state.ocr_percent,
      'warning', v_state.ocr_warning,
      'paused', v_state.ocr_paused
    ),
    'instructions', jsonb_build_object(
      'open', v_state.open_instructions,
      'pause_at', v_state.pause_instructions,
      'warning', v_state.open_instructions >= (v_state.pause_instructions * v_state.open_warn_percent) / 100,
      'paused', v_state.open_instructions >= v_state.pause_instructions
    ),
    'conversations', jsonb_build_object(
      'open', v_state.open_conversations,
      'pause_at', v_state.pause_conversations,
      'warning', v_state.open_conversations >= (v_state.pause_conversations * v_state.open_warn_percent) / 100,
      'paused', v_state.open_conversations >= v_state.pause_conversations
    ),
    'ocr_pool', jsonb_build_object(
      'open', v_state.open_ocr_pool,
      'pause_at', v_state.pause_ocr_pool,
      'warning', v_state.open_ocr_pool >= (v_state.pause_ocr_pool * v_state.open_warn_percent) / 100,
      'paused', v_state.open_ocr_pool >= v_state.pause_ocr_pool
    ),
    'settings', jsonb_build_object(
      'chunk_rows', public.setting_int('upload_chunk_text_rows', 200),
      'max_chunk_bytes', public.setting_int('upload_max_chunk_bytes', 716800),
      'warn_percent', v_state.warn_percent,
      'open_warn_percent', v_state.open_warn_percent
    )
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Create or resume a source
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

  if p_kind is distinct from 'instruction' then
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
-- 7. Verify the resume anchor. The browser re-reads the last committed byte
--    slice and sends its hash. A changed file stops before the next chunk.
-- ----------------------------------------------------------------------------
create or replace function public.admin_import_verify_resume(
  p_source_id uuid,
  p_chunk_index integer,
  p_start_offset bigint,
  p_end_offset bigint,
  p_content_hash text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;

  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  return exists (
    select 1
    from public.import_source_chunks c
    where c.import_source_id = p_source_id
      and c.chunk_index = p_chunk_index
      and c.start_offset = p_start_offset
      and c.end_offset = p_end_offset
      and c.content_hash = p_content_hash
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Commit one text chunk. The whole chunk is one transaction. Invalid rows
--    are logged and do not roll back the chunk.
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

  if v_source.kind <> 'instruction' then
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

  if v_state.open_instructions >= v_state.pause_instructions then
    raise exception 'IMPORT_PAUSE_QUEUE';
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
      select *
        into v_parsed
      from public.import_parse_instruction(
        v_raw,
        coalesce(v_source.source_label, v_source.file_name),
        v_source.target_count
      );

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
-- 9. Pause, resume, stop or close a source
-- ----------------------------------------------------------------------------
create or replace function public.admin_import_set_status(
  p_source_id uuid,
  p_status text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.import_sources%rowtype;
begin
  if auth.uid() is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;

  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  if p_status not in ('active', 'paused', 'abandoned', 'completed') then
    raise exception 'IMPORT_INVALID_STATUS';
  end if;

  select *
    into v_source
  from public.import_sources s
  where s.id = p_source_id
  for update;

  if not found then
    raise exception 'IMPORT_SOURCE_NOT_FOUND';
  end if;

  if v_source.status in ('abandoned', 'failed') then
    raise exception 'IMPORT_SOURCE_CLOSED';
  end if;

  if v_source.status = 'completed' and p_status <> 'completed' then
    raise exception 'IMPORT_COMPLETED';
  end if;

  if p_status = 'completed' and v_source.next_offset < v_source.file_size then
    raise exception 'IMPORT_NOT_COMPLETE';
  end if;

  update public.import_sources s
     set status = p_status,
         completed_at = case
           when p_status = 'completed' then coalesce(s.completed_at, now())
           else s.completed_at
         end,
         updated_at = now()
   where s.id = p_source_id;

  update public.import_batches b
     set status = case
           when p_status = 'completed' then 'completed'
           when p_status = 'paused' then 'paused'
           when p_status = 'abandoned' then 'abandoned'
           else 'active'
         end,
         processed_files = case
           when p_status = 'completed' then 1
           else b.processed_files
         end,
         updated_at = now()
   where b.id = v_source.batch_id;

  return p_status;
end;
$$;


-- ----------------------------------------------------------------------------
-- 10. Admin reads for the upload page
-- ----------------------------------------------------------------------------
create or replace function public.admin_import_sources(p_limit integer default 20)
returns table (
  id uuid,
  batch_id uuid,
  kind text,
  file_name text,
  file_size bigint,
  status text,
  next_offset bigint,
  next_row bigint,
  next_chunk_index integer,
  loaded_rows integer,
  skipped_rows integer,
  invalid_rows integer,
  chunk_size integer,
  source_label text,
  target_count integer,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz,
  error text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := p_limit;
begin
  if auth.uid() is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;

  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  if v_limit is null or v_limit < 1 or v_limit > 100 then
    v_limit := 20;
  end if;

  return query
    select
      s.id,
      s.batch_id,
      s.kind,
      s.file_name,
      s.file_size,
      s.status,
      s.next_offset,
      s.next_row,
      s.next_chunk_index,
      s.loaded_rows,
      s.skipped_rows,
      s.invalid_rows,
      coalesce(b.chunk_size, 200)::integer as chunk_size,
      s.source_label,
      s.target_count,
      s.created_at,
      s.updated_at,
      s.completed_at,
      s.error
    from public.import_sources s
    left join public.import_batches b on b.id = s.batch_id
    order by s.created_at desc, s.id desc
    limit v_limit;
end;
$$;

create or replace function public.admin_import_errors(
  p_source_id uuid,
  p_offset integer default 0,
  p_limit integer default 50
)
returns table (
  total_count bigint,
  row_index bigint,
  reason text,
  detail text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_offset integer := p_offset;
  v_limit integer := p_limit;
  v_total bigint;
begin
  if auth.uid() is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;

  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  if v_offset is null or v_offset < 0 then
    v_offset := 0;
  end if;

  if v_limit is null or v_limit < 1 or v_limit > 1000 then
    v_limit := 50;
  end if;

  select count(*)
    into v_total
  from public.import_source_errors e
  where e.import_source_id = p_source_id;

  return query
    select v_total, e.row_index, e.reason, e.detail, e.created_at
    from public.import_source_errors e
    where e.import_source_id = p_source_id
    order by e.row_index
    offset v_offset
    limit v_limit;
end;
$$;


-- ----------------------------------------------------------------------------
-- 11. Row level security. Admin only on every new table. Direct writes are
--     revoked, so the security definer RPCs are the only writers.
-- ----------------------------------------------------------------------------
alter table public.import_batches enable row level security;
alter table public.import_sources enable row level security;
alter table public.import_source_chunks enable row level security;
alter table public.import_source_errors enable row level security;

drop policy if exists "import_batches: admin only" on public.import_batches;
create policy "import_batches: admin only" on public.import_batches
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "import_sources: admin only" on public.import_sources;
create policy "import_sources: admin only" on public.import_sources
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "import_source_chunks: admin only" on public.import_source_chunks;
create policy "import_source_chunks: admin only" on public.import_source_chunks
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "import_source_errors: admin only" on public.import_source_errors;
create policy "import_source_errors: admin only" on public.import_source_errors
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on table public.import_batches from public, anon, authenticated;
revoke all on table public.import_sources from public, anon, authenticated;
revoke all on table public.import_source_chunks from public, anon, authenticated;
revoke all on table public.import_source_errors from public, anon, authenticated;

grant select on table public.import_batches to authenticated;
grant select on table public.import_sources to authenticated;
grant select on table public.import_source_chunks to authenticated;
grant select on table public.import_source_errors to authenticated;


-- ----------------------------------------------------------------------------
-- 12. Grants. Helper functions are internal. The admin RPCs are authenticated
--     only and check the role inside.
-- ----------------------------------------------------------------------------
revoke all on function public.setting_int(text, integer) from public, anon, authenticated;
revoke all on function public.import_instruction_hash(text, text) from public, anon, authenticated;
revoke all on function public.import_parse_instruction(text, text, integer) from public, anon, authenticated;
revoke all on function public.upload_pause_state() from public, anon, authenticated;

revoke all on function public.admin_upload_status() from public, anon, authenticated;
revoke all on function public.admin_import_create_source(text, text, bigint, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_import_verify_resume(uuid, integer, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.admin_import_text_chunk(uuid, integer, bigint, bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.admin_import_set_status(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_import_sources(integer) from public, anon, authenticated;
revoke all on function public.admin_import_errors(uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.admin_upload_status() to authenticated;
grant execute on function public.admin_import_create_source(text, text, bigint, text, text, integer, integer) to authenticated;
grant execute on function public.admin_import_verify_resume(uuid, integer, bigint, bigint, text) to authenticated;
grant execute on function public.admin_import_text_chunk(uuid, integer, bigint, bigint, text, jsonb) to authenticated;
grant execute on function public.admin_import_set_status(uuid, text) to authenticated;
grant execute on function public.admin_import_sources(integer) to authenticated;
grant execute on function public.admin_import_errors(uuid, integer, integer) to authenticated;
