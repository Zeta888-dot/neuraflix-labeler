# NeuraFlix Labeler: master brief

## 1. Purpose
A public contributor platform where Khowar speakers and volunteers help build open Khowar datasets for NeuraFlix. It is a separate app from the marketing site (neuraflix.si), later deployed at label.neuraflix.si, with the same look. The data must come out ready for training models of the Qwen-3.5 family. Stack: Next.js (App Router, Next 16 conventions, use proxy.ts instead of middleware.ts if applicable), TypeScript, Tailwind v4, Supabase (Postgres, Auth, Storage), zod, @phosphor-icons/react. shadcn/ui primitives are allowed if restyled with our tokens.

## 2. Design
Same system as the neuraflix.si site (tokens in reference/site-design/globals.css, wordmark in reference/site-design/brand and wordmark.svg, rules in DESIGN.md): dark theme pure black canvas with Vercel blue accent (#0070f3 fills, #3291ff accent text), light theme warm off-white with Japonica (#D97757 family); dark is the default; theme toggle. Containers use 8px radius, small inner elements 6px, buttons pills, badges and avatars fully round. Geist for UI, Noto Nastaliq Urdu (rtl, line-height about 2.1) for every Khowar input and display. Phosphor icons only (light weight in UI, no emojis). Professional app shell: fixed left sidebar (about 256px, collapsible) on desktop, top bar with a drawer on mobile. The wordmark sits top left with the word "Labeler" in muted text next to it. Everything works at 360px.

## 3. Sidebar and modules
Dashboard, Instructions, Conversations, Plain text, OCR pages, Review (reviewer and admin only), Admin (admin only), Guidelines, Account.
- Dashboard: personal contribution counts only (no leaderboard, no global fake numbers), what to do next, honest empty states.
- Instructions: an English instruction and response dataset loaded by admin. The contributor gets the next item (claimed server-side) and sees English on the left (read-only: instruction, optional input, response) and Khowar fields on the right with the same structure. Actions: Submit and next, Skip, Report an issue with the English item. Draft autosave. Mobile: stacked.
- Conversations: multi-turn English conversations. Each English turn sits above its own Khowar textbox, turn by turn, one submit for the whole conversation.
- Plain text: contributor types or pastes Khowar text (20 to 20000 characters), optional title and source note, confirms rights, validation shown before submit.
- OCR pages: contributor uploads one page image (jpg, png, webp, up to 15 MB). Segmentation into lines runs IN THE BROWSER (Web Worker, horizontal projection on a binarized canvas; port the logic documented in reference/PORTING.md, the old local labeler used sharp on the server). The contributor can delete junk lines and merge or split lines. Each line crop keeps its original pixel size, width capped at 1800 px, grayscale, encoded as WebP quality 80. Then a labeling view: line image on top, Khowar textbox below, Enter saves and goes to the next line, progress bar. Max 40 lines per page. Work in progress is kept in IndexedDB so a refresh loses nothing. Only on submit are the line crops and labels uploaded. The original page image is NEVER uploaded or stored. A "My pages" list shows status.
- Review: side by side English and Khowar (or image and label for OCR), Approve, Edit and approve, Reject with a note.
- Admin: import English datasets (script), user roles, counts per status, storage meter, and the export and sync commands shown as copyable text. Export and purge run as local scripts, not from the web.
- Guidelines: short, generic: write natural Khowar, do not machine translate, keep meaning and names, use Perso-Arabic script, use the Khowar letters palette, never include personal data.

## 4. Khowar input helper
Every Khowar textarea has a "Khowar letters" palette: buttons that insert special characters at the cursor (at least U+0681, U+0685, U+076E, U+076F, U+0770, U+0771, plus common Urdu letters and ZWNJ). RTL, Nastaliq font, spellcheck off.

## 5. Roles, auth, consent
Supabase Auth with email magic link (Google login comes in a later phase). Roles in profiles: contributor (default), reviewer, admin. First login shows a consent screen with two required checkboxes, stored with a version string "v1":
1. "I understand my contributions will be used to build and release open Khowar datasets and models."
2. "I will only submit text and images I wrote or have the right to share."
Stored personal data: email (in auth), optional display name. Nothing else.

## 6. Data model (Postgres, RLS on every table)
- profiles(id = auth uid, display_name, role, consent_version, consent_at, created_at)
- instruction_items(id, english jsonb {instruction, input?, response}, source, status open|complete|retired, target_count default 1)
- instruction_translations(id, item_id, contributor_id, khowar_instruction, khowar_input, khowar_response, status draft|submitted|approved|rejected, reviewer_id, review_note, created_at, submitted_at, exported_at)
- conversation_items(id, english jsonb {turns:[{role,content}]}, source, status, target_count)
- conversation_translations(id, item_id, contributor_id, turns jsonb [{role,content}], status, reviewer_id, review_note, created_at, submitted_at, exported_at)
- text_submissions(id, contributor_id, title, khowar_text, source_note, rights_confirmed, text_hash unique, status, reviewer_id, review_note, created_at, exported_at)
- ocr_pages(id, contributor_id, label, rights_confirmed, line_count, status, created_at)
- ocr_lines(id, page_id, idx, storage_path, label, status, width, height, bytes, exported_at, purged_at)
- claims(id, kind instruction|conversation, item_id, contributor_id, expires_at); a Postgres function claim_next(kind) picks an open item the user has not done, using FOR UPDATE SKIP LOCKED, with 30 minute expiry; an item is complete when approved or submitted translations reach target_count.
- report_issues(id, kind, item_id, contributor_id, note, created_at)
RLS: contributors insert and read only their own rows; reviewers and admins read all and update review fields; items tables readable by authenticated users only through claim_next; storage bucket ocr-lines is private, contributors write only under their own user id prefix, reviewers read through signed URLs. Migrations live in supabase/migrations/*.sql and are run by the user in the Supabase SQL editor.

## 7. Validation (client and server, zod)
Khowar text: NFC; trim; collapse spaces; remove control characters except ZWNJ and newline; at least 60 percent of letters in Arabic-script ranges (U+0600 to U+06FF, U+0750 to U+077F); reject when Latin letters are more than 20 percent of letters (digits and punctuation allowed); reject if identical to the English source; warn when the length ratio to the English is below 0.3 or above 4; reject empty fields; text_submissions deduped by hash. Raw text is stored as typed; normalization happens at export.

## 8. Export (local scripts, output under exports/<timestamp>/ and exports/latest/)
Only status approved is exported (flag --include-unreviewed for OCR). Splits are deterministic by hash of the item id (95 train, 5 val) so the same item never leaks across splits. Normalization at export: NFC, whitespace cleanup, control chars removed except ZWNJ and newline, U+064A and U+0649 mapped to U+06CC, U+0643 mapped to U+06A9. Raw text stays in the database. Files:
- cpt/train.jsonl, cpt/val.jsonl: {"id","source","text"} from approved plain text plus approved Khowar translated instructions, inputs and responses as separate documents (source tells which).
- sft/train.jsonl, sft/val.jsonl: {"id","messages":[{"role":"user","content":khowar instruction (plus "\n\n" and the input when present)},{"role":"assistant","content":khowar response}]}.
- sft_multiturn/train.jsonl, val.jsonl: {"id","messages":[all turns with roles]}.
- parallel/train.jsonl, val.jsonl: {"id","type":"instruction|input|response|turn","en","khw"} for the English to Khowar translation model.
- ocr/: the DeepSeek-OCR-2 training layout documented in reference/PORTING.md (images, train and val jsonl and txt, charset, manifest), with unique file names across pages.
- manifest.json (counts, split sizes, schema version, normalization applied, date; no personal data) and contributors.csv (pseudonymous ids only, admin use).
Chat templates are NOT pre-applied; training uses tokenizer.apply_chat_template. Do not assume Qwen-3.5 specifics.

## 9. Storage policy: Supabase is a buffer
Text rows stay in Postgres. OCR images live in Supabase Storage only until synced. scripts/sync.ts (service role, run locally with `npm run sync`): download every not yet exported ocr line to data/ocr/<page_id>/line_<idx>.webp, verify count and bytes, mark exported_at, and only with --commit delete the files from Storage and set purged_at (labels stay in the database). Default is a dry run. Optional --push-hf uploads the export to a private Hugging Face dataset repo as offsite backup. The admin storage meter sums bytes of non purged lines against OCR_STORAGE_QUOTA_MB (default 400): warn at 60 percent, block new OCR page uploads at 80 percent while the other modules keep working. A keep-alive GitHub Action pings a tiny endpoint every 3 days so the free project does not pause (later phase).

## 10. Phases (one at a time, wait for my go-ahead)
- L0: scaffold, tokens, fonts, shell with sidebar, auth, consent, profiles, full SQL migration (0001_init.sql, written but not run), Guidelines page, honest empty dashboard.
- L1: Instructions module, scripts/import-english.ts (JSONL to items), claim system, validation, Khowar letters palette.
- L2: Conversations module.
- L3: Plain text module.
- L4: OCR module (in-browser segmentation, labeling UI, IndexedDB drafts, WebP upload).
- L5: Review queue, roles, admin dashboard with counts and storage meter.
- L6: Export script and sync script (formats in sections 8 and 9), dataset notes.
- L7: Hardening (rate limits, accessibility, performance, Google login, keep-alive Action) and integration with neuraflix.si (Contribute link and an info page).