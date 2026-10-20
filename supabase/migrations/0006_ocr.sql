-- ============================================================================
-- NeuraFlix Labeler: OCR upload, quota guard and My pages (Phase L4c)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again (guarded drops / IF NOT EXISTS).
--   4. Nothing in this repo runs it for you.
--
-- What this file changes
--   - app_settings with the OCR quota, readable only for the ocr_quota_mb key.
--   - ocr_pages status set, reviewer fields and checks.
--   - ocr_lines idx, label, size and dimension checks.
--   - The private ocr-lines bucket limits (2 MB, WebP and JPEG).
--   - ocr_storage_status(), ocr_create_page(), ocr_finalize_page() and
--     ocr_abort_page().
--   - Policies and grants so contributors insert only through the functions.
--
-- Already in 0001, left alone
--   - The ocr_pages and ocr_lines tables and their indexes.
--   - The unique (page_id, idx) guard.
--   - The ocr-lines bucket and all four own-prefix storage policies plus the
--     reviewer/admin read policy. They are not duplicated here.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. App settings. Admins change values with SQL; nobody can write through the
--    API. The old plan used an env var for the quota, but an env var cannot
--    guard a function a signed-in user can call directly.
-- ----------------------------------------------------------------------------
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

comment on table public.app_settings is
  'Small server-side settings. Read through RLS, changed by admins with SQL.';

alter table public.app_settings enable row level security;

drop policy if exists "app_settings: read ocr quota" on public.app_settings;
create policy "app_settings: read ocr quota" on public.app_settings
  for select to authenticated
  using (key = 'ocr_quota_mb');

insert into public.app_settings (key, value)
values ('ocr_quota_mb', '400')
on conflict (key) do nothing;

revoke all on table public.app_settings from public, anon, authenticated;
grant select on table public.app_settings to authenticated;


-- ----------------------------------------------------------------------------
-- 2. ocr_pages: upload statuses, reviewer fields and checks.
--    0001 allowed draft, submitted, approved and rejected. A page now starts
--    as uploading, and an abandoned upload becomes failed.
-- ----------------------------------------------------------------------------
alter table public.ocr_pages
  add column if not exists reviewer_id uuid
    references public.profiles (id) on delete set null;
alter table public.ocr_pages
  add column if not exists review_note text;

alter table public.ocr_pages
  drop constraint if exists ocr_pages_status_check;
update public.ocr_pages
  set status = 'failed'
  where status = 'draft';
alter table public.ocr_pages
  add constraint ocr_pages_status_check
  check (status in ('uploading', 'submitted', 'approved', 'rejected', 'failed'));

-- line_count was optional before uploads existed. A page is created with its
-- planned line count, so an existing zero-only page can move to the minimum.
update public.ocr_pages
  set line_count = 1
  where line_count < 1;

alter table public.ocr_pages
  alter column line_count drop default;
alter table public.ocr_pages
  drop constraint if exists ocr_pages_line_count_check;
alter table public.ocr_pages
  add constraint ocr_pages_line_count_check
  check (line_count between 1 and 40);

alter table public.ocr_pages
  drop constraint if exists ocr_pages_rights_confirmed_check;
alter table public.ocr_pages
  add constraint ocr_pages_rights_confirmed_check
  check (rights_confirmed = true);

alter table public.ocr_pages
  drop constraint if exists ocr_pages_label_length_check;
alter table public.ocr_pages
  add constraint ocr_pages_label_length_check
  check (label is null or char_length(label) <= 120);

create index if not exists ocr_pages_status_idx
  on public.ocr_pages (status, created_at desc);


-- ----------------------------------------------------------------------------
-- 3. ocr_lines: idx 1 to 40, non-empty labels up to 400 characters, real
--    dimensions and a 2 MB encoded image cap. unique (page_id, idx) exists
--    from 0001 and is not repeated.
-- ----------------------------------------------------------------------------
alter table public.ocr_lines
  drop constraint if exists ocr_lines_idx_check;
alter table public.ocr_lines
  add constraint ocr_lines_idx_check
  check (idx between 1 and 40);

alter table public.ocr_lines
  drop constraint if exists ocr_lines_label_check;
alter table public.ocr_lines
  add constraint ocr_lines_label_check
  check (label is not null and char_length(btrim(label)) between 1 and 400);

alter table public.ocr_lines
  drop constraint if exists ocr_lines_bytes_check;
alter table public.ocr_lines
  add constraint ocr_lines_bytes_check
  check (bytes is not null and bytes between 1 and 2000000);

alter table public.ocr_lines
  drop constraint if exists ocr_lines_width_check;
alter table public.ocr_lines
  add constraint ocr_lines_width_check
  check (width is not null and width > 0);

alter table public.ocr_lines
  drop constraint if exists ocr_lines_height_check;
