# Admin upload plan (L8)

Status: plan only. No application code is written in this session. L8a starts only after approval.

## 1. Audit findings

- Imports are local scripts today: `scripts/import-english.ts` and `scripts/import-conversations.ts`. They read the service role key from `.env.local`, batch 200 rows, hash with `englishHashSource` / `conversationHashSource`, skip existing `english_hash` values, and insert `status = 'open'`. The admin page only shows copyable commands.
- The browser never imports text. There is no resumable file position, no per-row error report, and no storage meter for Postgres rows.
- OCR upload already runs in the browser: segment, review lines, encode grayscale WebP/JPEG, upload line crops, then `ocr_create_page` and `ocr_finalize_page`. The original page is never uploaded. Paths are `<user uuid>/<page uuid>/<idx>.<webp|jpg>`. Direct table writes are revoked.
- The OCR quota is `app_settings.ocr_quota_mb` (default 400 MB). Warn at 60 percent, block above 80 percent. `ocr_create_page` also enforces 20 pages per 24 hours and 1 to 40 lines per page.
- Export reads approved rows only. Sync sets `ocr_lines.exported_at`. Purge sets `ocr_lines.purged_at` and deletes storage objects. None of them change item status or import counters.
- `ocr_pages.contributor_id` is both the storage owner and the export credit today. Sync and purge validate that the storage path owner equals `contributor_id`. Pool pages need a separate uploader and labeler, so credit must become a separate field.
- Admin authorization is checked three times: the page (`getSessionUser` plus `getProfile`), server actions (`requireAdmin`), and security-definer RPCs (`is_admin()`).
- `DESIGN.md` is not present. `DESIGN-vercel.md` and the existing `Card`, `Badge`, `Button`, `PageHeader`, `EmptyState` primitives are the visual source.
- The repo already has migrations `0008_admin_settings.sql` and `0009_hardening.sql`. New migrations start at `0010`. `HANDOFF.md` says 0009 may not be applied yet.

## 2. Scope

In scope:

- Admin browser upload for instruction JSONL, conversation JSONL, and OCR page images.
- Chunked, resumable loading with a visible source file id, byte offset, and chunk content hash.
- Storage and queue meters, configurable auto-pause thresholds, and a manual "Load next chunk" action.
- An OCR pool: admin publishes segmented pages, labelers claim pages, label them, and submit them to the existing review queue.
- Export credit for pool pages goes to the labeler, while the storage path stays under the admin uploader.
- Pipeline counters that show how import, export, sync, and purge differ.

Out of scope:

- Bulk plain text import. Plain text stays contributor-submitted because it has a different rights, attribution, and hash flow.
- Replacing the local scripts. They keep working unchanged.
- Changing the normal contributor OCR upload flow or its quota.
- A new review UI. Pool pages use the existing OCR review queue.
- Hugging Face push and automatic storage deletion.

## 3. Data model and migrations

### 3.1 Migration 0010: text import foundation

Tables:

```sql
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('instruction', 'conversation', 'ocr_page')),
  label text,
  chunk_size integer not null check (chunk_size between 1 and 2000),
  total_files integer check (total_files is null or total_files >= 1),
  processed_files integer not null default 0 check (processed_files >= 0),
  status text not null default 'active'
    check (status in ('active', 'paused', 'completed', 'abandoned')),
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.import_sources (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.import_batches (id) on delete cascade,
  kind text not null check (kind in ('instruction', 'conversation', 'ocr_page')),
  file_name text not null check (char_length(file_name) between 1 and 255),
  file_size bigint not null check (file_size > 0),
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  source_label text,
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

create table public.import_source_chunks (
  id uuid primary key default gen_random_uuid(),
  import_source_id uuid not null references public.import_sources (id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  start_offset bigint not null check (start_offset >= 0),
  end_offset bigint not null check (end_offset >= start_offset),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  loaded_rows integer not null default 0,
  skipped_rows integer not null default 0,
  invalid_rows integer not null default 0,
  created_at timestamptz not null default now(),
  unique (import_source_id, chunk_index)
);

create table public.import_source_errors (
  id bigint generated always as identity primary key,
  import_source_id uuid not null references public.import_sources (id) on delete cascade,
  row_index bigint not null check (row_index >= 1),
  reason text not null check (char_length(reason) between 1 and 120),
  detail text check (detail is null or char_length(detail) <= 300),
  created_at timestamptz not null default now(),
  unique (import_source_id, row_index)
);
```

Item columns:

```sql
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
```

The existing `english_hash` unique indexes stay authoritative for duplicate detection. `source_row_index` is provenance, not a second duplicate rule.

Settings:

```sql
insert into public.app_settings (key, value) values
  ('db_quota_mb', '500'),
  ('upload_chunk_text_rows', '200'),
  ('upload_chunk_ocr_pages', '20'),
  ('upload_pause_open_instructions', '1000'),
  ('upload_pause_open_conversations', '1000'),
  ('upload_pause_open_ocr_pages', '60'),
  ('upload_pause_db_percent', '75'),
  ('upload_pause_ocr_percent', '80'),
  ('ocr_pool_claim_minutes', '120'),
  ('ocr_pool_heartbeat_minutes', '15')
on conflict (key) do nothing;
```

