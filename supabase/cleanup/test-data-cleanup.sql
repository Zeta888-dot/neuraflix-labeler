-- ============================================================================
-- NeuraFlix Labeler: test OCR page cleanup
-- REVIEW ONLY. THIS IS NOT A MIGRATION.
-- ============================================================================
-- Purpose
--   Remove explicitly confirmed test OCR pages from Postgres and produce the
--   exact Storage object list that needs separate manual cleanup.
--
-- This file does NOT:
--   - delete Storage objects
--   - delete auth users, profiles or roles
--   - delete app_settings
--   - delete instruction, conversation or plain text records
--   - delete approved rows merely because they are approved
--   - use TRUNCATE or an unrestricted DELETE
--
-- Safety model
--   - The candidate list is an explicit page UUID allowlist.
--   - Every candidate starts with owner_confirmed = false.
--   - Every guard raises an exception before any DELETE when a candidate is
--     missing, unconfirmed, inconsistent, or has unresolved dependants.
--   - The transaction ends with ROLLBACK by default.
--   - The only known candidate is the page from the observed L6 export dry
--     run. It is not tagged as test data anywhere in the repository, so the
--     owner must confirm it and add any other confirmed test page UUIDs.
--
-- Before running
--   1. Read Section 1 output and confirm the exact test page UUIDs.
--   2. Set owner_confirmed = true only for pages the owner explicitly confirms.
--   3. Run the whole file with the final ROLLBACK first.
--   4. Inspect the deleted-row counts and the storage path list.
--   5. Change ROLLBACK to COMMIT only after a separate review and after the
--      storage path list has been saved.
--   6. Delete Storage objects separately, only after verifying every object
--      against the saved list. This file never deletes them.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Read-only context. No deletion and no content preview.
-- ----------------------------------------------------------------------------
select 'instruction_items' as table_name,
       coalesce(source, '(null)') as marker,
       count(*) as rows
  from public.instruction_items
 group by source
union all
select 'conversation_items',
       coalesce(source, '(null)'),
       count(*)
  from public.conversation_items
 group by source
 order by table_name, marker;

select status, count(*) as text_rows
  from public.text_submissions
 group by status
 order by status;

select status, count(*) as ocr_pages
  from public.ocr_pages
 group by status
 order by status;

select role, count(*) as profiles
  from public.profiles
 group by role
 order by role;

select key, value, updated_at
  from public.app_settings
 where key in ('ocr_quota_mb', 'allow_self_review')
 order by key;

select bucket_id, count(*) as objects
  from storage.objects
 where bucket_id = 'ocr-lines'
 group by bucket_id;


-- ----------------------------------------------------------------------------
-- 2. Cleanup transaction. It ends with ROLLBACK by default.
-- ----------------------------------------------------------------------------
begin;

create temp table _cleanup_test_ocr_pages (
  page_id uuid primary key,
  evidence text not null check (btrim(evidence) <> ''),
  owner_confirmed boolean not null default false
) on commit drop;

-- Known candidate from the L6 dry-run output in this conversation:
--   page 0d4dd6f2-87b3-4028-94ca-b8e55146a76f, lines 1, 2 and 3
-- The sync dry run reported three approved lines, zero verified locally and
-- three that would download. The repository does not label this page as test
-- data. Owner confirmation is required before owner_confirmed becomes true.
insert into _cleanup_test_ocr_pages (page_id, evidence, owner_confirmed)
values (
  '0d4dd6f2-87b3-4028-94ca-b8e55146a76f',
  'Observed L6 dry-run test page: 3 approved OCR lines, no verified local images, 3 downloads would be required. Owner confirmation required.',
  false
);

-- Add any other explicitly confirmed test OCR pages here, also with
-- owner_confirmed = false until the owner reviews the preview below.
-- insert into _cleanup_test_ocr_pages (page_id, evidence, owner_confirmed)
-- values ('<page_uuid>', '<evidence>', false);

-- After reviewing the preview below, set the confirmed pages to true. Use exact
-- UUIDs. Do not set this to true for every approved page by status alone.
-- update _cleanup_test_ocr_pages
--    set owner_confirmed = true
--  where page_id in ('<page_uuid>');

select page_id, owner_confirmed, evidence
  from _cleanup_test_ocr_pages
 order by page_id;


-- ----------------------------------------------------------------------------
-- 3. Preview candidate pages, lines, review history and related rows.
-- ----------------------------------------------------------------------------
select (select count(*) from public.ocr_pages where status = 'approved')
         as all_approved_ocr_pages,
       (select count(*) from _cleanup_test_ocr_pages)
         as candidate_ocr_pages;

