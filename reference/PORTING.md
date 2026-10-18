# Porting guide — Khowar Line Labeler

Target of the port: same product, but segmentation runs in the browser, data lives in Supabase per user, and many labelers work at once. Today it is a Next.js 16 App Router app that segments with sharp on the server, uses one shared Supabase project with a service-role key, and has no auth.

## 1. Stack, versions and gotchas

- next 16.4.0 · react/react-dom 19.3.0 · typescript 5 (strict, `@/*` → `src/*`) · tailwindcss 4 wired through the `turbopack.rules` loader `@tailwindcss/turbopack` · sharp ^0.35.5 · fflate ^0.8.3 · @supabase/supabase-js ^2.118.0 · lucide-react ^1.55.0. Scripts: `dev`, `build`, `start`, `lint`.
- `next.config.ts` sets `cacheComponents: true` together with `partialPrefetching: true` (the docs pair them). Consequences: PPR is the default; uncached/dynamic data in a Server Component must sit under `<Suspense>` or the build fails; `experimental.ppr`, `experimental_ppr` and `export const dynamic` are removed; `'use cache'` is opt-in per function; Client Component state persists across client-side navigations via React `<Activity>`, so reset it explicitly when the page changes (this app remounts Workspace with `key={pageId}`).
- Next 16: `params` in pages and route handlers is a `Promise` — always `await ctx.params`. Verify every Next API against `node_modules/next/dist/docs/` before coding.
- sharp is native: Node runtime only (never edge function) and must not reach the client bundle. That is why `src/lib/api.ts` imports `type` only and `SegmentPanel` re-declares `DEFAULT_PARAMS` instead of importing `segment.ts`.
- Env vars: `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-only, used in `src/lib/supabase.ts`); no `.env` file is committed.
- No auth, no RLS, no SQL migrations anywhere in the repo; every API route is public and admin-keyed, and export is one global `exports/latest.zip`. Adding users means designing auth, ownership columns, RLS and storage policies from zero.
- Segmentation and export run inside request handlers (full-page sharp pass, whole-dataset zip built in RAM): serverless timeout/memory limits apply. Browser-side work removes this.

## 2. File map

- `src/app/layout.tsx` — root layout: Geist fonts, metadata, typed `LayoutProps<"/">`.
- `src/app/page.tsx` — client home; owns `pages`, `activeId`, `version` (cache buster); composes Sidebar + Workspace + SegmentPanel.
- `src/app/globals.css` — Tailwind entry plus global styles.
- `src/app/api/pages/route.ts` — GET page summaries; POST multipart upload, segments every file, returns `{created, errors}`.
- `src/app/api/pages/[id]/route.ts` — GET one page (params, angle, lines); DELETE page.
- `src/app/api/pages/[id]/resegment/route.ts` — POST `{params, force}`, clamps params, answers 409 `labels_exist` when labels would be wiped.
- `src/app/api/pages/[id]/lines/[i]/route.ts` — PUT label text for one line; DELETE one line (row + image).
- `src/app/api/files/[id]/[file]/route.ts` — streams `image_NN.jpg` / `overlay.jpg` from Storage (`no-store`, regex allowlist).
- `src/app/api/export/route.ts` — POST, runs the export, 400 when nothing is labeled.
- `src/lib/segment.ts` — the sharp segmentation pipeline (see §3).
- `src/lib/storage.ts` — Supabase Storage plus `pages`/`lines` CRUD, id validation/uniqueness, page detail assembly.
- `src/lib/export.ts` — label collection, train/val split, normalization and charset warnings, zip + manifest, signed URL.
- `src/lib/api.ts` — browser fetch client and image URL helpers.
- `src/lib/supabase.ts` — service-role client factory and `BUCKET = "lines"`.
- `src/components/Sidebar.tsx` — upload dropzone, page list with per-page progress and filter, export button and export summary.
- `src/components/Workspace.tsx` — the labeling workspace: line image, RTL textarea, navigation, delete line/page, confirm dialog.
- `src/components/SegmentPanel.tsx` — overlay preview, presets/sliders, re-segment, wipe confirmation.

## 3. The segmentation algorithm, exactly

Params (`SegParams`, defaults in `lib/segment.ts`, mirrored in `SegmentPanel` with slider ranges): `deskew: true`, `sensitivity: 0.02` (slider 0.005–0.15), `minHeight: 18` px (5–80), `mergeGap: 6` px (0–40), `pad: 6` px (0–30). Server clamps are wider: sensitivity 0.001–0.3, minHeight 1–200, mergeGap 0–100, pad 0–60.

Steps:
1. Normalise: `sharp(input).rotate()` (EXIF auto-orient), `.flatten({background:"#ffffff"})`, `.png({compressionLevel:1})`.
2. Skew estimate: resize to width 900 (`withoutEnlargement`), grayscale raw; Otsu threshold from the 256-bin histogram; sample ink pixels (`pixel <= thr`) with stride `max(1, floor(w*h/400000))`; fewer than 100 samples → angle 0. Try 25 candidate angles `a = -3.0…+3.0` step 0.25; for each, accumulate a row histogram of `yy = round(y + (x - w/2) * tan(a))` and score `mean(yy²) - mean(yy)²`; keep the best. If `|angle| > 0.01`, `sharp(oriented).rotate(angle, {background:"#ffffff"})` → PNG.
3. Row profile: grayscale raw → Otsu → `prof[y] = count(pixels in row <= thr)`; smooth `sm[y] = (prof[y-1] + prof[y] + prof[y+1]) / 3` (edge rows clamp to themselves); `maxP = max(sm)`.
4. Bands: `cut = sensitivity * maxP`; take runs where `sm[y] > cut`; merge adjacent runs when `next.start - last.end <= mergeGap`; drop runs shorter than `minHeight`; per survivor scan only its rows for ink to get `minX`/`maxX`, then the box is `[max(0,minX-pad), max(0,y0-pad), min(w,maxX+1+pad), min(h,y1+pad)]`. Boxes stay in reading order (top→bottom) and become lines 1..n (1-based numbering everywhere).
5. Crops, in box order: `sharp(page).grayscale().extract({left:x0, top:y0, width:x1-x0, height:y1-y0}).jpeg({quality:95})`.
6. Overlay: page resized to width `min(w,1000)` as PNG, composited with an SVG layer holding one 2px red `stroke` rect per box plus a blue bold 16px sans-serif line number at `(rx-2, ry+16)`; saved as `jpeg({quality:85})`.

Pseudocode:
```text
seg(input, p):
  page = png(flatten(autoOrientByExif(input)))
  if p.deskew: a = bestAngle(grayscale(resizeWidth(page, 900))); if |a|>0.01: page = rotate(page,a,white)
  g = grayscale(page); thr = otsu(g); sm = smooth3(rowInkCount(g, thr))
  for run in merge(runsWhere(sm > p.sensitivity*max(sm)), gap=p.mergeGap):
     if run.height < p.minHeight: continue
     x0,x1 = inkExtent(g, run); emit clampBox(x0-p, run.y0-p, x1+1+p, run.y1+p, w, h)
  return boxes, jpegCrops(page, boxes, 95), overlayJpeg(page, boxes, 85), page