RPCs in 0010:

- `admin_import_create_source(p_kind, p_file_name, p_file_size, p_file_hash, p_source_label, p_target_count, p_chunk_size)` returns the source id, batch id, resume state, next offset, next row, and counters. It validates kind, a file size of 1 byte to 200 MB, a 64 hex file hash, a source label of 1 to 120 characters, a target count of 1 to 5, and a chunk size of 20 to 1,000. It inserts a batch when needed. If `(kind, file_hash)` exists, it returns the existing source. A completed source returns `resumed = false`; an active or paused source returns `resumed = true`.
- `admin_import_text_chunk(p_source_id, p_chunk_index, p_start_offset, p_end_offset, p_content_hash, p_rows)` returns `loaded`, `skipped`, `invalid`, `next_offset`, `next_row`, `status`, and `already_committed`.
- `admin_import_set_status(p_source_id, p_status)` allows `paused`, `abandoned`, or `completed`. `completed` is refused when `next_offset < file_size`.
- `admin_import_sources(p_limit)` returns recent sources with progress and counts.
- `admin_import_errors(p_source_id, p_offset, p_limit)` returns the error report rows.
- `admin_upload_status()` returns database bytes and quota, OCR storage bytes and quota, open instruction and conversation counts, and the threshold values as jsonb.

Chunk rules:

- Only an admin can call these functions. Every function checks `is_admin()`.
- The source row is locked with `for update`.
- The function checks the chunk table first. If a chunk with the same index and content hash already exists, it returns the stored counts and does not insert again, even after the source advanced. A different hash raises `IMPORT_CHUNK_CONFLICT`.
- `p_chunk_index` must equal `next_chunk_index`, and `p_start_offset` must equal `next_offset`.
- `p_end_offset` must be greater than `p_start_offset` and at most `file_size`.
- `p_content_hash` is SHA-256 hex of the exact bytes in the slice.
- `p_rows` is an array of `{ "raw": "..." }` objects. The server derives `row_index` from `next_row + ordinality`; it does not trust a client row number.
- The function refuses a chunk that would take the source above 250,000 rows or above 200 MB. A single raw row is capped at 512 KB, and a chunk is capped at 1 MB of raw bytes.
- The whole chunk is one transaction. A failed chunk leaves `next_offset`, `next_row`, and `next_chunk_index` unchanged, so the browser can retry the same slice.
- The function parses and validates every raw row again in SQL. It computes `english_hash` with a shared helper and inserts with `on conflict (english_hash) do nothing`.
- Inserted rows get `import_source_id`, `source_row_index`, `source` (row source or the file source label), and `target_count`.
- Duplicate hashes count as `skipped`, not invalid. Invalid rows count as `invalid` and write one `import_source_errors` row with a short reason and a 300 character excerpt.
- When `p_end_offset >= file_size`, the source becomes `completed`, `completed_at` is set, and the parent batch gets `processed_files = 1` and `status = 'completed'`.

Hash helper:

```sql
create or replace function public.import_english_hash(p_kind text, p_english jsonb)
returns text
language sql
immutable
security definer
set search_path = public
as $$
  select case p_kind
    when 'instruction' then encode(sha256(convert_to(
      btrim(regexp_replace(normalize(coalesce(p_english ->> 'instruction', ''), NFC), '[[:space:]]+', ' ', 'g'))
      || E'\n' ||
      btrim(regexp_replace(normalize(coalesce(p_english ->> 'input', ''), NFC), '[[:space:]]+', ' ', 'g')),
      'UTF8')), 'hex')
    when 'conversation' then encode(sha256(convert_to((
      select string_agg(
        btrim(regexp_replace(normalize(coalesce(t.turn ->> 'role', ''), NFC), '[[:space:]]+', ' ', 'g'))
        || E'\n' ||
        btrim(regexp_replace(normalize(coalesce(t.turn ->> 'content', ''), NFC), '[[:space:]]+', ' ', 'g')),
        E'\n\n' order by t.ord)
      from jsonb_array_elements(p_english -> 'turns') with ordinality as t(turn, ord)
    ), 'UTF8')), 'hex')
  end
$$;
```

This mirrors the strings in `0002_instructions.sql`, `0004_conversations.sql`, and `src/lib/khowar.ts`. A test must import the same line through the local script and the browser and confirm the second path skips it as a duplicate.

RLS and grants in 0010:

- Enable RLS on `import_batches`, `import_sources`, `import_source_chunks`, and `import_source_errors`.
- Add admin-only select policies using `is_admin()`.
- Revoke insert, update, and delete from `anon` and `authenticated`. The security-definer RPCs are the only writers.
- Grant select on the four tables to `authenticated`, with RLS limiting rows to admins.
- Revoke all on the new functions from `public` and `anon`, then grant execute to `authenticated`.

