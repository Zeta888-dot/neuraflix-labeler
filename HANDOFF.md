# Handoff

Status: L0 to L6 are done. `0007_review.sql` is confirmed applied and the L5 manual checks are complete. `0008_admin_settings.sql` is written but not yet applied. The L6 manual order below is not yet confirmed, and the sync dry run is not yet confirmed. No L7 work has started.

## How to run

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the three names. `SUPABASE_SERVICE_ROLE_KEY` is read only by `scripts/` and is never imported by `src/` or logged.
3. `npm run dev`, then open http://localhost:3000
4. `npm run test:core`, `npm run test:ocr`, `npm run test:export`, `npm run lint` and `npm run build`.

Environment variable names only: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

The OCR quota has no environment variable. Its only source is `app_settings.ocr_quota_mb`. Warn at 60 percent after upload, block above 80 percent.

## Supabase setup

1. Project settings, API: copy the project URL, anon key and service role key into `.env.local`. Never commit or print them.
2. Authentication: keep the email magic link and add `/auth/callback` for the local and deployed origins.
3. Migration: `0007_review.sql` is confirmed applied. Do not rerun it. `0008_admin_settings.sql` is written but not yet applied. Run it next, then follow the manual order under Verification. Any future database change needs a separate new migration.
4. The first admin already exists. Later role changes use Admin, Users, or SQL:

```sql
update public.profiles p set role = 'reviewer'
  from auth.users u where u.id = p.id and u.email = 'person@example.com';
```

## L6 commands

- `npm run export` writes a new snapshot and `DATASET_NOTES.md`. Options: `--out path`, `--data path`, `--dry-run`, `--no-latest`.
- `npm run sync` is a dry run. `npm run sync -- --commit` downloads missing approved OCR images. Sync never deletes remote objects. Options: `--data path`, `--page uuid`.
- `npm run purge:ocr` is a dry run. Purge is the only command that deletes remote objects. Its `--commit` mode is destructive and runs only after the earlier Verification steps pass. Options: `--data path`, `--page uuid`.
- Defaults are `exports/<UTC timestamp>/` and `data/ocr`. A custom `--out` that already exists is refused.
- `exports/latest` is a junction on Windows and a directory link elsewhere. A real directory named latest is never removed; the export succeeds with a warning.

## Output structure

```text
exports/<timestamp>/
  manifest.json
  DATASET_NOTES.md
  contributors.csv
  cpt/ train.jsonl, val.jsonl
  sft/ train.jsonl, val.jsonl
  sft_multiturn/ train.jsonl, val.jsonl
  parallel/ train.jsonl, val.jsonl
  ocr/ train.jsonl, val.jsonl, train.txt, val.txt, charset.json, manifest.json
  ocr/images/<page_uuid>_<NN>.<webp|jpg>
data/ocr/<page_uuid>/line_<NN>.<webp|jpg>
data/ocr/<page_uuid>/manifest.json
```

A split file is created only when that split has rows. `manifest.json` is written last, so a directory without it is incomplete and must not be treated as an export. No manifest stores labels or names. `contributors.csv` has `contributor_id,instruction_translations,conversation_translations,text_submissions,ocr_lines` and pseudonymous ids only.

## Export schemas

- `cpt`: `{"id","source","text"}`, where source is `instruction`, `input`, `response` or `text`.
- `sft`: `{"id":"instruction:<translation_uuid>","messages":[{"role":"user","content":"...\n\n<input when present>"},{"role":"assistant","content":"..."}]}`.
- `sft_multiturn`: `{"id":"conversation:<translation_uuid>","messages":[{"role":"system|user|assistant","content":"..."}]}` in original turn order.
- `parallel`: `{"id","type":"instruction|input|response|turn","en","khw"}`. Conversation turn ids include the one based turn position.
- `ocr/train.jsonl` and `val.jsonl`: `{"id":"<page_uuid>_<NN>","messages":[{"role":"<|User|>","content":"<image>\nFree OCR. ","images":["images/<page_uuid>_<NN>.<ext>"]},{"role":"<|Assistant|>","content":"<label>"}]}`.
- `ocr/train.txt` and `val.txt`: `images/<page_uuid>_<NN>.<ext><TAB><label>`.
- `ocr/charset.json`: frequency sorted `{"char","code","count"}` entries.
- `ocr/manifest.json`: `schemaVersion`, `createdAt`, prompt, counts and rows with `id`, `pageId`, `lineId`, `line`, `image`, `split`, `bytes`, `width`, `height`, `sha256`.
- Top `manifest.json`: schema, `createdAt`, normalization rules, split method, `ocrPrompt`, `valRatio`, real counts and warnings.
- `DATASET_NOTES.md`: purpose, one example line for each split, counts from the manifest, normalization and split rules, the privacy line, the licence line and a short load snippet. It is not written in a dry run.
- The full page image is never read or exported.