alter table public.ocr_lines
  add constraint ocr_lines_height_check
  check (height is not null and height > 0);


-- ----------------------------------------------------------------------------
-- 4. The private bucket. 0001 created it without limits; this adds the 2 MB
--    cap and restricts the MIME types. Storage policies already exist in 0001
--    and are intentionally not recreated.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ocr-lines',
  'ocr-lines',
  false,
  2097152,
  array['image/webp', 'image/jpeg']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ----------------------------------------------------------------------------
-- 5. Storage status: used bytes of lines not purged, and the quota in bytes.
-- ----------------------------------------------------------------------------
create or replace function public.ocr_storage_status()
returns table (used_bytes bigint, quota_bytes bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_used bigint := 0;
  v_quota_mb bigint;
begin
  select coalesce(sum(l.bytes), 0)::bigint
    into v_used
  from public.ocr_lines l
  where l.purged_at is null;

  select case
           when s.value ~ '^[0-9]+$' then s.value::bigint
           else 400
         end
    into v_quota_mb
  from public.app_settings s
  where s.key = 'ocr_quota_mb';

  if v_quota_mb is null or v_quota_mb < 1 then
    v_quota_mb := 400;
  end if;

  return query select v_used, v_quota_mb * 1048576;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Create a page after the client encoded all lines and knows the total
--    bytes. The advisory lock makes the quota and rate checks serial.
-- ----------------------------------------------------------------------------
create or replace function public.ocr_create_page(
  p_label text,
  p_rights boolean,
  p_line_count integer,
  p_total_bytes bigint
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_label text;
  v_used bigint := 0;
  v_quota_mb bigint;
  v_quota_bytes bigint;
  v_recent integer := 0;
  v_page_id uuid;
begin
  if v_uid is null then
    raise exception 'OCR_AUTH_REQUIRED';
  end if;

  if p_rights is not true then
    raise exception 'OCR_RIGHTS_REQUIRED';
  end if;

  if p_line_count is null or p_line_count < 1 or p_line_count > 40 then
    raise exception 'OCR_INVALID_LINES';
  end if;

  if p_total_bytes is null or p_total_bytes < 1 or p_total_bytes > 80000000 then
    raise exception 'OCR_INVALID_BYTES';
  end if;

  v_label := nullif(btrim(coalesce(p_label, '')), '');
  if v_label is not null and char_length(v_label) > 120 then
    raise exception 'OCR_INVALID_LABEL';
  end if;

  perform pg_advisory_xact_lock(hashtext('ocr_create_page'));

  select count(*)::integer
    into v_recent
  from public.ocr_pages p
  where p.contributor_id = v_uid
    and p.created_at >= now() - interval '24 hours';

  if v_recent >= 20 then
    raise exception 'OCR_RATE_LIMIT';
  end if;

  select coalesce(sum(l.bytes), 0)::bigint
    into v_used
  from public.ocr_lines l
  where l.purged_at is null;

  select case
           when s.value ~ '^[0-9]+$' then s.value::bigint
           else 400
         end
    into v_quota_mb
  from public.app_settings s
  where s.key = 'ocr_quota_mb';

  if v_quota_mb is null or v_quota_mb < 1 then
    v_quota_mb := 400;
  end if;
  v_quota_bytes := v_quota_mb * 1048576;

  if v_used + p_total_bytes > (v_quota_bytes * 80) / 100 then
    raise exception 'OCR_STORAGE_FULL';
  end if;

  insert into public.ocr_pages as p (
    contributor_id,
    label,
    rights_confirmed,
    line_count,
    status
  ) values (
    v_uid,
    v_label,
    true,
    p_line_count,
    'uploading'
  )
  returning p.id into v_page_id;

  return v_page_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. Finalize: validate the uploaded line metadata and insert every line in
--    the same transaction as the page status change.
-- ----------------------------------------------------------------------------
create or replace function public.ocr_finalize_page(
  p_page_id uuid,
  p_lines jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_count integer;
  v_distinct integer;
  v_prefix text;
begin
  if v_uid is null then
    raise exception 'OCR_AUTH_REQUIRED';
  end if;

  if p_page_id is null then
    raise exception 'OCR_INVALID_PAGE';
  end if;

  select p.status
    into v_status
  from public.ocr_pages p
  where p.id = p_page_id
    and p.contributor_id = v_uid
  for update;

  if v_status is null then
    raise exception 'OCR_PAGE_NOT_FOUND';
  end if;

  if v_status <> 'uploading' then
    raise exception 'OCR_PAGE_NOT_EDITABLE';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'OCR_INVALID_LINES';
  end if;

  select count(*)::integer
    into v_count
  from jsonb_array_elements(p_lines) e;

  if v_count < 1 or v_count > 40 then
    raise exception 'OCR_INVALID_LINES';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where jsonb_typeof(e.value) <> 'object'
      or e.value -> 'idx' is null
      or jsonb_typeof(e.value -> 'idx') <> 'number'
      or e.value -> 'storage_path' is null
      or jsonb_typeof(e.value -> 'storage_path') <> 'string'
      or e.value -> 'label' is null
      or jsonb_typeof(e.value -> 'label') <> 'string'
      or e.value -> 'width' is null
      or jsonb_typeof(e.value -> 'width') <> 'number'
      or e.value -> 'height' is null
      or jsonb_typeof(e.value -> 'height') <> 'number'
      or e.value -> 'bytes' is null
      or jsonb_typeof(e.value -> 'bytes') <> 'number'
  ) then
    raise exception 'OCR_INVALID_LINES';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where (e.value ->> 'idx') !~ '^[0-9]+$'
      or (e.value ->> 'width') !~ '^[0-9]+$'
      or (e.value ->> 'height') !~ '^[0-9]+$'
      or (e.value ->> 'bytes') !~ '^[0-9]+$'
  ) then
    raise exception 'OCR_INVALID_LINES';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where (e.value ->> 'idx')::integer < 1
      or (e.value ->> 'idx')::integer > 40
      or (e.value ->> 'width')::integer < 1
      or (e.value ->> 'height')::integer < 1
      or (e.value ->> 'bytes')::integer < 1
      or (e.value ->> 'bytes')::integer > 2000000
  ) then
    raise exception 'OCR_INVALID_LINES';
  end if;

  select count(distinct (e.value ->> 'idx')::integer)::integer
    into v_distinct
  from jsonb_array_elements(p_lines) e;

  if v_distinct <> v_count then
    raise exception 'OCR_INVALID_LINES';
  end if;

  v_prefix := v_uid::text || '/' || p_page_id::text || '/';

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where not starts_with(e.value ->> 'storage_path', v_prefix)
  ) then
    raise exception 'OCR_INVALID_PATH';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where char_length(btrim(e.value ->> 'label')) = 0
      or char_length(e.value ->> 'label') > 400
  ) then
    raise exception 'OCR_INVALID_LABEL';
  end if;

  insert into public.ocr_lines as l (
    page_id,
    idx,
    storage_path,
    label,
    status,
    width,
    height,
    bytes
  )
  select
    p_page_id,
    (e.value ->> 'idx')::integer,
    e.value ->> 'storage_path',
    e.value ->> 'label',
    'submitted',
    (e.value ->> 'width')::integer,
    (e.value ->> 'height')::integer,
    (e.value ->> 'bytes')::integer
  from jsonb_array_elements(p_lines) e
  order by (e.value ->> 'idx')::integer;

  update public.ocr_pages as p
    set line_count = v_count,
        status = 'submitted'
  where p.id = p_page_id
    and p.contributor_id = v_uid;

  return v_count;
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Abort an unfinished page. The caller's own uploading page becomes failed.
-- ----------------------------------------------------------------------------
create or replace function public.ocr_abort_page(p_page_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'OCR_AUTH_REQUIRED';
  end if;

  update public.ocr_pages as p
    set status = 'failed'
  where p.id = p_page_id
    and p.contributor_id = v_uid
    and p.status = 'uploading';
end;
$$;


-- ----------------------------------------------------------------------------
-- 9. RLS and grants. Contributors read their own rows and insert only through
--    the security definer functions above. Reviewers and admins keep the read
--    policies from 0001. Direct writes are removed.
-- ----------------------------------------------------------------------------
drop policy if exists "ocr_pages: insert own" on public.ocr_pages;
drop policy if exists "ocr_pages: update own" on public.ocr_pages;
drop policy if exists "ocr_pages: delete own" on public.ocr_pages;

drop policy if exists "ocr_lines: insert own" on public.ocr_lines;
drop policy if exists "ocr_lines: update own" on public.ocr_lines;
drop policy if exists "ocr_lines: delete own" on public.ocr_lines;

revoke insert, update, delete on public.ocr_pages from anon, authenticated;
revoke insert, update, delete on public.ocr_lines from anon, authenticated;
grant select on public.ocr_pages to authenticated;
grant select on public.ocr_lines to authenticated;

revoke all on function public.ocr_storage_status() from public, anon;
revoke all on function public.ocr_create_page(text, boolean, integer, bigint) from public, anon;
revoke all on function public.ocr_finalize_page(uuid, jsonb) from public, anon;
revoke all on function public.ocr_abort_page(uuid) from public, anon;

grant execute on function public.ocr_storage_status() to authenticated;
grant execute on function public.ocr_create_page(text, boolean, integer, bigint) to authenticated;
grant execute on function public.ocr_finalize_page(uuid, jsonb) to authenticated;
grant execute on function public.ocr_abort_page(uuid) to authenticated;
