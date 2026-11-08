import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0010_import_text.sql"),
  "utf8",
);

const adminFunctions = [
  "admin_upload_status",
  "admin_import_create_source",
  "admin_import_verify_resume",
  "admin_import_text_chunk",
  "admin_import_set_status",
  "admin_import_sources",
  "admin_import_errors",
];

const newTables = [
  "import_batches",
  "import_sources",
  "import_source_chunks",
  "import_source_errors",
];

test("every admin RPC is security definer, pins search_path and checks is_admin", () => {
  for (const name of adminFunctions) {
    const pattern = new RegExp(
      `create or replace function public\\.${name}\\s*\\([\\s\\S]*?\\n\\$\\$;`,
      "i",
    );
    const match = migration.match(pattern);

    assert.ok(match, `${name} is missing`);
    const block = match[0];

    assert.match(block, /security definer/i, `${name} must be security definer`);
    assert.match(
      block,
      /set search_path = public/i,
      `${name} must set search_path`,
    );
    assert.match(
      block,
      /public\.is_admin\(\)/i,
      `${name} must check is_admin inside the function`,
    );
  }
});

test("new tables enable row level security and keep writes admin only", () => {
  for (const table of newTables) {
    assert.ok(
      migration.includes(
        `alter table public.${table} enable row level security;`,
      ),
      `${table} must enable RLS`,
    );

    assert.ok(
      migration.includes(`create policy "${table}: admin only"`),
      `${table} must have an admin policy`,
    );
  }

  assert.match(
    migration,
    /using \(\(select public\.is_admin\(\)\)\)\s+with check \(\(select public\.is_admin\(\)\)\)/i,
  );
});

test("new tables and helper functions are closed to direct app writes", () => {
  for (const table of newTables) {
    assert.ok(
      migration.includes(
        `revoke all on table public.${table} from public, anon, authenticated;`,
      ),
      `${table} must revoke direct access`,
    );
  }

  for (const signature of [
    "setting_int(text, integer)",
    "import_instruction_hash(text, text)",
    "import_parse_instruction(text, text, integer)",
    "upload_pause_state()",
  ]) {
    assert.ok(
      migration.includes(
        `revoke all on function public.${signature} from public, anon, authenticated;`,
      ),
      `${signature} must be closed to app users`,
    );
  }
});

test("admin RPCs are granted to authenticated only", () => {
  for (const signature of [
    "admin_upload_status()",
    "admin_import_create_source(text, text, bigint, text, text, integer, integer)",
    "admin_import_verify_resume(uuid, integer, bigint, bigint, text)",
    "admin_import_text_chunk(uuid, integer, bigint, bigint, text, jsonb)",
    "admin_import_set_status(uuid, text)",
    "admin_import_sources(integer)",
    "admin_import_errors(uuid, integer, integer)",
  ]) {
    assert.ok(
      migration.includes(
        `grant execute on function public.${signature} to authenticated;`,
      ),
      `${signature} must be granted to authenticated`,
    );
  }
});

test("chunk commits are idempotent and row provenance is unique", () => {
  assert.ok(
    /unique \(import_source_id, chunk_index\)/i.test(migration),
    "import_source_chunks needs a unique (import_source_id, chunk_index) key",
  );
  assert.ok(
    /instruction_items_import_row_key[\s\S]*\(import_source_id, source_row_index\)/i.test(
      migration,
    ),
    "instruction items need unique provenance",
  );
  assert.ok(
    /conversation_items_import_row_key[\s\S]*\(import_source_id, source_row_index\)/i.test(
      migration,
    ),
    "conversation items need unique provenance",
  );
});
