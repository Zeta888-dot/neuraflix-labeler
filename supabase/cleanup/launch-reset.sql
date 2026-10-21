-- ============================================================================
-- NeuraFlix Labeler: launch reset
-- REVIEW ONLY. THIS IS NOT A MIGRATION. NEVER RUN IT AS PART OF A DEPLOY.
-- ============================================================================
-- Purpose
--   Remove sample content, confirmed test submissions and their review
--   history before real contributors start using the labeler.
--
-- Storage warning
--   Run `npm run purge:ocr` BEFORE this file and wait for it to finish.
--   This file deletes ocr_pages and ocr_lines rows, which are the only map to
--   the image objects in the `ocr-lines` bucket. Deleting the rows first
--   leaves orphaned Storage objects that are hard to identify later.
--
-- Safety model
--   - Sample rows are matched only by source = 'sample' on the two item tables.
--   - Test submissions, review_log rows and OCR pages are matched only by the
--     explicit UUID lists in section 1. The lists are empty by default.
--   - Nothing is selected by status, date, contributor or "looks like a test".
--   - The transaction prints every row count it will remove before deleting.
--   - The transaction ends with ROLLBACK by default.
--
-- Never run this against real contributor data. If real work shares the
-- database, fill in the explicit id blocks below for test rows only, run the
-- whole file once with the final ROLLBACK, inspect the counts, and only then
-- change the last statement to COMMIT.
-- ============================================================================


begin;

-- ----------------------------------------------------------------------------
-- 1. Explicit test row ids. Empty by default. Add ids only after confirming
--    each row is test data. Use exact UUIDs, one per line.
-- ----------------------------------------------------------------------------
create temp table _launch_reset_instruction_translation_ids (
  id uuid primary key
) on commit drop;

create temp table _launch_reset_conversation_translation_ids (
  id uuid primary key
) on commit drop;

create temp table _launch_reset_text_submission_ids (
  id uuid primary key
) on commit drop;

create temp table _launch_reset_ocr_page_ids (
  id uuid primary key
) on commit drop;

create temp table _launch_reset_review_log_ids (
  id uuid primary key
) on commit drop;

-- Instruction translation test rows:
-- insert into _launch_reset_instruction_translation_ids (id) values
--   ('00000000-0000-0000-0000-000000000000');

-- Conversation translation test rows:
-- insert into _launch_reset_conversation_translation_ids (id) values
--   ('00000000-0000-0000-0000-000000000000');

-- Plain text test rows:
-- insert into _launch_reset_text_submission_ids (id) values
--   ('00000000-0000-0000-0000-000000000000');

-- OCR test pages (their lines cascade):
-- insert into _launch_reset_ocr_page_ids (id) values
--   ('00000000-0000-0000-0000-000000000000');

-- Any remaining review_log test rows not already covered by the ids above:
-- insert into _launch_reset_review_log_ids (id) values
--   ('00000000-0000-0000-0000-000000000000');


-- ----------------------------------------------------------------------------
-- 2. Preview: every count below is the number the matching DELETE removes.
--    Save this output before changing the final statement to COMMIT.
-- ----------------------------------------------------------------------------
with sample_instruction_items as (
  select i.id from public.instruction_items i where i.source = 'sample'
),
sample_conversation_items as (
  select i.id from public.conversation_items i where i.source = 'sample'
),
sample_item_ids as (
  select id from sample_instruction_items
  union
  select id from sample_conversation_items
)
select 'instruction_translations (sample items)' as table_name,
       count(*) as rows_to_delete
  from public.instruction_translations t
 where t.item_id in (select id from sample_instruction_items)
union all
select 'conversation_translations (sample items)',
       count(*)
  from public.conversation_translations t
 where t.item_id in (select id from sample_conversation_items)
union all
select 'instruction_translations (explicit ids)',
       count(*)
  from public.instruction_translations t
 where t.id in (select id from _launch_reset_instruction_translation_ids)
union all
select 'conversation_translations (explicit ids)',
       count(*)
  from public.conversation_translations t
 where t.id in (select id from _launch_reset_conversation_translation_ids)
union all
select 'text_submissions (explicit ids)',
       count(*)
  from public.text_submissions t
 where t.id in (select id from _launch_reset_text_submission_ids)
union all
select 'ocr_pages (explicit ids)',
       count(*)
  from public.ocr_pages p
 where p.id in (select id from _launch_reset_ocr_page_ids)
union all
select 'ocr_lines (cascade from explicit pages)',
       count(*)
  from public.ocr_lines l
 where l.page_id in (select id from _launch_reset_ocr_page_ids)
union all
select 'claims (sample items)',
       count(*)
  from public.claims c
 where c.item_id in (select id from sample_item_ids)
union all
select 'report_issues (sample items)',
       count(*)
  from public.report_issues r
 where r.item_id in (select id from sample_item_ids)
union all
select 'review_log (all removed content)',
       count(*)
  from public.review_log r
 where r.id in (select id from _launch_reset_review_log_ids)
    or r.item_id in (select id from sample_item_ids)
    or r.item_id in (select id from _launch_reset_instruction_translation_ids)
    or r.item_id in (select id from _launch_reset_conversation_translation_ids)
    or r.item_id in (select id from _launch_reset_text_submission_ids)
    or r.item_id in (select id from _launch_reset_ocr_page_ids)