```

Browser port: decode with `createImageBitmap(file, {imageOrientation:"from-image"})` (or `<img>`, which is `from-image` by default) and draw onto an `OffscreenCanvas` pre-filled white (replaces `flatten`); run all math on one `Uint8ClampedArray` from `getImageData` (canvas uses Rec.709 luma, sharp's grayscale is close — expect occasional boundary-pixel shifts); keep Otsu, the ±3° sweep and the profile loop identical but hold ink in a `Uint8Array` mask and never build `xs`/`ys` arrays (8–9 M px per 300 dpi page); rotate via `translate`/`rotate`/`drawImage` onto a canvas sized `|w·cos|+|h·sin|` × `|w·sin|+|h·cos|` with white fill; crop with the 9-argument `drawImage` into a per-line canvas and `convertToBlob({type:"image/jpeg", quality:0.95})`; draw the overlay with `strokeRect` + `fillText` instead of SVG. Run it in a Worker with OffscreenCanvas to keep the UI responsive, and make sure images are CORS-readable or same-origin — otherwise `getImageData` throws on a tainted canvas.

## 4. Labeling UI flow and features

- Upload (Sidebar): drag/drop or file picker, images only, all files in one multipart POST; each scan becomes a page; per-file errors are reported; the first created page is auto-selected.
- Load (Workspace): GET page, then jump to the first line with an empty label (else line 1); focus the textarea on every line change; `version` busts the image cache after re-segment.
- Editing: `dir="rtl"`, `lang="ur"`, Nastaliq font stack, `spellCheck=false`, 2 rows, live char counter using `Array.from(draft).length` (code points).
- Shortcuts: `Enter` = save + next (ignored while an IME composition is active); `Alt+↓`/`Alt+↑` = next/prev; blur also saves; `Escape` closes dialogs.
- Validation: trimmed comparison only — an empty or whitespace label clears the line and counts as unlabeled; `sanitizeLabel` collapses internal newline runs to one space and trims. Nothing else is rejected.
- Navigation: Prev/Next buttons (clamped, Prev disabled on first), "Next unlabeled" (wraps to the start, notice if all labeled), Save & Next shows "Page complete" on the last line, numbered thumbnail strip where green = labeled and a blue ring = current.
- Progress: per-page `labeled/total` bar in the Workspace header; per-page bars, page count and overall percentage in the Sidebar; the page filter appears once there are more than 6 pages.
- Saving: one `PUT /api/pages/{id}/lines/{i}` per changed line; `savedRef` remembers the last server-known text per line to skip duplicate PUTs; the server re-sanitizes and returns the stored string, which replaces the draft; failures surface in a dismissable alert; "Bad line" deletes the row and image after a confirm dialog.

## 5. Data on disk

- Storage bucket `lines`, one folder per page: `lines/<pageId>/original.img` (byte-exact upload, `application/octet-stream`), `image_01.jpg … image_NN.jpg` (1-based, zero-padded to 2, grayscale JPEG q95), `overlay.jpg` (q85). `label_NN.txt` exists as the `labelFile()` helper but is dead code — labels live in the DB.
- Tables (no migration file; shape implied by queries): `pages(id text pk, params jsonb, angle float8, boxes jsonb)` with `boxes = {"1":[x0,y0,x1,y1], …}` keyed by line number, and `lines(page_id text fk → pages.id, line_index int, label text)`, new rows inserted with `label: ""`, PK effectively `(page_id, line_index)`, deletes cascade from `pages`.
- Label format: plain UTF-8 text in the `label` column (no label file on disk); empty string means unlabeled; NFC/whitespace normalization happens only at export.
- Collision avoidance: the page id derives from the file name — stem, `[^\w-]+` → `_`, strip leading/trailing `_`, fallback `"page"`, then SELECT `id LIKE 'base%'` and append `_2`, `_3`, …; ids must match `/^[\w-]+$/` on every route. Export row ids are `` `${pageId}_${String(line).padStart(2,"0")}` ``, unique across pages by construction (a deleted line has no row at all).

## 6. Export

One POST builds everything server-side and writes `exports/latest.zip` (bucket `exports`, always overwritten) plus a 3600 s signed URL with `download=khowar_dataset.zip`. Zip layout: `images/{page}_{NN}.jpg` (stored with `level: 0`, no recompression), `train.jsonl`, `train.txt`, `val.jsonl`/`val.txt` only when val is non-empty, `charset.json`, `manifest.json`.
- jsonl, one JSON object per line: `{"messages":[{"role":"<|User|>","content":"<image>\nFree OCR. ","images":["images/scan_01.jpg"]},{"role":"<|Assistant|>","content":"اچھی"}]}`
- txt, Paddle-style with a tab separator: `images/scan_01.jpg\tاچھی`
- charset.json, sorted by frequency descending, 1-space indent: `[{"char":"ا","code":"U+0627","count":812}, …]`
- manifest.json: `{"created":"2026-10-18T…Z","options":{"valRatio":0.1,"prompt":"<image>\nFree OCR. "},"counts":{"total":n,"train":n,"val":n,"pages":n},"warnings":[…],"rows":[{"id":"scan_01","page":"scan","line":1,"split":"train"}, …]}`
- Normalization before export: NFC; strip invisible marks (ZWNBSP, LRM/RLM, LRE…RLO, LRI…PDI, BOM) but deliberately keep ZWNJ U+200C and ZWJ U+200D because they are meaningful in Arabic script; collapse whitespace; trim; drop empties.
- Split: `bucket(key) = SHA1(key).readUInt32BE(0) / 2^32`; page-level first, `bucket(page) < valRatio` → val; if that leaves val or train empty, fall back to a line-level key `page + "/" + line`, but only when there are ≥ 20 labeled lines (otherwise everything is train and no val files are written). Deterministic across exports.
- Warnings: Arabic-vs-Urdu confusables (ي، ى، ك، ه) plus any Latin letter (possible typo), counted and shown in the Sidebar export summary. Default prompt is `"<image>\nFree OCR. "`, default `valRatio` 0.1.

## 7. Known bugs and TODOs

1. `uniqueId` is check-then-insert with no unique-constraint retry: two concurrent uploads of the same file name can collide.
2. `resegment` deletes `lines` rows and old line images before writing new ones, with no transaction and no per-page lock — a failure or a second concurrent re-segment can leave a page with missing images.
3. `deleteLine`, `deletePage` and the label PUT never check that the row exists, so they succeed silently on no-ops (a save to an already-deleted line is a lost write).
4. `listPages` pages through the whole `lines` table (1000 rows per request) just to count labels — O(all lines) I/O, the main scaling bug for many users; needs an aggregate view/RPC.
5. Export loads every image into memory and builds the zip with `zipSync`, and re-downloads everything on every export.
6. Export emits a warning per Latin letter with no cap, so mixed-script pages make the summary very noisy.
7. `SegResult.page` (the deskewed PNG) is produced and returned but never stored or used — wasted memory on large scans.
8. `SegmentPanel` duplicates `DEFAULT_PARAMS`, and its slider maxima disagree with the server clamps (0.15 vs 0.3); consolidate into one shared, sharp-free module.
9. Thumbnails render one button per line with no virtualization.
10. Save-on-blur plus `Enter` can fire two PUTs for the same line; the `savedRef` guard does not cover in-flight requests.
11. `/api/export` spreads the summary after `count`, so the response carries duplicate-ish keys (`count`/`total`, `path`/`dir`); `lib/api.ts` still types the old shape.
12. No auth/RLS, no per-user isolation, no undo/label history, no page reordering; re-segmenting always wipes labels.

## 8. What is reusable versus what must be rewritten

Reuse as pure functions (no sharp, no I/O): `otsu`, the skew-scoring loop, smoothing/merge/box math over a gray buffer, `sanitizeLabel`/`normalizeLabel` with the `INVISIBLE` and `CONFUSABLE` tables, `bucket()` (keep SHA-1 so splits stay stable across re-exports — WebCrypto `digest("SHA-1")` matches Node), the id sanitizing/collision policy, `pad2`/`imageFile` naming, and the jsonl/txt/charset/manifest builders (pure strings). Moving them into one dependency-free module lets the browser and any server share them verbatim.
Rewrite: everything sharp (decode, EXIF rotate, flatten, resize, PNG/JPEG encode, `extract`, SVG composite) → `createImageBitmap` + `OffscreenCanvas`; the admin Supabase client and Storage download/upload/signed-URL calls → browser `supabase-js` with an authenticated session, RLS policies and per-user buckets or prefixes; all route handlers and `lib/api.ts` → direct client queries or server actions, replacing polled fetches with realtime/optimistic updates; `listPages` counters → SQL aggregate; server-side in-memory zip → client-side `fflate` or a streaming job. The React components port largely as-is, but they need Suspense boundaries per the Cache Components rules, per-user state, and an autosave/retry queue that survives flaky networks.