### 3.2 Migration 0011: OCR pool

Columns:

```sql
alter table public.ocr_pages
  add column if not exists origin text not null default 'contributor',
  add column if not exists import_source_id uuid
    references public.import_sources (id) on delete set null,
  add column if not exists assigned_to uuid
    references public.profiles (id) on delete set null,
  add column if not exists assigned_at timestamptz,
  add column if not exists assignment_expires_at timestamptz,
  add column if not exists labeled_by uuid
    references public.profiles (id) on delete set null,
  add column if not exists submitted_at timestamptz,
  add column if not exists published_at timestamptz;

alter table public.ocr_pages
  drop constraint if exists ocr_pages_origin_check;
alter table public.ocr_pages
  add constraint ocr_pages_origin_check
  check (origin in ('contributor', 'admin_pool'));

alter table public.ocr_pages
  drop constraint if exists ocr_pages_status_check;
alter table public.ocr_pages
  add constraint ocr_pages_status_check
  check (status in ('uploading', 'open', 'claimed', 'submitted', 'approved', 'rejected', 'failed'));
```

`ocr_pages.contributor_id` remains the storage owner. For pool pages it is the admin who uploaded the images. `labeled_by` is the labeler and the export credit.

Line changes:

```sql
alter table public.ocr_lines
  drop constraint if exists ocr_lines_status_check;
alter table public.ocr_lines
  add constraint ocr_lines_status_check
  check (status in ('open', 'submitted', 'approved', 'rejected'));

alter table public.ocr_lines
  drop constraint if exists ocr_lines_label_check;
alter table public.ocr_lines
  add constraint ocr_lines_label_check
  check (
    (status = 'open' and label is null)
    or (
      status = 'rejected'
      and (label is null or char_length(btrim(label)) between 1 and 400)
    )
    or (
      status in ('submitted', 'approved')
      and label is not null
      and char_length(btrim(label)) between 1 and 400
    )
  );
```

A rejected line may have a null label because an unreadable pool line becomes rejected at submit time. A rejected contributor line keeps its label. Submitted and approved lines always need a label.

Preflight before applying 0011:

```sql
select count(*) from public.ocr_lines where label is null or btrim(label) = '';
```

The count must be zero. Existing rows already satisfy the 0006 label check, so this is a safety check.

Indexes:

```sql
create index if not exists ocr_pages_pool_queue_idx
  on public.ocr_pages (status, published_at, created_at)
  where origin = 'admin_pool';

create index if not exists ocr_pages_assignment_idx
  on public.ocr_pages (assigned_to, assignment_expires_at)
  where origin = 'admin_pool';
```

Table policies:

```sql
drop policy if exists "ocr_pages: pool assignee read" on public.ocr_pages;
create policy "ocr_pages: pool assignee read" on public.ocr_pages
  for select to authenticated
  using (
    origin = 'admin_pool'
    and (
      assigned_to = (select auth.uid())
      or labeled_by = (select auth.uid())
    )
  );

drop policy if exists "ocr_lines: pool assignee read" on public.ocr_lines;
create policy "ocr_lines: pool assignee read" on public.ocr_lines
  for select to authenticated
  using (
    exists (
      select 1
      from public.ocr_pages p
      where p.id = public.ocr_lines.page_id
        and p.origin = 'admin_pool'
        and (
          p.assigned_to = (select auth.uid())
          or p.labeled_by = (select auth.uid())
        )
    )
  );
```

Storage policy:

```sql
drop policy if exists "ocr-lines: pool read" on storage.objects;
create policy "ocr-lines: pool read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ocr-lines'
    and exists (
      select 1
      from public.ocr_pages p
      where p.id::text = (storage.foldername(name))[2]
        and p.origin = 'admin_pool'
        and (p.assigned_to = (select auth.uid()) or p.labeled_by = (select auth.uid()))
    )
  );
```

The existing own-prefix and staff read policies remain. The new policy lets a labeler sign line images only for a page assigned to them or labeled by them.

RPCs in 0011:

