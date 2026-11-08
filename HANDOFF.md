# Handoff

Status: L0 to L7a are implemented. L8a (admin text import) and the L8b labeling, translation layout and photo straightening work are in the working tree, uncommitted. `0009_hardening.sql` and `0010_import_text.sql` are written but are not applied by this repo.

## How to run

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the three names. `SUPABASE_SERVICE_ROLE_KEY` is read only by `scripts/` and is never imported by `src/` or logged.
3. `npm run dev`, then open http://localhost:3000
4. `npm run test:core`, `npm run test:ocr`, `npm run test:export`, `npm run lint` and `npm run build`.

Environment variable names only: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. The OCR quota has no environment variable. Its only source is `app_settings.ocr_quota_mb`. Warn at 60 percent after upload, block above 80 percent.

## Supabase setup

1. Project settings, API: copy the project URL, anon key and service role key into `.env.local`. Never commit or print them.
2. Authentication: keep the email magic link and add `/auth/callback` for the local and deployed origins.
3. Migration: `0007_review.sql` is confirmed applied. Apply `0008_admin_settings.sql` if it is not applied yet. Then paste `supabase/migrations/0009_hardening.sql` into the Supabase SQL editor and Run. It is safe to run again. Nothing in this repo applies it.
4. Apply `supabase/migrations/0010_import_text.sql` for the admin text import if it is not applied yet. It is safe to run again and is not applied by this repo.
5. `0009` adds the submission rate limits, the plain text trigger, `health_ping()` and its grants. Until it is applied, `/api/health` returns 503 and the new limits are not enforced.
6. The first admin already exists. Later role changes use Admin, Users, or SQL:

```sql
update public.profiles p set role = 'reviewer'
  from auth.users u where u.id = p.id and u.email = 'person@example.com';
```

## L7a hardening

- Rate limits are rolling one-hour windows: 60 instruction submissions, 30 conversation submissions and 30 plain text submissions per contributor. The functions and trigger live in `0009_hardening.sql`.
- `submit_instruction_translation` and `submit_conversation_translation` raise `RATE_LIMIT`; the actions map it to "You are submitting very quickly. Please wait a little and try again." Plain text uses a `BEFORE INSERT` trigger, so the 0005 policy is unchanged.
- `/api/health` calls `health_ping()` with the anon key and returns `{ok:true}` or 503 `{ok:false}`. No table is read and no detail is exposed. It is public in `src/proxy.ts`.
- The keep-alive workflow is `.github/workflows/keep-alive.yml`. It runs every 3 days and by hand. Set the repository variable `HEALTH_URL` under Settings, Secrets and variables, Actions, Variables, to `https://<host>/api/health`. A non-200 response fails the job.
- `supabase/cleanup/launch-reset.sql` is not a migration. Run `npm run purge:ocr` first, because deleting OCR rows removes the only map to the Storage objects. Review the counts with the default ROLLBACK, fill in the explicit test id blocks only for confirmed test rows, then change the last statement to COMMIT. Never run it against real contributor data.
- Tests: `test:core` 81, `test:ocr` 22, `test:export` 28. Lint and build pass. Browser checks for focus, 360px layout and reduced motion are still manual.

## L8a admin text import

- `0010_import_text.sql` adds `import_batches`, `import_sources`, `import_source_chunks` and `import_source_errors`, plus the admin RPCs. RLS and grants keep the tables closed to direct app writes.
- The admin Upload screen reads JSONL or CSV locally, hashes the file, and sends one chunk at a time. Only the prepared chunk rows cross the wire. The original file is never stored.
- A chunk is one transaction. Duplicate `english_hash` rows are skipped, invalid rows are logged in `import_source_errors`, and neither rolls back the valid rows. Committing the same chunk again is idempotent, and resume checks the hash of the last committed byte slice.
- Create fix: `admin_import_create_source` returns the new id as `source_id`, while `admin_import_sources` returns it as `id`. `parseImportSource` now accepts both. Before the fix the source row was created as Active at offset 0, but the client read the create response as a parse failure and showed "The import request failed. Try again.", so the first chunk could never load.
- Failed RPCs log the RPC name, message, code and hint. Details are left out because PostgreSQL can put row values there. Parse failures log `UPLOAD_PARSE`, and the admin message carries a short safe code.
- Regression coverage: `src/lib/admin/upload/parse.test.ts` checks create (`source_id`), list (`id`) and chunk counter payloads.

