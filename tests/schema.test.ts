import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Sql } from "../lib/types.ts";
import { createSql } from "../lib/deps.ts";
import { addMemory } from "../lib/memories.ts";
import { ensureSchema } from "../lib/schema.ts";
import { TEST_URL, skipWithoutDb, testSql } from "./helpers/db.ts";

async function describeSchema(sql: Sql) {
  const cols = await sql`select column_name, data_type, is_nullable, column_default, generation_expression
                         from information_schema.columns where table_name = 'memories' order by column_name`;
  const idx = await sql`select indexname, indexdef from pg_indexes where tablename = 'memories' order by indexname`;
  const cons = await sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint
                         where conrelid = 'memories'::regclass order by conname`;
  return { cols: [...cols], idx: [...idx], cons: [...cons] };
}

describe("schema", { skip: skipWithoutDb }, () => {
  let sql: Sql;
  before(() => {
    sql = testSql();
  });
  after(async () => {
    await sql.end();
  });

  test("creates everything on an empty database, and a second run changes nothing", async () => {
    await sql`drop table if exists memories`;
    await ensureSchema(sql);
    const first = await describeSchema(sql);
    await ensureSchema(sql);
    assert.deepEqual(await describeSchema(sql), first);

    const cols = first.cols.map((c) => c.column_name);
    for (const c of ["id", "content", "category", "tags", "source_agent", "embedding", "created_at", "updated_at", "fts"]) {
      assert.ok(cols.includes(c), c);
    }
    const nullable = first.cols.filter((c) => c.is_nullable === "YES").map((c) => c.column_name).sort();
    assert.deepEqual(nullable, ["embedding", "fts"]);
    const idx = first.idx.map((i) => i.indexname);
    for (const i of ["memories_pkey", "memories_fts_idx", "memories_tags_idx", "memories_created_at_idx"]) assert.ok(idx.includes(i), i);
    assert.ok(first.cons.some((c) => c.conname === "memories_category_check"));
  });

  test("concurrent runs on an empty database all succeed (a rolling deploy starts two servers)", async () => {
    for (let round = 0; round < 5; round++) {
      await sql`drop table if exists memories`;
      await sql`drop extension if exists vector`;
      await Promise.all([ensureSchema(sql), ensureSchema(sql), ensureSchema(sql), ensureSchema(sql)]);
    }
  });

  test("a boot with nothing to change works for a role that may not create anything", async () => {
    await sql`drop table if exists memories`;
    await ensureSchema(sql);
    await sql`drop role if exists smm_limited`;
    await sql`create role smm_limited login password 'limited'`;
    await sql`revoke create on schema public from public`;
    await sql`grant usage on schema public to smm_limited`;
    await sql`grant select, insert, update, delete on memories to smm_limited`;
    const url = new URL(TEST_URL);
    url.username = "smm_limited";
    url.password = "limited";
    const limited = createSql(url.toString(), 1);
    try {
      await ensureSchema(limited);
    } finally {
      await limited.end();
      await sql`drop owned by smm_limited`;
      await sql`drop role smm_limited`;
    }
  });

  test("the server's connections have statement and lock timeouts, which the schema step lifts", async () => {
    const server = createSql(TEST_URL, 1);
    try {
      const [t] = await server`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`;
      assert.deepEqual({ ...t }, { statement: "3s", lock: "2s" });
      await server`drop table if exists memories`;
      await ensureSchema(server);
    } finally {
      await server.end();
    }
  });

  test("a v1 table without updated_at and with unknown categories is upgraded, not rejected", async () => {
    await sql`drop table if exists memories`;
    await sql`create extension if not exists vector`;
    await sql.unsafe(`create table memories (
      id uuid primary key, content text, category text, tags text[],
      source_agent text, embedding vector(1536), created_at timestamptz)`);
    const at = new Date("2026-05-01T00:00:00Z");
    await sql`insert into memories (id, content, category, tags, source_agent, created_at)
              values (gen_random_uuid(), 'free-text category', 'note', '{x}', 'mem.sh', ${at}),
                     (gen_random_uuid(), 'no category', null, null, null, ${at})`;
    await ensureSchema(sql);
    const rows = await sql`select content, category, tags, source_agent, updated_at from memories order by content`;
    assert.deepEqual(rows.map((r) => [r.category, r.tags, r.source_agent]), [["general", ["x", "note"], "mem.sh"], ["general", [], "unknown"]]);
    assert.ok(rows.every((r) => r.updated_at.toISOString() === at.toISOString()), "updated_at starts as created_at");

    // The upgraded table must take the server's own inserts, which rely on column defaults.
    const saved = await addMemory(sql, { id: crypto.randomUUID(), content: "saved after the upgrade", category: "fact", tags: [], agent: "codex", embedding: null });
    assert.ok(Date.now() - saved.created_at.getTime() < 60_000 && saved.updated_at.getTime() === saved.created_at.getTime());
    const [{ id }] = await sql`insert into memories (content) values ('only content') returning id`;
    assert.ok(id, "id, category, tags and agent defaults are in place too");
  });

  test("a column of the wrong type stops the boot with a clear message", async () => {
    await sql`drop table if exists memories`;
    await sql.unsafe(`create table memories (
      id uuid primary key default gen_random_uuid(), content text, category text, tags jsonb,
      source_agent text, embedding vector(1536), created_at timestamptz, updated_at timestamptz)`);
    await assert.rejects(ensureSchema(sql), /memories\.tags is jsonb, expected text\[\]/);
    await sql`drop table memories`;
  });

  test("upgrades a Supabase-shaped table in place and keeps every row", async () => {
    await sql`drop table if exists memories`;
    await sql`create extension if not exists vector`;
    await sql.unsafe(`create table memories (
      id uuid primary key default gen_random_uuid(), content text, category text default 'general',
      tags text[] default '{}', source_agent text default 'unknown', embedding vector(1536),
      created_at timestamptz default now(), updated_at timestamptz default now())`);
    const at = new Date("2026-07-24T08:00:00Z");
    await sql`insert into memories (content, category, tags, source_agent, created_at, updated_at)
              values ('Upwork job digest cron run', 'project', '{upwork}', 'hermes-cron', ${at}, ${at}),
                     ('Grafana panel notes', 'fact', null, 'codex', ${at}, ${at})`;

    await ensureSchema(sql);

    const rows = await sql`select content, tags, created_at from memories order by content`;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].tags, [], "NULL tags became an empty array");
    assert.equal(rows[1].created_at.toISOString(), at.toISOString(), "timestamps untouched");
    const [hit] = await sql`select count(*)::int as n from memories where fts @@ websearch_to_tsquery('english'::regconfig, 'upwork digest')`;
    assert.equal(hit.n, 1, "existing rows got their full-text column");
    const [nulls] = await sql`select count(*)::int as n from information_schema.columns
                              where table_name = 'memories' and is_nullable = 'YES' and column_name not in ('embedding', 'fts')`;
    assert.equal(nulls.n, 0, "columns hardened to NOT NULL");
  });
});
