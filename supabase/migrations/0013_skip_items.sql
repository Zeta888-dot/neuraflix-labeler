-- 0013_skip_items.sql
-- Per-contributor skip memory for instruction and conversation items.
-- Before this, Skip released the claim and claim_next picked the same oldest
-- open row again. Now a skip is remembered for that contributor, claim_next
-- excludes it, and Start over clears the list.
--
-- Safe to run again. This repo never applies it.

-- ----------------------------------------------------------------------------
-- 1. skips: one row per contributor, kind and item. Closed to direct writes;
--    the security definer functions below are the only way in.
-- ----------------------------------------------------------------------------
create table if not exists public.skips (
  kind text not null check (kind in ('instruction', 'conversation')),
  item_id uuid not null,
  contributor_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (kind, item_id, contributor_id)
);

alter table public.skips enable row level security;

comment on table public.skips is
  'Items a contributor skipped. claim_next excludes them for that contributor until Start over.';

revoke all on table public.skips from public, anon, authenticated;

create index if not exists skips_contributor_kind_idx
  on public.skips (contributor_id, kind);


-- ----------------------------------------------------------------------------
-- 2. skip_item(kind, item_id): remember the skip and drop the caller's claim.
-- ----------------------------------------------------------------------------
create or replace function public.skip_item(p_kind text, p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_exists boolean;
begin
  if v_uid is null then
    raise exception 'skip_item requires an authenticated session';
  end if;

  if p_kind not in ('instruction', 'conversation') then
    raise exception 'skip_item: unknown kind %', p_kind;
  end if;

  if p_kind = 'instruction' then
    select exists (
      select 1 from public.instruction_items i where i.id = p_item_id
    ) into v_exists;
  else
    select exists (
      select 1 from public.conversation_items i where i.id = p_item_id
    ) into v_exists;
  end if;

  if not v_exists then
    raise exception 'skip_item: unknown item %', p_item_id;
  end if;

  insert into public.skips (kind, item_id, contributor_id)
  values (p_kind, p_item_id, v_uid)
  on conflict (kind, item_id, contributor_id) do nothing;

  delete from public.claims c
   where c.kind = p_kind
     and c.item_id = p_item_id
     and c.contributor_id = v_uid;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. clear_skips(kind): Start over. Returns how many rows were cleared.
-- ----------------------------------------------------------------------------
create or replace function public.clear_skips(p_kind text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'clear_skips requires an authenticated session';
  end if;

  if p_kind not in ('instruction', 'conversation') then
    raise exception 'clear_skips: unknown kind %', p_kind;
  end if;

  delete from public.skips s
   where s.kind = p_kind
     and s.contributor_id = v_uid;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. skipped_item_count(kind): skipped rows that are still open and untranslated
--    by the caller. The empty state uses this to offer Start over.
-- ----------------------------------------------------------------------------
create or replace function public.skipped_item_count(p_kind text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'skipped_item_count requires an authenticated session';
  end if;

  if p_kind not in ('instruction', 'conversation') then
    raise exception 'skipped_item_count: unknown kind %', p_kind;
  end if;

  if p_kind = 'instruction' then
    select count(*)
      into v_count
      from public.skips s
      join public.instruction_items i on i.id = s.item_id
     where s.kind = p_kind
       and s.contributor_id = v_uid
       and i.status = 'open'
       and not exists (
         select 1
           from public.instruction_translations t
          where t.item_id = i.id
            and t.contributor_id = v_uid
       );
  else
    select count(*)
      into v_count
      from public.skips s
      join public.conversation_items i on i.id = s.item_id
     where s.kind = p_kind
       and s.contributor_id = v_uid
       and i.status = 'open'
       and not exists (
         select 1
           from public.conversation_translations t
          where t.item_id = i.id
            and t.contributor_id = v_uid
       );
  end if;

  return v_count;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. claim_next(kind): same as 0003, plus the caller's skips are excluded in
--    both the renewal path and the pick path.
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
    --    row for the same item. A skipped item is never renewed.
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
       and not exists (
         select 1
           from public.skips s
          where s.kind = p_kind
            and s.item_id = i.id
            and s.contributor_id = v_uid
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
         or exists (
           select 1
             from public.skips s
            where s.kind = p_kind
              and s.item_id = c.item_id
              and s.contributor_id = v_uid
         )
       );

    -- 3. Oldest open item this user has not translated, skipped or lost to
    --    another live claim.
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
           from public.skips s
          where s.kind = p_kind
            and s.item_id = i.id
            and s.contributor_id = v_uid
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
    -- Conversation items mirror the instruction logic.
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
       and not exists (
         select 1
           from public.skips s
          where s.kind = p_kind
            and s.item_id = i.id
            and s.contributor_id = v_uid
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
         or exists (
           select 1
             from public.skips s
            where s.kind = p_kind
              and s.item_id = c.item_id
              and s.contributor_id = v_uid
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
           from public.skips s
          where s.kind = p_kind
            and s.item_id = i.id
            and s.contributor_id = v_uid
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
-- 6. Grants: authenticated only. Dropping claim_next dropped its grants too.
-- ----------------------------------------------------------------------------
revoke all on function public.claim_next(text) from public, anon;
revoke all on function public.skip_item(text, uuid) from public, anon;
revoke all on function public.clear_skips(text) from public, anon;
revoke all on function public.skipped_item_count(text) from public, anon;

grant execute on function public.claim_next(text) to authenticated;
grant execute on function public.skip_item(text, uuid) to authenticated;
grant execute on function public.clear_skips(text) to authenticated;
grant execute on function public.skipped_item_count(text) to authenticated;