- `admin_ocr_create_batch(p_label, p_total_files, p_chunk_size)` creates an `ocr_page` batch with 1 to 200 files and a chunk size of 5 to 40.
- `admin_ocr_register_source(p_batch_id, p_file_name, p_file_size, p_file_hash)` creates or returns an `import_sources` row of kind `ocr_page`. It validates an image size of 1 byte to 15 MB and a 64 hex file hash.
- `admin_ocr_create_page(p_import_source_id, p_label, p_line_count, p_total_bytes)` checks admin, quota, and the open pool threshold, then inserts an `ocr_pages` row with `origin = 'admin_pool'`, `contributor_id = auth.uid()`, and `status = 'uploading'`. It validates 1 to 40 lines and 1 to 80,000,000 total bytes. The threshold count includes `uploading` and `open` pool pages, so a 20 page chunk reserves its slots. If the source still points to an `uploading` page older than one hour, that page is marked failed and the source is cleared before a new page is created.
- `admin_ocr_finalize_page(p_page_id, p_lines)` validates every path starts with `<auth.uid()>/<page_id>/`, validates the image metadata, repeats the open pool threshold check excluding the current page, inserts `ocr_lines` with `label = null` and `status = 'open'`, then sets the page to `open` and `published_at = now()`. A full pool raises `OCR_POOL_FULL` and the browser aborts the page. It updates the batch `processed_files`.
- `admin_ocr_abort_page(p_page_id)` marks an unfinished pool page `failed`, clears `import_sources.page_id`, returns the source to `active` with the error text, and updates the batch `processed_files`. This lets the admin retry the same image after the browser removed the uploaded crops.
- `admin_ocr_pool_status()` returns counts for uploading, open, claimed, submitted, approved, rejected, and failed pool pages, plus the oldest open age.
- `admin_unassign_ocr_page(p_page_id)` returns a claimed page to `open` and clears the assignment.
- `claim_ocr_page()` returns one page. It first returns the caller's live claim, then releases expired claims, then picks the oldest open page with `for update skip locked`, sets `status = 'claimed'`, `assigned_to`, `assigned_at`, and `assignment_expires_at = now() + claim interval`.
- `extend_ocr_claim(p_page_id)` extends the caller's live claim.
- `release_ocr_claim(p_page_id)` returns the caller's claimed page to `open`.
- `submit_ocr_pool_page(p_page_id, p_lines)` accepts exactly one entry for every open line. Each entry has `idx`, `label`, and `unreadable`. An unreadable line becomes `rejected` with a null label. A labeled line becomes `submitted` with a validated label. At least one labeled line is required. The page becomes `submitted`, `labeled_by = auth.uid()`, and `submitted_at = now()`.

Pool rules:

- Admin pool pages do not count toward the contributor 20 pages per 24 hours limit. They do count toward the OCR storage quota and the open pool threshold.
- The admin uploader is the storage owner. The labeler is the credit owner.
- The original page image is never uploaded. Only line crops are stored.
- A labeler can read only assigned or previously labeled pool pages through RLS and storage policies.
- A normal contributor page keeps `origin = 'contributor'`, `status = 'uploading'` then `'submitted'`, and `labeled_by = null`.
- `ocr_create_page` and `ocr_finalize_page` from 0006 stay unchanged. The new status checks accept their existing values.

### 3.3 Migration 0012: pool review and export credit

Recreate these functions so pool pages behave correctly:

- `review_next('ocr')` orders by `coalesce(p.submitted_at, p.created_at)` and uses `coalesce(p.labeled_by, p.contributor_id)` for the self-review check.
- `review_counts()` uses the same credit expression for the OCR count.
- `review_ocr_page()` uses `coalesce(p.labeled_by, p.contributor_id)` for the self-review check.
- `my_feedback()` returns OCR feedback to `coalesce(p.labeled_by, p.contributor_id) = auth.uid()`.
- `admin_overview()` adds `open` and `claimed` to the OCR page block, adds `open` to the OCR line block, and counts pool pages in `recent_contributors` with `coalesce(labeled_by, contributor_id)`.
- `getOcrReviewLines` and the review UI must accept a rejected line with a null label. The line is shown as "Unreadable" with the reject choice fixed. The reviewer still sends one entry for every line, using an empty label and `reject = true` for the unreadable line.

Export changes in `scripts/`:

- Add `creditContributorId` to `OcrLineRecord` and `OcrExportRecord`.
- `fetchApprovedOcrLines` selects `ocr_pages!inner(id, status, contributor_id, labeled_by)` and sets `contributorId` to the page owner and `creditContributorId` to `coalesce(labeled_by, contributor_id)`.
- `validateOcrRecord` keeps comparing the storage path owner with `contributorId`. This keeps sync and purge unchanged.
- `export-core` uses `creditContributorId` for `contributors.csv` and `OcrExportLine.contributorId`.
- Sync and purge keep using `contributorId` for path validation. No script behavior changes.

### 3.4 Migration 0013: counters and error report

- `admin_pipeline_status()` returns approved instruction translations, approved conversation translations, approved text submissions, approved OCR lines, OCR lines pending sync, OCR lines synced but not purged, OCR lines purged, bytes pending sync, and bytes synced but not purged.
- `admin_import_errors()` gets a stable order and a total count for the CSV download.
- No destructive changes.

## 4. Text upload design

### 4.1 Accepted formats

Instruction JSONL, one JSON object per line:

```json
{"instruction":"Say hello in a friendly way.","response":"Hello! It is good to see you."}
```