select p.id as page_id,
       p.status as page_status,
       p.contributor_id,
       p.line_count,
       count(l.id) as actual_lines,
       count(*) filter (where l.status = 'approved') as approved_lines,
       count(*) filter (where l.exported_at is not null) as exported_lines,
       count(*) filter (where l.purged_at is not null) as purged_lines,
       p.created_at
  from _cleanup_test_ocr_pages c
  left join public.ocr_pages p on p.id = c.page_id
  left join public.ocr_lines l on l.page_id = p.id
 group by p.id, p.status, p.contributor_id, p.line_count, p.created_at
 order by p.id;

select l.id as line_id,
       l.page_id,
       l.idx,
       l.status as line_status,
       l.exported_at,
       l.purged_at,
       l.storage_path,
       (o.name is not null) as storage_object_exists
  from _cleanup_test_ocr_pages c
  join public.ocr_lines l on l.page_id = c.page_id
  left join storage.objects o
    on o.bucket_id = 'ocr-lines'
   and o.name = l.storage_path
 order by l.page_id, l.idx;

select r.id as review_log_id,
       r.kind,
       r.item_id,
       r.reviewer_id,
       r.decision,
       r.created_at
  from public.review_log r
  join _cleanup_test_ocr_pages c
    on r.kind = 'ocr'
   and r.item_id = c.page_id
 order by r.created_at, r.id;

select 'claims' as source_table,
       cl.id as row_id,
       cl.kind,
       cl.item_id,
       cl.contributor_id,
       cl.expires_at as related_at
  from public.claims cl
  join _cleanup_test_ocr_pages c on c.page_id = cl.item_id
union all
select 'report_issues',
       ri.id,
       ri.kind,
       ri.item_id,
       ri.contributor_id,
       ri.created_at
  from public.report_issues ri
  join _cleanup_test_ocr_pages c on c.page_id = ri.item_id
 order by source_table, related_at;

select o.name as object_name,
       o.created_at,
       o.updated_at,
       exists (
         select 1
           from public.ocr_lines l
          where l.storage_path = o.name
       ) as referenced_by_ocr_line
  from _cleanup_test_ocr_pages c
  join public.ocr_pages p on p.id = c.page_id
  join storage.objects o
    on o.bucket_id = 'ocr-lines'
   and split_part(o.name, '/', 1) = p.contributor_id::text
   and split_part(o.name, '/', 2) = p.id::text
 order by o.name;


-- ----------------------------------------------------------------------------
-- 4. Guards. Any failure aborts the transaction before the DELETE statements.
-- ----------------------------------------------------------------------------
do $$
declare
  v_unconfirmed integer;
  v_missing integer;
begin
  if not exists (select 1 from _cleanup_test_ocr_pages) then
    raise exception 'CLEANUP_ABORT: no test OCR pages were explicitly listed';
  end if;

  select count(*) into v_unconfirmed
    from _cleanup_test_ocr_pages
   where owner_confirmed = false;

  if v_unconfirmed > 0 then
    raise exception 'CLEANUP_ABORT: % candidate page(s) are not owner_confirmed', v_unconfirmed;
  end if;

  select count(*) into v_missing
    from _cleanup_test_ocr_pages c
    left join public.ocr_pages p on p.id = c.page_id
   where p.id is null;

  if v_missing > 0 then
    raise exception 'CLEANUP_ABORT: % candidate page(s) do not exist', v_missing;
  end if;

  if exists (
    select 1
      from _cleanup_test_ocr_pages c
      join public.ocr_pages p on p.id = c.page_id
     where p.status <> 'approved'
  ) then
    raise exception 'CLEANUP_ABORT: every candidate page must be approved for this cleanup';
  end if;

  if exists (
    select 1
      from _cleanup_test_ocr_pages c
      join public.ocr_pages p on p.id = c.page_id
      left join public.ocr_lines l on l.page_id = p.id
     group by p.id, p.line_count
    having count(l.id) = 0
        or count(l.id) <> p.line_count
  ) then
    raise exception 'CLEANUP_ABORT: a candidate page has no lines or its line_count does not match the stored lines';
  end if;

  if exists (
    select 1
      from _cleanup_test_ocr_pages c
      join public.ocr_pages p on p.id = c.page_id
      join public.ocr_lines l on l.page_id = p.id
     group by p.id
    having count(*) filter (where l.status = 'approved') = 0
  ) then
    raise exception 'CLEANUP_ABORT: a candidate page has no approved lines';
  end if;

  if exists (
    select 1
      from _cleanup_test_ocr_pages c
      join public.ocr_pages p on p.id = c.page_id
      join public.ocr_lines l on l.page_id = p.id
     where l.idx < 1
        or l.idx > 40
        or l.storage_path is null
        or l.storage_path !~ format(
             '^%s/%s/%s\.(webp|jpg)$',
             p.contributor_id,
             p.id,
             l.idx
           )
  ) then
    raise exception 'CLEANUP_ABORT: a candidate line has a missing or non-canonical storage_path';
  end if;

  if exists (
    select 1
      from public.claims cl
      join _cleanup_test_ocr_pages c on c.page_id = cl.item_id
  ) then
    raise exception 'CLEANUP_ABORT: claims reference a candidate page UUID; resolve them first';
  end if;

  if exists (
    select 1
      from public.report_issues ri
      join _cleanup_test_ocr_pages c on c.page_id = ri.item_id
  ) then
    raise exception 'CLEANUP_ABORT: report_issues reference a candidate page UUID; resolve them first';
  end if;

  if exists (
    select 1
      from storage.objects o
      join public.ocr_pages p
        on split_part(o.name, '/', 1) = p.contributor_id::text
       and split_part(o.name, '/', 2) = p.id::text
      join _cleanup_test_ocr_pages c on c.page_id = p.id
     where o.bucket_id = 'ocr-lines'
       and not exists (
         select 1
           from public.ocr_lines l
          where l.storage_path = o.name
       )
  ) then
    raise exception 'CLEANUP_ABORT: unreferenced Storage object(s) exist under a candidate page prefix; record or resolve them first';
  end if;