## Selection and splits

- Text export includes rows whose final status is exactly `approved`. Draft, submitted, rejected, incomplete and unreviewed rows are excluded.
- OCR export requires both the OCR line and its page to be `approved`. A line that is approved under a non-approved page is excluded.
- Export is a fresh snapshot and does not require `exported_at`; it never changes text status. OCR images must already exist in `data/ocr` and pass manifest, type, size, dimension and sha256 checks, so run sync first when OCR is approved.
- Normalization: NFC, U+064A and U+0649 to U+06CC, U+0643 to U+06A9, controls and invisible marks removed, ZWNJ kept, whitespace collapsed. Paragraph breaks stay in plain text.
- Splits use SHA-1 of the source item id, val when the value is below 0.05. Records from one source item stay together. OCR groups by page id and falls back to line id at 20 or more lines. If either side would be empty, all rows stay in train. Output order is sorted by id.
- A malformed approved row stops the export instead of silently dropping data.

## Sync, resume and purge

Sync and purge are separate commands. This is an intentional deviation from LABELER.md section 9: sync never deletes remote objects, and `purge:ocr --commit` is the only step that deletes them.

- Sync validates each storage path as `<contributor_uuid>/<page_uuid>/<line>.<webp|jpg>` and ties it to the database page, line and page contributor. Remote names are never used as local names.
- Sync downloads only approved page and line images. It checks image header, type, byte count and dimensions against the row, then writes a temporary file, fsyncs it and hard links it into place. An existing file is never replaced. A bad or mismatched local file is reported and left untouched.
- The page manifest is written before `exported_at` is marked. A crash at any point is safe to retry. Leftover temporary files older than one hour are removed; they are never treated as images.
- `exported_at` means a local image passed the sync checks: the expected path, type, byte count and dimensions match the row, and the file is recorded in the page manifest with its sha256. It does not mean a remote purge is safe by itself.
- Purge is never automatic. It requires an approved line and page, `exported_at` set, a valid manifest entry, and a readable local file whose type, dimensions, byte count and sha256 all match. Only then does it delete the Storage object and set `purged_at`. The local file remains. The remote copy cannot be recovered after a purge, so keep the `data/ocr` directory backed up if another export may be needed.
- If a purge deletes the remote object but the database update fails, running purge again verifies the local file, sees the object is already gone, and sets `purged_at`. If any local check fails, the remote object is left intact.
- Sync and purge are idempotent. Use `--page uuid` to work one page at a time.

## Waivers and deviations

- `--include-unreviewed`: not implemented, waived.
- `--push-hf`: not implemented, waived. Offsite backup is a manual copy of `data/` for now.
- Sync and purge are separate commands. This is an intentional deviation from LABELER.md section 9. Sync never deletes remote objects, and purge is a separate destructive command.

## Recovery

- A partial export has no top `manifest.json`; `exports/latest` still points at the previous complete export. Nothing is overwritten. Delete the partial directory manually after checking it.
- If export fails because OCR images are missing, run `npm run sync -- --commit` and retry.
- If sync reports a mismatched local file, move that file aside manually, then rerun. The scripts do not replace or delete it for you.
- If a local manifest is unreadable, sync and purge stop for that page and leave everything in place.

## Verification

L5 manual checks are complete and were confirmed by the project owner. Do not repeat them, rerun `0007_review.sql`, or change the self-review setting as part of this audit.

Confirm `.env.local` exists with the documented names only. Never print its contents.

Manual L6 order, not yet confirmed. If credentials or approved test records are unavailable, mark the live steps blocked instead of using real user data.

1. Apply `supabase/migrations/0008_admin_settings.sql` in the Supabase SQL editor. It is safe to run again.
2. Run `npm run sync`. This is a dry run and must not write files or mark rows. The sync dry run is not yet confirmed.
3. Run `npm run sync -- --commit --page <page_uuid>` for one approved page. Check `data/ocr/<page_uuid>/manifest.json` and the line images.
4. Run `npm run export -- --dry-run`, then `npm run export`. The dry run must not create an export directory. Check the new `exports/<timestamp>/` directory, `DATASET_NOTES.md`, top manifest, schemas, OCR image mappings and `exports/latest`.
5. Run `npm run purge:ocr` and confirm it only reports dry-run counts.
6. Run `npm run purge:ocr -- --commit --page <page_uuid>` for the same page. This deletes remote objects and cannot be undone. Check that the local images remain and `purged_at` is set.
7. Run `npm run test:core`, `npm run test:ocr`, `npm run test:export`, `npm run lint` and `npm run build`.

## L5 status

The L5 review queues, approval, edit-and-approve, rejection notes, OCR line review, dashboard feedback, admin overview, role management, concurrency messages and self-review RPC checks are implemented and manually verified. No L5 code changes are planned unless the audit finds a concrete regression.