union all
select 'instruction_items (source = sample)',
       count(*)
  from public.instruction_items i
 where i.source = 'sample'
union all
select 'conversation_items (source = sample)',
       count(*)
  from public.conversation_items i
 where i.source = 'sample'
 order by table_name;


-- ----------------------------------------------------------------------------
-- 3. Delete review history first. review_log has no foreign key to any item,
--    translation, text or OCR table, so it must be removed explicitly.
-- ----------------------------------------------------------------------------
with deleted as (
  delete from public.review_log r
   where r.id in (select id from _launch_reset_review_log_ids)
      or r.item_id in (
           select i.id from public.instruction_items i where i.source = 'sample'
           union
           select i.id from public.conversation_items i where i.source = 'sample'
           union
           select id from _launch_reset_instruction_translation_ids
           union
           select id from _launch_reset_conversation_translation_ids
           union
           select id from _launch_reset_text_submission_ids
           union
           select id from _launch_reset_ocr_page_ids
         )
  returning r.id
)
select 'review_log' as table_name, count(*) as deleted_rows from deleted;


-- ----------------------------------------------------------------------------
-- 4. Delete claims and report issues for sample items. Neither table has a
--    foreign key to the item tables, so cascade does not cover them.
-- ----------------------------------------------------------------------------
with deleted as (
  delete from public.claims c
   where c.item_id in (
           select i.id from public.instruction_items i where i.source = 'sample'
           union
           select i.id from public.conversation_items i where i.source = 'sample'
         )
  returning c.id
)
select 'claims' as table_name, count(*) as deleted_rows from deleted;

with deleted as (
  delete from public.report_issues r
   where r.item_id in (
           select i.id from public.instruction_items i where i.source = 'sample'
           union
           select i.id from public.conversation_items i where i.source = 'sample'
         )
  returning r.id
)
select 'report_issues' as table_name, count(*) as deleted_rows from deleted;


-- ----------------------------------------------------------------------------
-- 5. Delete explicit test submissions.
-- ----------------------------------------------------------------------------
with deleted as (
  delete from public.instruction_translations t
   where t.id in (select id from _launch_reset_instruction_translation_ids)
  returning t.id
)
select 'instruction_translations (explicit ids)' as table_name,
       count(*) as deleted_rows
  from deleted;

with deleted as (
  delete from public.conversation_translations t
   where t.id in (select id from _launch_reset_conversation_translation_ids)
  returning t.id
)
select 'conversation_translations (explicit ids)' as table_name,
       count(*) as deleted_rows
  from deleted;

with deleted as (
  delete from public.text_submissions t
   where t.id in (select id from _launch_reset_text_submission_ids)
  returning t.id
)
select 'text_submissions (explicit ids)' as table_name,
       count(*) as deleted_rows
  from deleted;

with deleted as (
  delete from public.ocr_pages p
   where p.id in (select id from _launch_reset_ocr_page_ids)
  returning p.id
)
select 'ocr_pages (explicit ids)' as table_name,
       count(*) as deleted_rows
  from deleted;


-- ----------------------------------------------------------------------------
-- 6. Delete sample translations, then the sample items themselves. The item
--    delete would cascade the translations, but deleting them first keeps the
--    counts explicit and matches the preview above.
-- ----------------------------------------------------------------------------
with deleted as (
  delete from public.instruction_translations t
   where t.item_id in (
           select i.id from public.instruction_items i where i.source = 'sample'
         )
  returning t.id
)
select 'instruction_translations (sample items)' as table_name,
       count(*) as deleted_rows
  from deleted;

with deleted as (
  delete from public.conversation_translations t
   where t.item_id in (
           select i.id from public.conversation_items i where i.source = 'sample'
         )
  returning t.id
)
select 'conversation_translations (sample items)' as table_name,
       count(*) as deleted_rows
  from deleted;

with deleted as (
  delete from public.instruction_items i
   where i.source = 'sample'
  returning i.id
)
select 'instruction_items' as table_name, count(*) as deleted_rows from deleted;

with deleted as (
  delete from public.conversation_items i
   where i.source = 'sample'
  returning i.id
)
select 'conversation_items' as table_name, count(*) as deleted_rows from deleted;


-- ----------------------------------------------------------------------------
-- 7. Turn self-review off and print the final settings.
-- ----------------------------------------------------------------------------
update public.app_settings s
   set value = 'false',
       updated_at = now()
 where s.key = 'allow_self_review';

select key, value, updated_at
  from public.app_settings
 where key in ('ocr_quota_mb', 'allow_self_review')
 order by key;


-- ----------------------------------------------------------------------------
-- 8. Default outcome: roll back everything.
--    Change this to COMMIT only after reviewing the preview counts, the
--    deleted-row counts, the final settings, and after `npm run purge:ocr`
--    has completed and its storage report is saved.
-- ----------------------------------------------------------------------------
rollback;