end
$$;


-- ----------------------------------------------------------------------------
-- 5. Capture the Storage paths before deleting the database rows.
--    Save this result. The database rows are the only map to these objects.
-- ----------------------------------------------------------------------------
create temp table _cleanup_storage_paths on commit drop as
select l.page_id,
       l.idx,
       l.storage_path
  from public.ocr_lines l
  join _cleanup_test_ocr_pages c on c.page_id = l.page_id
 order by l.page_id, l.idx;

select page_id, idx, storage_path
  from _cleanup_storage_paths
 order by page_id, idx;


-- ----------------------------------------------------------------------------
-- 6. Delete only the dependent database rows for the confirmed pages.
--    Storage objects are deliberately not touched.
-- ----------------------------------------------------------------------------
with deleted as (
  delete from public.review_log r
   using _cleanup_test_ocr_pages c
   where r.kind = 'ocr'
     and r.item_id = c.page_id
  returning r.id
)
select 'review_log' as table_name, count(*) as deleted_rows
  from deleted;

with deleted as (
  delete from public.ocr_lines l
   using _cleanup_test_ocr_pages c
   where l.page_id = c.page_id
  returning l.id
)
select 'ocr_lines' as table_name, count(*) as deleted_rows
  from deleted;

with deleted as (
  delete from public.ocr_pages p
   using _cleanup_test_ocr_pages c
   where p.id = c.page_id
  returning p.id
)
select 'ocr_pages' as table_name, count(*) as deleted_rows
  from deleted;


-- ----------------------------------------------------------------------------
-- 7. Post-checks. They must all pass before a COMMIT is allowed.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
      from public.ocr_pages p
      join _cleanup_test_ocr_pages c on c.page_id = p.id
  ) then
    raise exception 'CLEANUP_ABORT: a candidate page still exists';
  end if;

  if exists (
    select 1
      from public.ocr_lines l
      join _cleanup_test_ocr_pages c on c.page_id = l.page_id
  ) then
    raise exception 'CLEANUP_ABORT: a candidate line still exists';
  end if;

  if exists (
    select 1
      from public.review_log r
      join _cleanup_test_ocr_pages c
        on r.kind = 'ocr'
       and r.item_id = c.page_id
  ) then
    raise exception 'CLEANUP_ABORT: a candidate review_log row still exists';
  end if;

  if (select count(*) from public.app_settings
       where key in ('ocr_quota_mb', 'allow_self_review')) <> 2 then
    raise exception 'CLEANUP_ABORT: a protected app_settings key is missing';
  end if;
end
$$;

select key, value, updated_at
  from public.app_settings
 where key in ('ocr_quota_mb', 'allow_self_review')
 order by key;

select role, count(*) as profiles
  from public.profiles
 group by role
 order by role;


-- ----------------------------------------------------------------------------
-- 8. Default outcome: roll back everything.
--    Change this to COMMIT only after reviewing the preview, the deleted-row
--    counts, the saved Storage path list, and a separate Storage cleanup plan.
-- ----------------------------------------------------------------------------
rollback;
