-- 0014_import_delete.sql
-- Admin deletion for imported instructions and conversations.
-- Safe by default: only open items with no translations, claims or review
-- records are removed. Anything with labeler work stays unless the admin
-- explicitly includes it and types DELETE or the source file name.
-- No OCR table and no Storage object is touched here.
--
-- Safe to run again. This repo never applies it. Run after 0013.

-- ----------------------------------------------------------------------------
-- 1. Audit trail. Survives source removal on purpose, so the trail is kept.
-- ----------------------------------------------------------------------------
create table if not exists public.import_deletions (
  id uuid primary key default gen_random_uuid(),
  import_source_id uuid,
  kind text not null check (kind in ('instruction', 'conversation')),
  file_name text,
  actor_id uuid not null references public.profiles (id) on delete cascade,
  include_work boolean not null default false,
  deleted_items integer not null default 0 check (deleted_items >= 0),
  deleted_translations integer not null default 0 check (deleted_translations >= 0),
  deleted_exported integer not null default 0 check (deleted_exported >= 0),
  deleted_claims integer not null default 0 check (deleted_claims >= 0),
  deleted_reviews integer not null default 0 check (deleted_reviews >= 0),
  remaining_items integer not null default 0 check (remaining_items >= 0),
  source_removed boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.import_deletions is
  'Admin deletion audit. One row per source delete or single item delete.';

alter table public.import_deletions enable row level security;

revoke all on table public.import_deletions from public, anon, authenticated;

create index if not exists import_deletions_created_idx
  on public.import_deletions (created_at desc, id desc);


-- ----------------------------------------------------------------------------
-- 2. Preview: exact counts before anything is deleted.
-- ----------------------------------------------------------------------------
create or replace function public.admin_import_delete_preview(p_source_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.import_sources%rowtype;
  v_total integer := 0;
  v_open integer := 0;
  v_translated integer := 0;
  v_claimed integer := 0;
  v_reviewed integer := 0;
  v_exported integer := 0;
  v_safe integer := 0;
begin
  if auth.uid() is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;
  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  select * into v_source
    from public.import_sources s
   where s.id = p_source_id;

  if not found then
    raise exception 'IMPORT_SOURCE_NOT_FOUND';
  end if;
  if v_source.kind not in ('instruction', 'conversation') then
    raise exception 'IMPORT_KIND_UNSUPPORTED';
  end if;

  if v_source.kind = 'instruction' then
    select
      count(*),
      count(*) filter (where i.status = 'open'),
      count(*) filter (where exists (
        select 1 from public.instruction_translations t where t.item_id = i.id
      )),
      count(*) filter (where exists (
        select 1 from public.claims c
         where c.kind = 'instruction' and c.item_id = i.id
      )),
      count(*) filter (where exists (
        select 1 from public.review_log r
         where r.kind = 'instruction' and r.item_id = i.id
      )),
      count(*) filter (
        where i.status = 'open'
          and not exists (
            select 1 from public.instruction_translations t where t.item_id = i.id
          )
          and not exists (
            select 1 from public.claims c
             where c.kind = 'instruction' and c.item_id = i.id
          )
          and not exists (
            select 1 from public.review_log r
             where r.kind = 'instruction' and r.item_id = i.id
          )
      )
      into v_total, v_open, v_translated, v_claimed, v_reviewed, v_safe
      from public.instruction_items i
     where i.import_source_id = p_source_id;

    select count(*)
      into v_exported
      from public.instruction_translations t
      join public.instruction_items i on i.id = t.item_id
     where i.import_source_id = p_source_id
       and t.exported_at is not null;
  else
    select
      count(*),
      count(*) filter (where i.status = 'open'),
      count(*) filter (where exists (
        select 1 from public.conversation_translations t where t.item_id = i.id
      )),
      count(*) filter (where exists (
        select 1 from public.claims c
         where c.kind = 'conversation' and c.item_id = i.id
      )),
      count(*) filter (where exists (
        select 1 from public.review_log r
         where r.kind = 'conversation' and r.item_id = i.id
      )),
      count(*) filter (
        where i.status = 'open'
          and not exists (
            select 1 from public.conversation_translations t where t.item_id = i.id
          )
          and not exists (
            select 1 from public.claims c
             where c.kind = 'conversation' and c.item_id = i.id
          )
          and not exists (
            select 1 from public.review_log r
             where r.kind = 'conversation' and r.item_id = i.id
          )
      )
      into v_total, v_open, v_translated, v_claimed, v_reviewed, v_safe
      from public.conversation_items i
     where i.import_source_id = p_source_id;

    select count(*)
      into v_exported
      from public.conversation_translations t
      join public.conversation_items i on i.id = t.item_id
     where i.import_source_id = p_source_id
       and t.exported_at is not null;
  end if;

  return jsonb_build_object(
    'source_id', v_source.id,
    'kind', v_source.kind,
    'file_name', v_source.file_name,
    'file_hash', v_source.file_hash,
    'source_label', v_source.source_label,
    'status', v_source.status,
    'total_items', v_total,
    'open_items', v_open,
    'translated_items', v_translated,
    'claimed_items', v_claimed,
    'reviewed_items', v_reviewed,
    'exported_items', v_exported,
    'safe_items', v_safe,
    'protected_items', v_total - v_safe
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. Item list for the confirm dialog, with per-item protection counts.
-- ----------------------------------------------------------------------------
create or replace function public.admin_import_source_items(
  p_source_id uuid,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  out_item_id uuid,
  out_status text,
  out_preview text,
  out_translation_count integer,
  out_claim_count integer,
  out_review_count integer,
  out_exported_count integer,
  out_can_delete boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  if auth.uid() is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;
  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  select s.kind into v_kind from public.import_sources s where s.id = p_source_id;
  if v_kind is null then
    raise exception 'IMPORT_SOURCE_NOT_FOUND';
  end if;

  if v_kind = 'instruction' then
    return query
      select
        i.id,
        i.status,
        left(coalesce(i.english ->> 'instruction', ''), 160),
        (select count(*)::integer from public.instruction_translations t where t.item_id = i.id),
        (select count(*)::integer from public.claims c
          where c.kind = 'instruction' and c.item_id = i.id),
        (select count(*)::integer from public.review_log r
          where r.kind = 'instruction' and r.item_id = i.id),
        (select count(*)::integer from public.instruction_translations t
          where t.item_id = i.id and t.exported_at is not null),
        (
          i.status = 'open'
          and not exists (
            select 1 from public.instruction_translations t where t.item_id = i.id
          )
          and not exists (
            select 1 from public.claims c
             where c.kind = 'instruction' and c.item_id = i.id
          )
          and not exists (
            select 1 from public.review_log r
             where r.kind = 'instruction' and r.item_id = i.id
          )
        )
      from public.instruction_items i
     where i.import_source_id = p_source_id
     order by i.created_at, i.id
     limit v_limit offset v_offset;
  elsif v_kind = 'conversation' then
    return query
      select
        i.id,
        i.status,
        left(coalesce(
          (
            select string_agg(t.value ->> 'content', ' ' order by t.ord)
              from jsonb_array_elements(i.english -> 'turns')
                   with ordinality as t(value, ord)
          ),
          ''
        ), 160),
        (select count(*)::integer from public.conversation_translations t where t.item_id = i.id),
        (select count(*)::integer from public.claims c
          where c.kind = 'conversation' and c.item_id = i.id),
        (select count(*)::integer from public.review_log r
          where r.kind = 'conversation' and r.item_id = i.id),
        (select count(*)::integer from public.conversation_translations t
          where t.item_id = i.id and t.exported_at is not null),
        (
          i.status = 'open'
          and not exists (
            select 1 from public.conversation_translations t where t.item_id = i.id
          )
          and not exists (
            select 1 from public.claims c
             where c.kind = 'conversation' and c.item_id = i.id
          )
          and not exists (
            select 1 from public.review_log r
             where r.kind = 'conversation' and r.item_id = i.id
          )
        )
      from public.conversation_items i
     where i.import_source_id = p_source_id
     order by i.created_at, i.id
     limit v_limit offset v_offset;
  else
    raise exception 'IMPORT_KIND_UNSUPPORTED';
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. Delete all items of one source. Safe by default.
-- ----------------------------------------------------------------------------
create or replace function public.admin_delete_import_source(
  p_source_id uuid,
  p_include_work boolean default false,
  p_confirm text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.import_sources%rowtype;
  v_ids uuid[] := array[]::uuid[];
  v_deleted_items integer := 0;
  v_deleted_translations integer := 0;
  v_deleted_exported integer := 0;
  v_deleted_claims integer := 0;
  v_deleted_reviews integer := 0;
  v_remaining integer := 0;
  v_source_removed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;
  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  select * into v_source
    from public.import_sources s
   where s.id = p_source_id;

  if not found then
    raise exception 'IMPORT_SOURCE_NOT_FOUND';
  end if;
  if v_source.kind not in ('instruction', 'conversation') then
    raise exception 'IMPORT_KIND_UNSUPPORTED';
  end if;

  if coalesce(p_include_work, false) then
    if btrim(coalesce(p_confirm, '')) <> 'DELETE'
       and btrim(coalesce(p_confirm, '')) <> v_source.file_name then
      raise exception 'DELETE_CONFIRM_REQUIRED';
    end if;
  end if;

  if v_source.kind = 'instruction' then
    if coalesce(p_include_work, false) then
      select coalesce(array_agg(i.id), array[]::uuid[]) into v_ids
        from public.instruction_items i
       where i.import_source_id = p_source_id;
    else
      select coalesce(array_agg(i.id), array[]::uuid[]) into v_ids
        from public.instruction_items i
       where i.import_source_id = p_source_id
         and i.status = 'open'
         and not exists (
           select 1 from public.instruction_translations t where t.item_id = i.id
         )
         and not exists (
           select 1 from public.claims c
            where c.kind = 'instruction' and c.item_id = i.id
         )
         and not exists (
           select 1 from public.review_log r
            where r.kind = 'instruction' and r.item_id = i.id
         );
    end if;

    select count(*) into v_deleted_translations
      from public.instruction_translations t where t.item_id = any(v_ids);
    select count(*) into v_deleted_exported
      from public.instruction_translations t
     where t.item_id = any(v_ids) and t.exported_at is not null;
  else
    if coalesce(p_include_work, false) then
      select coalesce(array_agg(i.id), array[]::uuid[]) into v_ids
        from public.conversation_items i
       where i.import_source_id = p_source_id;
    else
      select coalesce(array_agg(i.id), array[]::uuid[]) into v_ids
        from public.conversation_items i
       where i.import_source_id = p_source_id
         and i.status = 'open'
         and not exists (
           select 1 from public.conversation_translations t where t.item_id = i.id
         )
         and not exists (
           select 1 from public.claims c
            where c.kind = 'conversation' and c.item_id = i.id
         )
         and not exists (
           select 1 from public.review_log r
            where r.kind = 'conversation' and r.item_id = i.id
         );
    end if;

    select count(*) into v_deleted_translations
      from public.conversation_translations t where t.item_id = any(v_ids);
    select count(*) into v_deleted_exported
      from public.conversation_translations t
     where t.item_id = any(v_ids) and t.exported_at is not null;
  end if;

  select count(*) into v_deleted_claims
    from public.claims c
   where c.kind = v_source.kind and c.item_id = any(v_ids);
  select count(*) into v_deleted_reviews
    from public.review_log r
   where r.kind = v_source.kind and r.item_id = any(v_ids);

  -- Explicit child cleanup first, then the items. Translations cascade from
  -- the item delete. Nothing here touches OCR tables or Storage.
  delete from public.claims c
   where c.kind = v_source.kind and c.item_id = any(v_ids);
  delete from public.review_log r
   where r.kind = v_source.kind and r.item_id = any(v_ids);
  delete from public.skips s
   where s.kind = v_source.kind and s.item_id = any(v_ids);

  if v_source.kind = 'instruction' then
    delete from public.instruction_items i where i.id = any(v_ids);
  else
    delete from public.conversation_items i where i.id = any(v_ids);
  end if;

  v_deleted_items := coalesce(array_length(v_ids, 1), 0);

  if v_source.kind = 'instruction' then
    select count(*) into v_remaining
      from public.instruction_items i where i.import_source_id = p_source_id;
  else
    select count(*) into v_remaining
      from public.conversation_items i where i.import_source_id = p_source_id;
  end if;

  -- With no items left, remove the source so the same file can be uploaded
  -- again: the (kind, file_hash) unique key and the item english_hash rows are
  -- both gone. Chunks and row errors cascade with the source.
  if v_remaining = 0 then
    delete from public.import_sources s where s.id = p_source_id;
    v_source_removed := true;
  else
    update public.import_sources s
       set loaded_rows = v_remaining,
           updated_at = now()
     where s.id = p_source_id;
  end if;

  insert into public.import_deletions (
    import_source_id, kind, file_name, actor_id, include_work,
    deleted_items, deleted_translations, deleted_exported,
    deleted_claims, deleted_reviews, remaining_items, source_removed
  ) values (
    p_source_id, v_source.kind, v_source.file_name, auth.uid(),
    coalesce(p_include_work, false),
    v_deleted_items, v_deleted_translations, v_deleted_exported,
    v_deleted_claims, v_deleted_reviews, v_remaining, v_source_removed
  );

  return jsonb_build_object(
    'deleted_items', v_deleted_items,
    'deleted_translations', v_deleted_translations,
    'deleted_exported', v_deleted_exported,
    'deleted_claims', v_deleted_claims,
    'deleted_reviews', v_deleted_reviews,
    'remaining_items', v_remaining,
    'source_removed', v_source_removed
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Delete one imported item. Same protection and confirm rules.
-- ----------------------------------------------------------------------------
create or replace function public.admin_delete_import_item(
  p_kind text,
  p_item_id uuid,
  p_include_work boolean default false,
  p_confirm text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_id uuid;
  v_file_name text;
  v_status text;
  v_translations integer := 0;
  v_exported integer := 0;
  v_claims integer := 0;
  v_reviews integer := 0;
  v_remaining integer := 0;
  v_source_removed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;
  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;
  if p_kind not in ('instruction', 'conversation') then
    raise exception 'IMPORT_KIND_UNSUPPORTED';
  end if;

  if p_kind = 'instruction' then
    select i.import_source_id, i.status
      into v_source_id, v_status
      from public.instruction_items i
     where i.id = p_item_id;
  else
    select i.import_source_id, i.status
      into v_source_id, v_status
      from public.conversation_items i
     where i.id = p_item_id;
  end if;

  if v_status is null then
    raise exception 'IMPORT_ITEM_NOT_FOUND';
  end if;
  if v_source_id is null then
    raise exception 'IMPORT_ITEM_NOT_IMPORTED';
  end if;

  select s.file_name into v_file_name
    from public.import_sources s where s.id = v_source_id;

  if p_kind = 'instruction' then
    select count(*) into v_translations
      from public.instruction_translations t where t.item_id = p_item_id;
    select count(*) into v_exported
      from public.instruction_translations t
     where t.item_id = p_item_id and t.exported_at is not null;
  else
    select count(*) into v_translations
      from public.conversation_translations t where t.item_id = p_item_id;
    select count(*) into v_exported
      from public.conversation_translations t
     where t.item_id = p_item_id and t.exported_at is not null;
  end if;

  select count(*) into v_claims
    from public.claims c
   where c.kind = p_kind and c.item_id = p_item_id;
  select count(*) into v_reviews
    from public.review_log r
   where r.kind = p_kind and r.item_id = p_item_id;

  if not coalesce(p_include_work, false) then
    if v_status <> 'open'
       or v_translations > 0
       or v_claims > 0
       or v_reviews > 0 then
      raise exception 'IMPORT_ITEM_PROTECTED';
    end if;
  else
    if btrim(coalesce(p_confirm, '')) <> 'DELETE'
       and btrim(coalesce(p_confirm, '')) <> coalesce(v_file_name, '') then
      raise exception 'DELETE_CONFIRM_REQUIRED';
    end if;
  end if;

  delete from public.claims c
   where c.kind = p_kind and c.item_id = p_item_id;
  delete from public.review_log r
   where r.kind = p_kind and r.item_id = p_item_id;
  delete from public.skips s
   where s.kind = p_kind and s.item_id = p_item_id;

  if p_kind = 'instruction' then
    delete from public.instruction_items i where i.id = p_item_id;
  else
    delete from public.conversation_items i where i.id = p_item_id;
  end if;

  if p_kind = 'instruction' then
    select count(*) into v_remaining
      from public.instruction_items i where i.import_source_id = v_source_id;
  else
    select count(*) into v_remaining
      from public.conversation_items i where i.import_source_id = v_source_id;
  end if;

  if v_remaining = 0 and v_source_id is not null then
    delete from public.import_sources s where s.id = v_source_id;
    v_source_removed := true;
  elsif v_source_id is not null then
    update public.import_sources s
       set loaded_rows = v_remaining,
           updated_at = now()
     where s.id = v_source_id;
  end if;

  insert into public.import_deletions (
    import_source_id, kind, file_name, actor_id, include_work,
    deleted_items, deleted_translations, deleted_exported,
    deleted_claims, deleted_reviews, remaining_items, source_removed
  ) values (
    v_source_id, p_kind, v_file_name, auth.uid(),
    coalesce(p_include_work, false),
    1, v_translations, v_exported,
    v_claims, v_reviews, v_remaining, v_source_removed
  );

  return jsonb_build_object(
    'deleted_items', 1,
    'deleted_translations', v_translations,
    'deleted_exported', v_exported,
    'deleted_claims', v_claims,
    'deleted_reviews', v_reviews,
    'remaining_items', v_remaining,
    'source_removed', v_source_removed
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Audit list for admins.
-- ----------------------------------------------------------------------------
create or replace function public.admin_import_deletions(p_limit integer default 20)
returns table (
  out_id uuid,
  out_kind text,
  out_file_name text,
  out_actor_name text,
  out_include_work boolean,
  out_deleted_items integer,
  out_deleted_translations integer,
  out_deleted_exported integer,
  out_remaining_items integer,
  out_source_removed boolean,
  out_created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
begin
  if auth.uid() is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;
  if not public.is_admin() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  return query
    select
      d.id, d.kind, d.file_name,
      coalesce(p.display_name, 'Admin'),
      d.include_work, d.deleted_items, d.deleted_translations,
      d.deleted_exported, d.remaining_items, d.source_removed, d.created_at
    from public.import_deletions d
    left join public.profiles p on p.id = d.actor_id
    order by d.created_at desc, d.id desc
    limit v_limit;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. Grants: authenticated only, is_admin() is checked inside each function.
-- ----------------------------------------------------------------------------
revoke all on function public.admin_import_delete_preview(uuid) from public, anon;
revoke all on function public.admin_import_source_items(uuid, integer, integer) from public, anon;
revoke all on function public.admin_delete_import_source(uuid, boolean, text) from public, anon;
revoke all on function public.admin_delete_import_item(text, uuid, boolean, text) from public, anon;
revoke all on function public.admin_import_deletions(integer) from public, anon;

grant execute on function public.admin_import_delete_preview(uuid) to authenticated;
grant execute on function public.admin_import_source_items(uuid, integer, integer) to authenticated;
grant execute on function public.admin_delete_import_source(uuid, boolean, text) to authenticated;
grant execute on function public.admin_delete_import_item(text, uuid, boolean, text) to authenticated;
grant execute on function public.admin_import_deletions(integer) to authenticated;