- `instruction` is required, string, trimmed, 1 to 20,000 characters.
- `response` is required. `output` works as an alias. String, trimmed, 1 to 20,000 characters.
- `input` is optional, string, at most 20,000 characters.
- `source` is optional, string, at most 120 characters. The file source label is the fallback.
- `target_count` is a file-level setting, integer 1 to 5. It is not read from each row.
- Extra keys are ignored.
- Empty lines are skipped. A line that is not a JSON object, or has a missing or invalid field, is invalid.

Conversation JSONL, one JSON object per line:

```json
{"turns":[{"role":"user","content":"Where can I buy a bus ticket?"},{"role":"assistant","content":"You can buy one at the station counter or on the bus from the driver."}]}
```

- `turns` is required. `messages` works as an alias.
- At least 2 turns, at most 20.
- Roles are `system`, `user`, `assistant`. At most one `system` turn, and only first.
- After an optional system turn, roles alternate user and assistant, start with user, and end with assistant.
- Every content is a non-empty string, trimmed, at most 4,000 characters.
- `source` is optional, string, at most 120 characters.
- `target_count` is a file-level setting, integer 1 to 5.

File rules:

- UTF-8, `.jsonl` only. A UTF-8 BOM is stripped.
- Maximum 200 MB and 250,000 non-empty rows.
- Maximum one raw row of 512 KB after decoding. A row that large is invalid, not a crash.
- The source label is required, 1 to 120 characters. This matches the local scripts.
- A duplicate is a row whose normalized `english_hash` already exists in the item table or earlier in the same file. It is skipped and counted, not invalid.

### 4.2 Chunk reader and resumability

- The browser reads `File.slice(start, end)` and scans raw bytes for `\n`. It never loads the whole file into memory.
- A chunk contains up to the configured number of non-empty rows (default 200, UI range 20 to 1,000), up to 1 MB of raw bytes, and ends on a line boundary.
- `start_offset` is the byte position after the previous newline. `end_offset` is the byte position after the last newline in the chunk, or `file.size` at the end.
- `content_hash` is SHA-256 of the exact bytes in `[start_offset, end_offset)`.
- `file_hash` is a chained SHA-256. Start with `h = SHA-256("neuraflix-upload-v1\n" + file.name + "\n" + file.size)`, then for each 1 MiB block set `h = SHA-256(h bytes || block bytes)`. The final hex value is `file_hash`. It is computed once when the file is selected, with a progress line. It is not a full-file buffer.
- The server stores `id`, `next_offset`, `next_row`, and `next_chunk_index`. On reload, the admin selects the same file again. The browser recomputes `file_hash`, `admin_import_create_source` returns the existing source, and loading continues at `next_offset`.
- The browser cannot reopen a file after a reload without the user selecting it again. The UI states this honestly instead of pretending the handle persists.
- The same source file hash cannot create two sources of the same kind. A completed source shows "Already imported" with its final counters.
- A chunk retry after a network error is safe. The server returns the stored result when the index and content hash match.

### 4.3 Error report

- Each chunk returns the first 20 errors for immediate display.
- The source detail view shows total invalid and skipped counts and a paginated error table.
- "Download CSV" writes `row_index, reason, detail` for invalid rows and `row_index, reason` for duplicate rows. It never includes full row content. Cells are quoted, and a value that starts with `=`, `+`, `-`, or `@` gets a leading apostrophe so a spreadsheet does not execute it.
- Invalid rows do not stop the chunk. The source can complete with invalid and skipped rows. The summary states the real counts.
- Duplicate rows are reported as `duplicate_hash` with no content excerpt.

## 5. OCR pool design

### 5.1 Admin upload

- The admin selects JPG, PNG, or WebP page images. Each image must pass the existing `validatePageFile` rules: at most 15 MB, long edge 600 to 10,000 px.
- The browser segments each page with the existing `PageSegmenter`, then shows the line review. The admin can delete, merge, and split lines. No labels are entered at this stage.
- A page must have 1 to 40 lines. A page with no lines is skipped with an error.
- The admin confirms a rights statement before publishing. The statement is stored as `rights_confirmed = true` on the page.
- The admin processes pages one at a time inside a chunk of 20 pages. This keeps memory bounded. The chunk is a batch of `import_sources` rows, not one giant transaction.
- For each page, `admin_ocr_create_page` reserves the page row, the browser uploads line crops under `<admin uuid>/<page uuid>/<idx>.<ext>`, and `admin_ocr_finalize_page` inserts the open lines and publishes the page.
- If a page fails after some crops were uploaded, the browser removes those objects and calls `admin_ocr_abort_page`. A failed page does not block the rest of the chunk.
- The original page image is never uploaded. Only the encoded line crops are stored.
- The chunk finishes when all selected pages are processed, paused, or failed. "Load next chunk" processes the next 20 selected pages.

### 5.2 Labeler flow

