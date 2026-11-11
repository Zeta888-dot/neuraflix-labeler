import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

/**
 * Guard for the admin delete RPCs. The rules that matter: admin only, safe by
 * default, protected work needs a typed confirmation, child rows are removed
 * explicitly, the source record only disappears when no items remain, and no
 * OCR data is touched.
 */
const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0014_import_delete.sql"),
  "utf8",
);

function functionBlock(name: string): string {
  const pattern = new RegExp(
    `create (?:or replace )?function public\\.${name}\\s*\\([\\s\\S]*?\\n\\$\\$;`,
    "i",
  );
  const match = migration.match(pattern);
  assert.ok(match, `${name} is missing from 0014_import_delete.sql`);
  return match[0];
}

const deleteFunctions = [
  "admin_import_delete_preview",
  "admin_import_source_items",
  "admin_delete_import_source",
  "admin_delete_import_item",
  "admin_import_deletions",
];

test("every delete RPC is admin only, security definer and pins search_path", () => {
  for (const name of deleteFunctions) {
    const block = functionBlock(name);

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
    assert.match(
      block,
      /auth\.uid\(\) is null/i,
      `${name} must reject an anonymous caller`,
    );
  }
});

test("the preview counts safe and protected items for both kinds", () => {
  const block = functionBlock("admin_import_delete_preview");

  assert.match(block, /i\.status = 'open'/i, "safe items must be open");
  assert.match(
    block,
    /not exists \(\s*select 1 from public\.instruction_translations t where t\.item_id = i\.id\s*\)/i,
  );
  assert.match(
    block,
    /not exists \(\s*select 1 from public\.conversation_translations t where t\.item_id = i\.id\s*\)/i,
  );
  assert.match(block, /from public\.claims c[\s\S]*?c\.item_id = i\.id/i);
  assert.match(block, /from public\.review_log r[\s\S]*?r\.item_id = i\.id/i);
  assert.match(block, /'safe_items', v_safe/i);
  assert.match(block, /'protected_items', v_total - v_safe/i);
  assert.match(block, /'exported_items', v_exported/i);
  assert.match(block, /v_source\.kind not in \('instruction', 'conversation'\)/i);
});

test("safe source deletion only takes open, untouched items", () => {
  const block = functionBlock("admin_delete_import_source");

  const safePicks = block.match(
    /i\.status = 'open'\s+and not exists \([\s\S]*?review_log r[\s\S]*?\);/gi,
  );
  assert.ok(
    (safePicks?.length ?? 0) >= 2,
    "both kinds need an explicit safe item filter",
  );

  assert.match(
    block,
    /if coalesce\(p_include_work, false\) then\s+if btrim\(coalesce\(p_confirm, ''\)\) <> 'DELETE'[\s\S]*?raise exception 'DELETE_CONFIRM_REQUIRED'/i,
    "including work must require a matching typed confirmation",
  );
  assert.match(block, /<> v_source\.file_name/i);
});

test("deletion removes child rows explicitly and never touches OCR", () => {
  const sourceBlock = functionBlock("admin_delete_import_source");
  const itemBlock = functionBlock("admin_delete_import_item");

  for (const block of [sourceBlock, itemBlock]) {
    assert.match(block, /delete from public\.claims c/i);
    assert.match(block, /delete from public\.review_log r/i);
    assert.match(block, /delete from public\.skips s/i);
    assert.doesNotMatch(
      block,
      /ocr_pages|ocr_lines|storage\.objects/i,
      "deletion must not touch OCR pages, lines or Storage",
    );
  }
});

test("the source record is removed only when no items remain", () => {
  const block = functionBlock("admin_delete_import_source");

  assert.match(
    block,
    /if v_remaining = 0 then\s+delete from public\.import_sources s where s\.id = p_source_id;/i,
    "the source must be removed in the zero-items branch",
  );
  assert.match(
    block,
    /else\s+update public\.import_sources s\s+set loaded_rows = v_remaining/i,
    "a partially deleted source must keep correct counters",
  );
  assert.match(block, /'source_removed', v_source_removed/i);

  // The delete must not run before the remaining count is computed.
  const sourceDelete = block.indexOf("delete from public.import_sources");
  const remainingCount = block.indexOf("select count(*) into v_remaining");
  assert.ok(
    remainingCount > -1 && sourceDelete > remainingCount,
    "the source delete must follow the remaining count",
  );
});

test("single item deletion refuses protected work without the explicit path", () => {
  const block = functionBlock("admin_delete_import_item");

  assert.match(
    block,
    /if not coalesce\(p_include_work, false\) then[\s\S]*?if v_status <> 'open'[\s\S]*?v_translations > 0[\s\S]*?v_claims > 0[\s\S]*?v_reviews > 0[\s\S]*?raise exception 'IMPORT_ITEM_PROTECTED'/i,
    "the protected checks must guard the safe path",
  );
  assert.match(block, /raise exception 'IMPORT_ITEM_NOT_IMPORTED'/i);
  assert.match(
    block,
    /btrim\(coalesce\(p_confirm, ''\)\) <> 'DELETE'/i,
    "the work path must require the typed confirmation",
  );
});

test("the item list shows per-item work counts and a delete flag", () => {
  const block = functionBlock("admin_import_source_items");

  for (const column of [
    "out_translation_count",
    "out_claim_count",
    "out_review_count",
    "out_exported_count",
    "out_can_delete",
  ]) {
    assert.match(block, new RegExp(column, "i"), `${column} is missing`);
  }

  assert.match(block, /i\.status = 'open'/i);
  assert.match(block, /limit v_limit offset v_offset/i);
});

test("deletions are audited in a closed table", () => {
  assert.match(
    migration,
    /create table if not exists public\.import_deletions/i,
  );
  assert.match(
    migration,
    /alter table public\.import_deletions enable row level security;/i,
  );
  assert.match(
    migration,
    /revoke all on table public\.import_deletions from public, anon, authenticated;/i,
  );

  const inserts =
    migration.match(/insert into public\.import_deletions/gi) ?? [];
  assert.ok(inserts.length >= 2, "both delete paths must write an audit row");
});

test("delete RPCs are closed to public and anon and granted to authenticated", () => {
  for (const signature of [
    "admin_import_delete_preview(uuid)",
    "admin_import_source_items(uuid, integer, integer)",
    "admin_delete_import_source(uuid, boolean, text)",
    "admin_delete_import_item(text, uuid, boolean, text)",
    "admin_import_deletions(integer)",
  ]) {
    assert.ok(
      migration.includes(
        `revoke all on function public.${signature} from public, anon;`,
      ),
      `${signature} must revoke public and anon`,
    );
    assert.ok(
      migration.includes(
        `grant execute on function public.${signature} to authenticated;`,
      ),
      `${signature} must be granted to authenticated`,
    );
  }
});
