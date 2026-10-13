import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Sql } from "../lib/types.ts";
import { callTool, type ToolDeps, type ToolResult } from "../lib/tools.ts";
// (callTool's 4th argument is the logger; tests that expect a logged failure pass a silent one.)
import { backfillEmbeddings, similarMemories } from "../lib/memories.ts";
import { toVectorLiteral } from "../lib/embeddings.ts";
import { fakeEmbedder, fakeVector, type FakeEmbedder } from "./helpers/fake-embedder.ts";
import { freshSchema, seed, skipWithoutDb, testSql } from "./helpers/db.ts";

const CONFIG = { minSimilarity: 0.3, dedupSimilarity: 0.82, queryTimeoutMs: 300, writeTimeoutMs: 300 };
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const idOf = (out: string) => {
  const m = out.match(/\(id: ([0-9a-f-]{36})\)/);
  assert.ok(m, `no id in: ${out}`);
  return m[1];
};

describe("tools against Postgres", { skip: skipWithoutDb }, () => {
  let sql: Sql;
  let embedder: FakeEmbedder;
  const call = (name: string, args: unknown, e?: FakeEmbedder) =>
    callTool(name, args, async (): Promise<ToolDeps> => ({ sql, embedder: e ?? embedder, config: CONFIG }));
  const count = async () => (await sql`select count(*)::int as n from memories`)[0].n;

  before(() => {
    sql = testSql();
  });
  after(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await freshSchema(sql);
    embedder = fakeEmbedder();
  });

  test("mem_add embeds first and stores one row together with its vector", async () => {
    const r = await call("mem_add", { content: "Chose Postgres over MongoDB for billing", category: "decision", tags: ["db"], agent: "codex" });
    assert.equal(r.isError, undefined);
    assert.match(text(r), /^Saved \[decision\] \(id: [0-9a-f-]{36}\)\n.*\ntags: db\n\[embedded\]$/);
    assert.deepEqual([...(await sql`select embedding is not null as has_vec, source_agent from memories`)], [{ has_vec: true, source_agent: "codex" }]);
  });

  test("when embedding fails the memory is still saved, and the reply says so", async () => {
    const r = await call("mem_add", { content: "Saved without a vector" }, fakeEmbedder("fail"));
    assert.match(text(r), /\[not embedded yet/);
    assert.equal((await sql`select embedding is null as no_vec from memories`)[0].no_vec, true);
  });

  test("a server without an embedding key never promises a retry", async () => {
    const off = { ...fakeEmbedder(), enabled: false, embed: async () => null };
    const id = idOf(text(await call("mem_add", { content: "No key configured" }, off)));
    assert.doesNotMatch(text(await call("mem_add", { content: "Another one" }, off)), /embed/);
    assert.doesNotMatch(text(await call("mem_update", { id, content: "Changed" }, off)), /embed/);
  });

  test("duplicate hints never include the excluded row, even when it is the closest match", async () => {
    const content = "Chose Postgres over MongoDB for the billing database";
    const [id] = await seed(sql, [{ content }]);
    const vector = toVectorLiteral(fakeVector(content));
    const hints = async (excludeId: string) =>
      (await similarMemories(sql, vector, { excludeId, minSimilarity: 0.5, limit: 3 })).map((r) => r.id);
    assert.deepEqual(await hints(id), []);
    assert.deepEqual(await hints("00000000-0000-4000-8000-000000000000"), [id]);
  });

  test("if the duplicate-hint query fails, the saved memory is still reported as saved", async () => {
    const flaky = new Proxy(sql, {
      apply(target, self, args: [TemplateStringsArray, ...unknown[]]) {
        if (Array.isArray(args[0]) && args[0].join("").includes("with knn")) throw new Error("connection reset");
        return Reflect.apply(target, self, args);
      },
    });
    const r = await callTool("mem_add", { content: "Saved despite a hint failure" }, async () => ({ sql: flaky, embedder, config: CONFIG }), () => {});
    assert.equal(r.isError, undefined);
    assert.match(text(r), /^Saved \[general\]/);
    assert.equal(await count(), 1);
  });

  test("near-duplicates come back as hints, never including the new memory itself", async () => {
    const first = idOf(text(await call("mem_add", { content: "Chose Postgres over MongoDB for the billing database" })));
    const out = text(await call("mem_add", { content: "We chose Postgres over MongoDB for the billing database" }));
    const newId = idOf(out);
    assert.match(out, /Similar memories already saved/);
    const hints = out.slice(out.indexOf("Similar memories"));
    assert.ok(hints.includes(`[${first}]`));
    assert.ok(!hints.includes(`[${newId}]`));
    assert.doesNotMatch(text(await call("mem_add", { content: "Bicycle tire pressure is 4.5 bar" })), /Similar memories/);
    assert.doesNotMatch(text(await call("mem_add", { content: "We chose Postgres over MongoDB again" }, fakeEmbedder("fail"))), /Similar memories/);
  });

  test("mem_update re-embeds changed content, and a failed re-embed clears the stale vector", async () => {
    const id = idOf(text(await call("mem_add", { content: "Original wording" })));
    assert.match(text(await call("mem_update", { id, content: "Completely new wording" }, fakeEmbedder("fail"))), /\[embedding cleared: retried automatically\]$/);
    assert.equal((await sql`select embedding is null as n from memories`)[0].n, true);
    assert.match(text(await call("mem_update", { id, content: "Completely new wording again" })), /\[re-embedded\]$/);
    assert.equal((await sql`select embedding is null as n from memories`)[0].n, false);
    assert.doesNotMatch(text(await call("mem_update", { id, tags: ["x"] })), /embed/);
  });

  test("mem_update with unchanged content keeps the vector even if re-embedding fails", async () => {
    const id = idOf(text(await call("mem_add", { content: "Same words" })));
    const out = text(await call("mem_update", { id, content: "Same words", tags: ["kept"] }, fakeEmbedder("fail")));
    assert.doesNotMatch(out, /embed/);
    assert.match(out, /tags: kept$/);
    assert.equal((await sql`select embedding is not null as v from memories`)[0].v, true);
  });

  test("mem_update can clear tags, and rejects a bad category without touching the row", async () => {
    const id = idOf(text(await call("mem_add", { content: "Tagged", tags: ["a", "b"] })));
    assert.match(text(await call("mem_update", { id, tags: [] })), /tags: none$/);
    const bad = await call("mem_update", { id, category: "nope" });
    assert.equal(bad.isError, true);
    assert.equal((await sql`select category from memories`)[0].category, "general");
  });

  test("mem_update sets updated_at and keeps created_at", async () => {
    const [id] = await seed(sql, [{ content: "Old note", createdAt: new Date("2026-07-01T00:00:00Z") }]);
    await call("mem_update", { id, category: "decision" });
    const [row] = await sql`select created_at, updated_at, category from memories`;
    assert.equal(row.created_at.toISOString(), "2026-07-01T00:00:00.000Z");
    assert.ok(row.updated_at > row.created_at);
    assert.equal(row.category, "decision");
    assert.match(text(await call("mem_list", {})), /\[2026-07-01, updated \d{4}-\d{2}-\d{2}\]/);
  });

  test("missing and malformed ids give clean errors", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    for (const name of ["mem_get", "mem_delete"]) {
      const r = await call(name, { id: missing });
      assert.equal(r.isError, true);
      assert.equal(text(r), `Error: memory not found: ${missing}`);
    }
    assert.equal((await call("mem_update", { id: missing, content: "x" })).isError, true);
    const bad = await call("mem_get", { id: "x" });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /UUID/);
  });

  test("mem_get returns the whole record but never the vector", async () => {
    const id = idOf(text(await call("mem_add", { content: "x".repeat(900) })));
    const got = JSON.parse(text(await call("mem_get", { id })));
    assert.equal(got.content.length, 900);
    assert.equal(got.has_embedding, true);
    assert.equal("embedding" in got, false);
  });

  test("mem_delete removes the row", async () => {
    const id = idOf(text(await call("mem_add", { content: "Temporary" })));
    assert.equal(text(await call("mem_delete", { id })), `Deleted memory: ${id}`);
    assert.equal(await count(), 0);
  });

  test("mem_list: newest first, filters, and a message when empty", async () => {
    assert.equal(text(await call("mem_list", {})), "No memories found.");
    await seed(sql, [
      { content: "older", agent: "codex", category: "fact", createdAt: new Date("2026-07-01T00:00:00Z") },
      { content: "newer", agent: "hermes", category: "decision", createdAt: new Date("2026-08-01T00:00:00Z") },
    ]);
    assert.deepEqual(text(await call("mem_list", {})).split("\n").map((l) => l.split("] ").pop()), ["newer", "older"]);
    assert.match(text(await call("mem_list", { agent: "codex" })), /older$/);
    assert.match(text(await call("mem_list", { category: "decision" })), /newer$/);
    assert.equal(text(await call("mem_list", { max: 1 })).split("\n").length, 1);
  });

  test("mem_stats counts everything in one go", async () => {
    await seed(sql, [
      { content: "a", agent: "codex", category: "fact" },
      { content: "b", agent: "codex", category: "decision" },
      { content: "c", agent: "hermes", category: "fact", embedded: false },
    ]);
    assert.equal(text(await call("mem_stats", {})),
      "Total: 3\nWithout embedding: 1\n\nBy agent:\n  codex: 2\n  hermes: 1\n\nBy category:\n  fact: 2\n  decision: 1");
  });

  test("backfill fills missing vectors, skips rows edited meanwhile, and leaves updated_at alone", async () => {
    const [a, b] = await seed(sql, [
      { content: "needs a vector", embedded: false, createdAt: new Date("2026-07-01T00:00:00Z") },
      { content: "edited during backfill", embedded: false, createdAt: new Date("2026-07-02T00:00:00Z") },
    ]);
    const e = fakeEmbedder();
    e.beforeReturn = async (t) => {
      if (t === "edited during backfill") await sql`update memories set content = 'edited text' where id = ${b}`;
    };
    assert.deepEqual(await backfillEmbeddings(sql, e, { limit: 50, timeoutMs: 300 }), { filled: 1, skipped: 1, failed: 0 });
    const rows = await sql`select id, embedding is not null as has_vec, updated_at from memories order by created_at`;
    assert.equal(rows[0].id, a);
    assert.equal(rows[0].has_vec, true);
    assert.equal(rows[0].updated_at.toISOString(), "2026-07-01T00:00:00.000Z");
    assert.equal(rows[1].has_vec, false);
  });

  test("backfill works through every batch in one run and leaves blank rows alone", async () => {
    await seed(sql, [
      ...Array.from({ length: 5 }, (_, i) => ({ content: `missing vector ${i}`, embedded: false })),
      { content: "", embedded: false, createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const e = fakeEmbedder();
    assert.deepEqual(await backfillEmbeddings(sql, e, { limit: 2, timeoutMs: 300 }), { filled: 5, skipped: 0, failed: 0 });
    assert.equal(e.calls, 5);
    assert.equal((await sql`select count(*)::int as n from memories where embedding is null`)[0].n, 1);
  });

  test("a row that keeps failing is tried once per run, so it cannot block the rest", async () => {
    await seed(sql, [
      { content: "always fails", embedded: false, createdAt: new Date("2026-01-01T00:00:00Z") },
      { content: "fine one", embedded: false },
      { content: "fine two", embedded: false },
    ]);
    const e = fakeEmbedder();
    const ok = e.embed.bind(e);
    e.embed = async (t, o) => (t === "always fails" ? null : ok(t, o));
    assert.deepEqual(await backfillEmbeddings(sql, e, { limit: 1, timeoutMs: 300 }), { filled: 2, skipped: 0, failed: 1 });
  });

  test("20 concurrent adds all succeed", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call("mem_add", { content: `parallel memory ${i}` })));
    assert.ok(results.every((r) => !r.isError));
    assert.equal(await count(), 20);
  });
});