- `/ocr` gets a "Pool pages" card with the open count and a "Start a page" button. The existing upload card and My pages list stay unchanged.
- `claim_ocr_page()` assigns one page for 2 hours. The labeler can extend the claim every 15 minutes while the page is open.
- The labeling view shows one line image, one textarea, the line progress, "Mark unreadable", "Previous", and "Submit page". Enter saves the current line and moves to the next. Drafts are kept in IndexedDB under the pool page id.
- The labeler cannot delete or renumber lines. The admin already reviewed segmentation.
- Submit requires every line to have a label or be marked unreadable, and at least one labeled line. The page enters the existing OCR review queue.
- If the claim expires, the page returns to `open`. The labeler's draft stays in IndexedDB. If the page is still open, the labeler can claim it again. If another labeler took it, the draft is not uploaded.
- Reviewers see pool pages in the same OCR queue. A pool page shows a "Pool" badge and the labeler. Self-review uses `labeled_by`.

### 5.3 Normal upload non-regression

- `ocr_create_page` and `ocr_finalize_page` are not replaced. They continue to create `origin = 'contributor'` pages with labels and `status = 'submitted'`.
- My pages and contributor counts filter on `origin = 'contributor'` and `contributor_id = auth.uid()`, so pool pages uploaded by an admin do not appear in the admin's personal My pages list.
- The contributor 20 pages per 24 hours limit stays in place.
- The contributor storage path policy stays in place.
- The new pool storage policy is additive and only matches `origin = 'admin_pool'`.

## 6. Quota, pause, and counters

### 6.1 Meters

The `/admin/upload` page shows two meters and four queue counts:

| Meter | Source | Warning | Pause |
| --- | --- | --- | --- |
| Postgres | `pg_database_size(current_database())` against `db_quota_mb` | 60 percent | 75 percent |
| OCR storage | `ocr_storage_status()` against `ocr_quota_mb` | 60 percent | 80 percent |
| Open instructions | `instruction_items.status = 'open'` | 800 | 1,000 |
| Open conversations | `conversation_items.status = 'open'` | 800 | 1,000 |
| Open OCR pool pages | `ocr_pages.origin = 'admin_pool' and status = 'open'` | 48 | 60 |
| Claimed OCR pool pages | `ocr_pages.origin = 'admin_pool' and status = 'claimed'` | informational | informational |

All thresholds are read from `app_settings` and returned by `admin_upload_status()` or `admin_ocr_pool_status()`. The browser checks the status before each chunk. The server repeats the check inside the chunk RPC and the OCR create RPC, so a stale browser cannot bypass a pause.

Pause messages are concrete:

- "Open instruction items are at 1,000 of 1,000. Finish or retire items before loading more."
- "The database is at 75 percent of 500 MB. Text rows are not freed by export or purge. Archive rows or raise the plan."
- "OCR storage is at 80 percent of 400 MB. Run npm run sync -- --commit, then npm run purge:ocr -- --commit."
- "Open OCR pool pages are at 60 of 60. Wait for labelers or unassign stale pages."

"Load next chunk" is disabled while paused. "Check again" refreshes the status. The server is the final gate.

### 6.2 Counters

Import counters are historical and append-only:

- `import_sources.loaded_rows`: rows inserted.
- `import_sources.skipped_rows`: duplicate hashes.
- `import_sources.invalid_rows`: rejected rows.
- `import_batches.processed_files`: OCR pages finished or failed.

Pipeline counters are separate:

- Export reads approved rows and writes files. It does not change import counters or item status.
- Sync sets `ocr_lines.exported_at` and downloads images. It does not change import counters or item status.
- Purge sets `ocr_lines.purged_at` and deletes storage objects. It does not change import counters or item status.
- Purging frees OCR storage, not Postgres text rows.
- The admin upload page shows both sets side by side so a purge cannot look like data loss.

## 7. UI screens

All screens use the existing primitives and tokens. Admin routes use the 88rem container from `HANDOFF.md`. No new colors, no eyebrow labels, no em dashes, no emojis.

### `/admin/upload`

- `PageHeader`: "Upload data" with a short description.
- "Storage and queues": two progress bars built like the existing OCR storage card, four queue stat blocks, and a pause banner with the exact reason.
- "Choose a dataset": three cards, "Instructions", "Conversations", "OCR pages". Each card lists the accepted format and a primary "Start" button.
- "Recent uploads": source list with kind badge, file name, status badge, progress bar, loaded, skipped, and invalid counts, and actions "Resume", "Pause", "Stop", "Download errors".
- "Pipeline counters": approved, pending sync, synced, purged, and bytes. A link to the admin page for the export, sync, and purge commands.
- Empty state: "No uploads yet. Choose a dataset above to load the first file." Real counts only.

### Text upload wizard

- Step 1: file picker, source label, target count, chunk size. Shows file name, size, and hash progress.
- Step 2: preview of the first chunk. Valid, duplicate, and invalid counts with the first five reasons.
- Step 3: loading. Primary "Load next chunk", secondary "Pause", ghost "Stop". Progress shows rows loaded, bytes read, and the current source id. The error table updates after every chunk.
- Step 4: summary with final counts and a link back to `/admin/upload`.

### OCR upload wizard

