# Handoff

Status: L0 to L3 complete. L4a (OCR segmentation and line review) and L4b (labeling and IndexedDB drafts) are built. L4c has not been started.

## OCR decisions

- The working page is downscaled only when its long edge exceeds 3000 px, and is never upscaled.
- Line crops keep the working page resolution. There is no per-line width cap.
- Crops become grayscale WebP quality 90 at submit time (L4c). The original page image is never uploaded and is kept only in the local draft.
- L4 is split into L4a (segmentation and line review), L4b (labeling and drafts) and L4c (upload, quota guard and My pages).

## How to run

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the four values. `.env.local` is gitignored. The service role key is read only by local scripts under `scripts/`, never by app code, and is never logged.
3. `npm run dev`, then open http://localhost:3000
4. `npm run lint`, `npm run build` and `npm run test:ocr` all pass.

## Supabase setup (do this once, in order)

1. Project settings, API: copy the project URL, the anon key and the service role key into `.env.local`.
2. Authentication: keep the email magic link, and add `/auth/callback` for the local and deployed origins.
3. SQL Editor: run `supabase/migrations/` 0001 to 0005 in order (0002 hashing and claim helpers, 0003 the `claim_next` fix, 0004 conversations, 0005 plain text checks).
4. Make yourself the first admin with the UPDATE statement in 0001's header comment, using your email.

## Import English items and conversations (local)

Items: `npm run import:english -- --file path.jsonl --source name --target-count 1 [--dry-run]`
- One JSON object per line: `{"instruction":"...","input":"...","response":"..."}`. `instruction` and `response` are required, `input` is optional, `output` aliases `response`, `source` overrides `--source`.

Conversations: `npm run import:conversations -- --file path.jsonl --source name --target-count 1 [--dry-run]`
- One JSON object per line: `{"turns":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}`. `messages` aliases `turns`. 2 to 20 turns, optional single leading system turn, then user and assistant alternating, each content at most 4000 characters.
- Both scripts trim, skip invalid lines with a line number, dedupe by hash, insert in batches of 200 and print `read / invalid / duplicates / inserted`. `--dry-run` writes nothing.

## What exists in the app

- App shell, tokens, fonts, auth, consent, profiles, Guidelines and Account from L0.
- `/instructions` (claimed item, three Khowar fields, letters palette, Ctrl/Cmd + Enter, skip, report, drafts), `/conversations` (turns with role badges, "Submit and next", Skip, drafts) and `/plain-text` (title and source, one RTL Nastaliq field with live stats, duplicate message, submissions with Load more).
- `/ocr`: phase L4b, with upload, line review, labeling and local drafts. Described below.
- Dashboard shows your own counts; Admin shows real totals per module.

## OCR Phase L4a

- `src/lib/ocr/segment-core.ts` holds the pure functions: Rec.709 grayscale, `otsuThreshold`, `estimateSkewAngle`, row profile and smoothing, `findBands`, ink extents, reading order and numbering. No DOM or canvas, so it runs under Node.
- `src/lib/ocr/segment.worker.ts` is the module Worker: `createImageBitmap` decode on the main thread, white canvas, downscale only above 3000 px, one skew estimate, rotation only above 0.01 degrees, and a cached mask and profile so sliders rerun banding only.
- `src/lib/ocr/segmenter.ts` is the typed client (type, size and 600 to 10,000 px checks, friendly messages, stale results, bitmap cleanup); `line-edits.ts` re-trims a line's ink for split and merge.
- Defaults: deskew on, sensitivity 0.02 (0.005 to 0.15), min height 18 px (5 to 80), merge gap 6 px (0 to 40), padding 6 px (0 to 30). Clamps: 0.001 to 0.3, 1 to 200, 0 to 100, 0 to 60.
- UI: page canvas with boxes and zoom; Detection panel with the deskew switch, four sliders, a 250 ms debounce, a confirmation before a re-detect replaces manual edits, and Reset; Lines list with thumbnails, Delete, Merge with next, Split with a canvas click or numeric point and 30 undo steps.
- Tests: `npm run test:ocr` covers Otsu, band counts, merge gap, min height, padding and skew.