Manual check: on a fresh source, select `test-instructions.jsonl` and load the chunk. Expect 7 loaded, 1 duplicate skipped and 2 invalid, and the instructions count to go from 0 to 7. Reselect the same file and confirm no duplicates. Reload after a committed chunk and confirm resume starts at the saved position.

## L8b label step

- The Label step no longer shows the page map. The label card spans the full content width, and the Lines list and Page details sit below it in a two-column row on desktop. Check lines still shows the page preview with its line boxes.
- Focus mode collapses the sidebar from the Label step. It uses the existing `nf-sidebar-collapsed` localStorage preference, so the choice survives reloads and matches the sidebar collapse button. The control is offered at desktop widths, where the sidebar exists.
- The line image fills the card width at 1x. 2x stays horizontally scrollable, and Contrast is unchanged. The image area is taller than before on large screens.
- The one-line Khowar field is larger: 56px high, 18px type and wider padding. Enter still saves and advances, Alt + Left and Alt + Right still move, and Escape still returns focus to the field.
- On mobile the label card, Lines list and Page details stack in one column. The Lines list keeps its own scroll area.

Manual check: open the Label step and confirm the page map is gone, the label card uses the full width, and the Lines list and Page details are reachable below. Turn Focus mode on, reload, and confirm the sidebar stays collapsed. Check 1x, 2x and Contrast on a long and a short line, the larger Khowar field, and all four shortcuts. Repeat at 360px with the sidebar drawer closed.

## L8b translation layouts

- Instructions: the read-only English card now sits on top and the Khowar card runs the full width below at every breakpoint. Before this change they were side by side from `lg`.
- Conversations: each turn already places the English turn above its full-width Khowar field, so the layout was already the requested stack.
- Draft autosave and restore, validation and warnings, Ctrl + Enter, Skip, Report and the review flow are unchanged.

Manual check: open Instructions and confirm English is above Khowar with Khowar spanning the full form width at desktop and 360px. In Conversations, confirm every turn reads English first and its Khowar field below. Type a few fields, reload, and confirm the draft comes back; submit one item and confirm the next item loads.

## L8b photo straightening

- The OCR flow now has five steps: Upload, Straighten, Check lines, Label and Submit. After an image is decoded, the Straighten step opens instead of starting line detection. Apply or Skip runs detection on the chosen working copy.
- The original file is decoded once with EXIF orientation and stays in this browser. Nothing from this step is uploaded.
- Four pointer and keyboard corner handles start from lightweight page-edge detection and fall back to a small image inset when no page is found confidently. The rotate slider covers -8 to 8 degrees and starts at the detected text tilt.
- Apply runs the pure-TS four-point homography in `src/lib/ocr/straighten.ts` through a canvas warp, caps the working copy at 3000 px on the long edge, and shows Before and After. Use this page commits the result, Back to corners keeps editing, and Skip runs detection on the untouched page.
- Applied corners and rotation are saved in the local OCR draft and replayed on the original file when the draft resumes, so saved line boxes stay aligned. A recovered preview also replays the setting.
- `src/lib/ocr/straighten.test.ts` covers homography round trips, output sizing, quad validation, page-corner detection and deskew angle detection. It runs in `test:ocr` and `test:core`.

Manual check: upload a tilted phone photo and confirm the Straighten step appears. Drag each corner by touch and with the arrow keys, check auto deskew and the slider, then Apply and compare Before with After. Use this page and confirm the line boxes follow the straightened image. Try Skip on a flat scan, Replace during the step, and reload a saved draft to confirm straightening replays.

## L6 commands