- Step 1: multi-select images, rights checkbox, chunk size. Shows total files, total size, and the OCR storage meter.
- Step 2: page review grid. Each page has a thumbnail, line count, "Edit lines", and "Accept page". Pages with errors show the reason and can be removed.
- Step 3: publishing. One page at a time, with the current page number, line upload progress, and a "Pause after this page" button.
- Step 4: summary with published, failed, and skipped pages, plus a link to the pool status.

### OCR pool admin section

- A card in `/admin/upload` or a `/admin/upload/ocr-pool` child route.
- Counts: open, claimed, submitted, approved, rejected, failed.
- Table: page label, line count, status, labeler, age, and actions "Unassign" for claimed pages and "Open review" for submitted pages.
- Empty state: "No OCR pages are in the pool yet. Publish pages from the OCR upload step."

### Labeler pool view

- `/ocr`: existing page plus a "Pool pages" card with the open count and "Start a page".
- `/ocr/pool/[pageId]`: line image, textarea, progress, "Mark unreadable", "Previous", "Submit page", and the claim expiry time.
- After submit: a short confirmation with the page status and a link back to `/ocr`.
- If the claim expired: a banner says the page was released and the local draft is still in this browser.

## 8. Phase plan

Each phase ends with `npm run build`, fixes, `HANDOFF.md`, and a short browser checklist.

### L8a: text import foundation and instructions

Files:

- `supabase/migrations/0010_import_text.sql`
- `src/lib/admin/upload/types.ts`
- `src/lib/admin/upload/validate.ts`
- `src/lib/admin/upload/line-chunks.ts`
- `src/lib/admin/upload/line-chunks.test.ts`
- `src/lib/admin/upload/validate.test.ts`
- `src/lib/admin/upload-server.ts`
- `src/app/(app)/admin/upload/page.tsx`
- `src/app/(app)/admin/upload/upload-client.tsx`
- `src/app/(app)/admin/upload/actions.ts`
- `src/app/(app)/admin/upload/status-cards.tsx`
- `src/components/app-shell/nav-items.ts`
- `src/app/(app)/admin/page.tsx` link to the upload page
- `package.json` add `test:upload`

Tests:

- Unit: byte-offset chunks with CRLF, blank lines, multibyte text, 1 MB cap, 200 row cap, and resume offsets.
- Unit: instruction validation for missing fields, wrong types, long fields, duplicate hash, and BOM.
- SQL: apply 0010 after confirming 0008 and 0009. Insert a 5 row file with 2 duplicates and 1 invalid row. Verify counters, `import_source_chunks`, and `source_row_index`.
- Browser: admin can load, pause, resume with the same file, and download the error CSV. A non-admin gets 404. A contributor cannot read the import tables.
- Regression: `npm run import:english` still inserts and the browser import skips the same row by hash.

### L8b: conversations

Files:

- `src/lib/admin/upload/validate.ts` add conversation rules
- `src/lib/admin/upload/upload-client.tsx` kind switch
- `src/lib/admin/upload-server.ts` kind parameter
- `src/lib/admin/upload/validate.test.ts`
- `supabase/migrations/0010_import_text.sql` already covers the table and RPC kind, no new migration unless a defect is found

Tests:

- Unit: 2 and 20 turns, 1 and 21 turns, system first, system in the middle, two system turns, wrong alternation, missing content, 4,001 characters.
- Browser: upload a valid conversation file, then load it as a contributor through `claim_next`. Confirm the item is served and the duplicate row is skipped on a second upload.
- SQL: verify `conversation_items.import_source_id` and `source_row_index`.

### L8c: OCR pool schema and admin OCR upload

Files:

- `supabase/migrations/0011_ocr_pool.sql`
- `src/lib/admin/ocr-upload-server.ts`
- `src/app/(app)/admin/upload/ocr-upload.tsx`
- `src/app/(app)/admin/upload/ocr-page-review.tsx`
- `src/app/(app)/admin/upload/actions.ts` add OCR actions
- `src/lib/ocr/pages.ts` add `open`, `claimed`, `origin`, labels, and tones
- `src/lib/ocr/ocr-server.ts` filter My pages and counts to `origin = 'contributor'`
- `src/lib/admin.ts` add OCR keys
- `src/app/(app)/admin/page.tsx` update the OCR status grid
- `src/app/(app)/admin/upload/status-cards.tsx` add the OCR pool meter

Tests:

- SQL: apply 0011 after the preflight. Create a pool page with 3 lines, verify `origin`, `contributor_id`, `status = 'open'`, null labels, and open line statuses.
- SQL: verify `admin_ocr_create_page` blocks above 80 percent OCR storage and above 60 open pool pages.
- Browser: upload 2 images, remove a junk line, publish, and verify the line crops are under the admin UUID prefix. The original page is not in Storage.
- Regression: normal `/ocr` upload still creates `origin = 'contributor'` and `status = 'submitted'`. My pages does not show pool pages. `npm run test:ocr` passes.