## OCR Phase L4b

- Steps are Upload, Check lines, Label, with Submit greyed and marked "Coming in the next update".
- `src/lib/ocr/labels.ts`: `LineDraft`, `normalizeLabel`, `validateLabel` (non-empty, at most 400 characters, Latin letters under 20 percent), `statusForLabel`, `lineProgress` and line navigation. Tests are in `labels.test.ts`.
- `src/lib/ocr/crop.ts` draws one grayscale line crop at working resolution. `src/lib/ocr/draft-store.ts` wraps IndexedDB and validates stored records.
- Step 2 enables Continue for 1 to 40 lines. Zero lines and more than 40 keep it disabled with a visible reason. Delete keeps the surviving line ids; merge, split and changed re-detections create new ids and show a reset notice.
- Step 3 has the line crop (1x, 2x, contrast), a single-line RTL Nastaliq field with the letters palette, progress, page map, status filters, line list, completion summary and a page label and rights card.
- Keyboard: Enter saves and advances; Alt + Left and Alt + Right move between lines; Escape focuses the field. Invalid labels show an inline error and keep focus.
- Draft database `neuraflix-labeler`, object store `ocr-drafts`, out-of-line key `ocr-draft:<user id>`, database version 1. One record per signed-in user.
- Record schema version 1: original file Blob, fileName, params, boxes, lines (id, box, label, status), currentLine, pageLabel, rightsConfirmed and updatedAt. Autosave runs 500 ms after a change.
- Resume card shows the page label or file name, line and labeled counts and the last saved time, with Resume and Discard. A new upload while a draft or page exists asks first. Resume runs the Worker with the saved params, then applies the saved boxes.
- Save status is a polite live region: "Saved in this browser at HH:MM" or a quota-friendly "Could not save" message. A failed read disables autosave; a failed write leaves work on screen and retries on the next change.
- No database writes, SQL or uploads. The page image and labels stay in this browser.

## OCR bitmap ownership

- The working page bitmap has one owner and is released only after a replace, a reset or a confirmed unmount, so StrictMode and Fast Refresh cannot close a preview that is still on screen.
- The page preview, line thumbnails, line crops and page map check the bitmap before drawing; an unusable page is rebuilt from the original Blob through the Worker, and canvas failures show a friendly boundary with a "Reload page" button.
- Tests: `npm run test:ocr` covers the bitmap check; `npm run lint` and `npm run build` pass.

## L4c scope

- Encode line crops as grayscale WebP quality 90 and upload them to the private `ocr-lines` bucket under the user id prefix.
- Insert `ocr_pages` and `ocr_lines` rows, validate on the client and server, and delete the local draft after a successful submit.
- Add the storage quota guard: warn at 60 percent, block new OCR uploads at 80 percent, keep other modules working.
- Add My pages with real statuses. Never upload the original page image.

## Browser checks

Plain text (run the 0005 SQL first): empty states and Dashboard/Admin zero counts are honest; 20 to 20,000 characters give live stats, palette insertion, a resizable field and a disabled reason until the checks pass; Ctrl + Enter submits; a duplicate says "This text has already been submitted."; reload restores the draft; "Clear draft" empties it; Load more pages the list.

OCR:
- Complete the L4a checks: file validation, boxes and zoom, sliders, re-detect confirmation, delete, merge, split, undo, and the 0 and 40+ line gates.
- Drop a page and wait for "Saved in this browser at ...". Reload: the Resume card shows the label or file name, counts and time. Resume restores boxes and labels; Discard asks first and removes the draft.
- Label with Enter, Alt + Left/Right and Escape. An empty line shows an inline error and keeps focus. Latin-heavy or over 400 characters is rejected.
- Mark unreadable, clear a line, use all three filters, jump to the next empty line, and jump with the page map and line list.
- Label a line, then change a detection setting: the notice names reset or removed labels and untouched lines keep theirs. Replace the page and confirm the destructive prompt.
- Check 360 px and 1440 px, both themes, keyboard only and a screen reader. Deny site storage or fill the quota and confirm the "Could not save" copy while work stays on screen.
