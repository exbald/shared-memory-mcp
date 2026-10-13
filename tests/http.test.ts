import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import type { Sql } from "../lib/types.ts";
import { createApp } from "../lib/app.ts";
import { ping } from "../lib/deps.ts";
import { fakeEmbedder } from "./helpers/fake-embedder.ts";
import { freshSchema, skipWithoutDb, testSql } from "./helpers/db.ts";

const CONFIG = { minSimilarity: 0.3, dedupSimilarity: 0.82, queryTimeoutMs: 300, writeTimeoutMs: 300 };
const silent = () => {};
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server) => new Promise((r) => s.close(r));

describe("HTTP server", { skip: skipWithoutDb }, () => {
  let sql: Sql;
  let server: Server;
  let base: string;

  before(async () => {
    sql = testSql();
    await freshSchema(sql);
    server = createApp({ apiKey: "test-key", getDeps: async () => ({ sql, embedder: fakeEmbedder(), config: CONFIG }), health: () => ping(sql, 2000), log: silent });
    base = await listen(server);
  });
  after(async () => {
    await close(server);
    await sql.end();
  });

  /** The same request and SSE parsing that skill/scripts/mem.py does. */
  async function mcp(method: string, params: unknown, key = "test-key") {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const raw = await res.text();
    const payload = raw.includes("data:") ? raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n") : raw;
    return { status: res.status, body: payload ? JSON.parse(payload) : null };
  }

  test("tools/call works without initialize, framed like the old server", async () => {
    const r = await mcp("tools/call", { name: "mem_add", arguments: { content: "hello over http" } });
    assert.equal(r.status, 200);
    assert.match(r.body.result.content[0].text, /^Saved \[general\]/);
    const s = await mcp("tools/call", { name: "mem_search", arguments: { query: "hello over http" } });
    assert.match(s.body.result.content[0].text, /^Found 1 memory:/);
  });

  test("a wrong key is rejected with 401", async () => {
    assert.equal((await mcp("tools/list", {}, "wrong")).status, 401);
  });

  test("/health is 200 when the database answers", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test("/health is 503 when the database is unreachable", async () => {
    const dead = postgres("postgres://x:y@127.0.0.1:1/none", { connect_timeout: 1, onnotice: () => {} });
    const app = createApp({ apiKey: "", getDeps: async () => { throw new Error("unused"); }, health: () => ping(dead, 1500), log: silent });
    const url = await listen(app);
    assert.equal((await fetch(`${url}/health`)).status, 503);
    await close(app);
    await dead.end({ timeout: 1 });
  });

  test("bad JSON is a 400 parse error, and unknown paths are 404", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" }, body: "{not json" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  test("GET and DELETE are 405 (no server stream, no sessions); CORS preflight needs no key", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${base}/mcp`, { method, headers: { "x-api-key": "test-key" } });
      assert.equal(res.status, 405, method);
      await res.body?.cancel();
    }
    const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /X-API-Key/);
  });

  test("a notification gets 202 with no body, and the v1 path /api/mcp still works", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
    const v1 = await fetch(`${base}/api/mcp?key=test-key`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) });
    assert.equal(v1.status, 200);
    assert.match(await v1.text(), /^event: message\ndata: \{"jsonrpc":"2.0","id":9,"result":\{\}\}\n\n$/);
  });

  test("a malformed request path is a 400, never a crash", { timeout: 10_000 }, async () => {
    for (const path of ["//", "//[", "//%"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: new URL(base).port, path, method: "GET" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.setTimeout(2000, () => req.destroy(new Error(`no answer for ${path}`)));
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 400, path);
    }
    assert.equal((await fetch(`${base}/health`)).status, 200, "still serving");
  });

  test("Unicode line separators inside a memory never break the SSE frame", async () => {
    // Inserted directly, as imported v1 data arrives: mem_add would strip the U+0085.
    const content = "before\u2028middle\u2029after\u0085end";
    const [{ id }] = await sql`insert into memories (content) values (${content}) returning id`;
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mem_get", arguments: { id } } }),
    });
    const raw = await res.text();
    assert.doesNotMatch(raw, /[\u0085\u2028\u2029]/, "escaped in the frame");
    const frame = raw.split("\n").filter((l) => l.startsWith("data:"));
    assert.equal(frame.length, 1);
    assert.equal(JSON.parse(JSON.parse(frame[0].slice(5)).result.content[0].text).content, content, "and intact once parsed");
  });

  test("a rejected key is logged (path only, never the key)", async () => {
    const events: Record<string, unknown>[] = [];
    const app = createApp({ apiKey: "right", getDeps: async () => { throw new Error("unused"); }, health: async () => true, log: (e) => events.push(e) });
    const url = await listen(app);
    await (await fetch(`${url}/mcp?key=wrong-guess`, { method: "POST", body: "{}" })).body?.cancel();
    await close(app);
    assert.deepEqual(events, [{ event: "unauthorized", path: "/mcp" }]);
  });

  test("a body over 1 MB is refused with 413", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "x-api-key": "test-key" }, body: "x".repeat(1_000_001) });
    assert.equal(res.status, 413);
  });
});
