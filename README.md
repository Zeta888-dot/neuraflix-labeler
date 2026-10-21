# NeuraFlix Labeler

A contributor platform for building open Khowar datasets for NeuraFlix. Khowar speakers and volunteers translate English instructions and conversations, write plain text, and label OCR pages. It is a separate app from the marketing site and is later deployed at label.neuraflix.si.

## Stack

Next.js 16 (App Router), TypeScript, Tailwind v4, Supabase (Postgres, Auth, Storage), zod, Phosphor icons.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the values.
3. Run the migrations in `supabase/migrations/` in the Supabase SQL editor, in order: `0001_init.sql` to `0008_admin_settings.sql`.
4. `npm run dev`, then open http://localhost:3000

## Environment variables

Names only:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

The service role key is read only by `scripts/` and is never imported by `src/` or logged. The OCR quota is not an environment variable. Its only source is `app_settings.ocr_quota_mb`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Start the production build |
| `npm run lint` | ESLint |
| `npm run test:core` | Core tests, including the OCR and export libraries |
| `npm run test:ocr` | OCR segmentation, labels, bitmap and submit tests |
| `npm run test:export` | Export, sync, image check and file safety tests |
| `npm run import:english` | Import an English instruction JSONL file |
| `npm run import:conversations` | Import an English conversation JSONL file |
| `npm run export` | Write an approved data snapshot under `exports/<timestamp>/` |
| `npm run sync` | Download approved OCR line images into `data/ocr` (dry run by default) |
| `npm run purge:ocr` | Delete remote OCR images that passed the local checks (dry run by default) |

`export`, `sync` and `purge:ocr` are local scripts. They never run from the web app. Sync never deletes remote objects. Purge is the only command that does.

## Phases

L0 to L6 are done. L7 has not started. See `HANDOFF.md` for the manual L6 order, the waived `--include-unreviewed` and `--push-hf` flags, and the sync and purge deviation from `LABELER.md` section 9.

## Data policy

Only approved rows are exported. Contributions are stored in Postgres, and OCR images stay in Supabase Storage only until synced. Exports contain no personal data; `contributors.csv` is pseudonymous and for admin use only. Offsite backup is a manual copy of `data/` for now. The original page image is never uploaded or stored.