### L8d: pool claim, labeling, review, and export credit

Files:

- `supabase/migrations/0012_ocr_pool_review.sql`
- `src/app/(app)/ocr/page.tsx` pool card
- `src/app/(app)/ocr/pool/[pageId]/page.tsx`
- `src/app/(app)/ocr/pool/pool-workspace.tsx`
- `src/app/(app)/ocr/pool/actions.ts`
- `src/lib/ocr/pool-server.ts`
- `src/lib/ocr/pages.ts` pool labels
- `src/lib/review-server.ts` accept null labels for rejected lines
- `src/lib/review.ts` allow a null label in `ReviewOcrLine`
- `src/app/(app)/review/review-cards.tsx` render the unreadable line
- `src/lib/admin.ts` new OCR keys
- `scripts/lib/ocr-query.ts`
- `scripts/lib/export-data.ts`
- `scripts/lib/export-core.ts`
- `scripts/export.ts`
- `scripts/lib/export-core.test.ts`
- `scripts/lib/sync-core.test.ts`

Tests:

- SQL: claim, extend, release, expire, and reclaim. A second labeler cannot claim a live page.
- SQL: submit with a missing line, an empty label, all unreadable, and a valid mixed page. Verify `labeled_by`, page `submitted`, and line statuses.
- Browser: labeler claims, labels, marks one line unreadable, submits, and sees the page in the review queue. The reviewer sees the unreadable line, approves the remaining lines, and the page is approved. Self-review is blocked when `allow_self_review` is false.
- Export: `contributors.csv` credits the labeler, while `sync` and `purge` still validate the admin storage path. Run `npm run test:export`.
- Regression: normal contributor OCR review and export still work.

### L8e: counters, error report, hardening, docs

Files:

- `supabase/migrations/0013_upload_counters.sql`
- `src/app/(app)/admin/upload/pipeline-counters.tsx`
- `src/lib/admin/upload-server.ts` error pagination and CSV
- `scripts/audit-upload-storage.ts` optional local audit, service role only under `scripts/`
- `HANDOFF.md`
- `package.json` test script updates

Tests:

- SQL: approve one row of each kind, run export dry run, sync dry run, and purge dry run. Confirm `admin_pipeline_status` counts move only where expected and import counters do not change.
- Browser: a source with 1,000 invalid rows paginates and downloads a complete CSV.
- Security: grep confirms `SUPABASE_SERVICE_ROLE_KEY` appears only under `scripts/`. A contributor token cannot read `import_*` tables or call admin RPCs.
- Final: `npm run test:core`, `npm run test:ocr`, `npm run test:export`, `npm run test:upload`, `npm run lint`, `npm run build`.

## 9. Risks and open questions

1. Plain text bulk import is not included. Confirm whether the admin panel must load Khowar plain text, and who gets credit for it.
2. Pool credit is the labeler. Confirm that `contributors.csv` should credit the labeler, not the admin who uploaded the page.
3. The proposed claim is 2 hours with a 15 minute heartbeat. Confirm the duration.
4. The proposed auto-pause thresholds are 1,000 open instructions, 1,000 open conversations, 60 open pool pages, 75 percent database, and 80 percent OCR storage. Confirm these numbers.
5. The database quota default is 500 MB. Confirm the Supabase plan limit.
6. The file identity uses a chained SHA-256 over the file name, size, and 1 MiB blocks. A full-file hash would be simpler to describe but slower and needs a larger buffer. Confirm the chained hash is acceptable.
7. Instruction and conversation chunks default to 200 rows and cap at 1 MB and 1,000 rows. Confirm this matches the expected file sizes.
8. OCR batches default to 20 pages and cap at 40. Confirm the batch size.
9. Unreadable pool lines become rejected at submit time, and a page needs at least one labeled line. Confirm this review rule.
10. Admin pool uploads do not count toward the 20 pages per 24 hours contributor limit. Confirm that admins should be exempt.
11. Pool pages appear in the existing OCR review queue with a "Pool" badge. Confirm they should not have a separate queue.
12. The plan keeps the local import scripts. Confirm they should stay as a fallback after the browser panel ships.
13. JSONL is the only text format. Confirm that `.json` arrays and CSV are not required.
14. Failed OCR pages may leave uploaded objects if the browser crashes before cleanup. L8e adds a local audit script, not automatic deletion. Confirm that manual cleanup is acceptable.
15. `pg_database_size()` is an approximation and includes database overhead. Confirm that a percentage pause is acceptable instead of an exact row budget.
16. Browser hashing uses `crypto.subtle`, so the upload page needs HTTPS or localhost. Confirm the deployed origin is HTTPS.
17. A 1 MB text chunk plus JSON overhead must fit the Supabase request body limit. Confirm the project limit before L8a.

## 10. Approval

If approved, start with L8a only. Do not apply 0010 until 0008 and 0009 are confirmed applied. Do not write any code before the go-ahead.
