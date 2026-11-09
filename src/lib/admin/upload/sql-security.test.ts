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

test("imported rows land as claimable open items", () => {
  // The contributor queue reads instruction_items.status = 'open'. The import
  // insert must set that status, and claim_next must not filter on provenance,
  // or an imported row would never be served.
  const insert = migration.match(
    /insert into public\.instruction_items[\s\S]*?returning id into v_item_id;/i,
  );
  assert.ok(insert, "the instruction chunk insert is missing");
  assert.match(insert[0], /'open'/, "the insert must write status open");
  assert.match(
    insert[0],
    /import_source_id[\s\S]*?source_row_index/i,
    "the insert must write provenance",
  );

  const claimMigration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/0003_fix_ambiguous_columns.sql"),
    "utf8",
  );
  const instructionPick = claimMigration.match(
    /-- 3\. Oldest open item[\s\S]*?limit 1;/i,
  );
  assert.ok(instructionPick, "the instruction claim pick is missing");
  assert.doesNotMatch(
    instructionPick[0],
    /import_source_id|source_row_index/i,
    "claim_next must not filter imported items by provenance",
  );
  assert.match(
    instructionPick[0],
    /i\.status = 'open'/i,
    "claim_next must keep selecting open items",
  );
});

test("the conversation import keeps the same RPC guarantees", () => {
  const conversationMigration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/0012_import_conversations.sql"),
    "utf8",
  );

  for (const name of [
    "admin_import_create_source",
    "admin_import_text_chunk",
  ]) {
    const pattern = new RegExp(
      `create or replace function public\\.${name}\\s*\\([\\s\\S]*?\\n\\$\\$;`,
      "i",
    );
    const match = conversationMigration.match(pattern);

    assert.ok(match, `${name} is missing from the conversation migration`);
    assert.match(match[0], /security definer/i);
    assert.match(match[0], /set search_path = public/i);
    assert.match(match[0], /public\.is_admin\(\)/i);
  }

  assert.match(
    conversationMigration,
    /p_kind not in \('instruction', 'conversation'\)/i,
    "create_source must accept the conversation kind only",
  );
  assert.match(
    conversationMigration,
    /v_source\.kind not in \('instruction', 'conversation'\)/i,
    "text_chunk must accept the conversation kind only",
  );
  const conversationInsert = conversationMigration.match(
    /insert into public\.conversation_items[\s\S]*?returning id into v_item_id;/i,
  );
  assert.ok(conversationInsert, "the conversation chunk insert is missing");
  assert.match(
    conversationInsert[0],
    /'open'/,
    "the conversation insert must write status open",
  );
  assert.match(
    conversationInsert[0],
    /import_source_id[\s\S]*?source_row_index/i,
    "the conversation insert must write provenance",
  );
  assert.match(
    conversationMigration,
    /v_state\.open_conversations >= v_state\.pause_conversations/i,
    "the conversation queue must use its own pause threshold",
  );

  for (const signature of [
    "import_conversation_hash(jsonb)",
    "import_parse_conversation(text, text)",
  ]) {
    assert.ok(
      conversationMigration.includes(
        `revoke all on function public.${signature} from public, anon, authenticated;`,
      ),
      `${signature} must be closed to app users`,
    );
  }

  assert.match(
    conversationMigration,
    /v_role not in \('system', 'user', 'assistant'\)/i,
    "the parser must reject unknown roles",
  );
  assert.match(
    conversationMigration,
    /'roles_not_alternating'/i,
    "the parser must enforce alternating turns",
  );
  assert.match(
    conversationMigration,
    /'must_end_assistant'/i,
    "the parser must require a closing assistant turn",
  );

  const claimMigration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/0003_fix_ambiguous_columns.sql"),
    "utf8",
  );
  const conversationBlock = claimMigration.match(
    /-- Conversation items mirror the instruction logic[\s\S]*?limit 1;/i,
  );
  assert.ok(conversationBlock, "the conversation claim pick is missing");
  assert.doesNotMatch(
    conversationBlock[0],
    /import_source_id|source_row_index/i,
    "claim_next must not filter imported conversations by provenance",
  );
  assert.match(
    conversationBlock[0],
    /i\.status = 'open'/i,
    "claim_next must keep selecting open conversations",
  );
});