- `npm run export` writes a new snapshot and `DATASET_NOTES.md`. Options: `--out path`, `--data path`, `--dry-run`, `--no-latest`.
- `npm run sync` is a dry run. `npm run sync -- --commit` downloads missing approved OCR images. Sync never deletes remote objects. Options: `--data path`, `--page uuid`.
- `npm run purge:ocr` is a dry run. Purge is the only command that deletes remote objects. Its `--commit` mode is destructive. Options: `--data path`, `--page uuid`.
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

A split file is created only when that split has rows. `manifest.json` is written last. No manifest stores labels or names. `contributors.csv` has pseudonymous ids only.

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
- `DATASET_NOTES.md`: purpose, one example line for each split, counts, normalization and split rules, privacy, licence and a load snippet. It is not written in a dry run.
- The full page image is never read or exported.

## Selection, sync and purge

- Text export includes rows whose final status is exactly `approved`. OCR export requires both the line and its page to be `approved`.
- Normalization: NFC, U+064A and U+0649 to U+06CC, U+0643 to U+06A9, controls and invisible marks removed, ZWNJ kept, whitespace collapsed. Paragraph breaks stay in plain text.
- Splits use SHA-1 of the source item id, val when the value is below 0.05. Records from one source item stay together. If either side would be empty, all rows stay in train.
- Sync validates each storage path as `<contributor_uuid>/<page_uuid>/<line>.<webp|jpg>`, checks header, type, bytes and dimensions, then writes through a temporary file. An existing file is never replaced.
- Purge needs an approved line and page, `exported_at`, a valid manifest entry, and a local file whose type, dimensions, bytes and sha256 match. Only then does it delete the Storage object and set `purged_at`. Local files are kept.
- A malformed approved row stops the export. Sync and purge are idempotent. Use `--page uuid` to work one page at a time.
- `--include-unreviewed` and `--push-hf` remain waived. Offsite backup is a manual copy of `data/` for now.

## Manual checks still open

L8a: select `test-instructions.jsonl` on a fresh source, load the chunk, confirm 7 loaded / 1 skipped / 2 invalid, open Instructions and confirm 0 to 7, then reselect and confirm no duplicates.

L8b: on the Label step, confirm no page map, a full-width label card, and the Lines and Page details panels below it. Toggle Focus mode, reload and confirm the sidebar stays collapsed. Check 1x, 2x, Contrast, the larger Khowar field, Enter, Alt + Left/Right and Escape at desktop and 360px. On Instructions and Conversations, confirm English sits above a full-width Khowar field at every width.

L8b straighten: upload a tilted phone photo, confirm the Straighten step opens, drag all four corners by touch and arrow keys, check the detected deskew and slider, Apply and compare Before with After, then Use this page and confirm the line boxes follow the straightened image. Try Skip, Replace and a draft reload.

L6: run `npm run sync` (dry run), then `sync --commit` for one approved page, `export --dry-run`, `export`, `purge:ocr` and `purge:ocr --commit` for the same page. Check `exports/<timestamp>/` and `data/ocr/<page_uuid>/manifest.json`. If credentials or approved test records are unavailable, mark these blocked instead of using real user data.

L7a browser checks: keyboard focus rings, dialog focus return, skip link, the review single-key shortcuts outside form controls, 44px touch targets on a coarse pointer, 360px width, reduced motion, and both themes for muted text contrast.

## Next phase (L7b)

L7b covers deployment and the live account path: hosting the Next.js app, the production domain `label.neuraflix.si`, Google login in Supabase Auth, SMTP for magic links, callback and redirect URLs for the deployed origin, and the neuraflix.si integration (links between the marketing site and the labeler). It does not change the phase L7a code.

## UI tuning

- Shared page container: reading and form routes cap at 60rem, OCR, review and admin at 88rem, all centred in the space right of the sidebar.
- The account block opens a menu above it with the theme toggle (showing the current Light or Dark), Account and Sign out; the standalone top bar toggle is gone.
- Global cursor rule in `src/app/globals.css`: pointer for interactive controls, not-allowed for disabled controls, text cursor kept for text fields.
