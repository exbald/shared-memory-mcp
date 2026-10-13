import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRpc, isAuthorized, type RpcReply } from "../lib/rpc.ts";
import type { ToolDeps } from "../lib/tools.ts";

const noDeps = async (): Promise<ToolDeps> => {
  throw new Error("this test must not touch the database");
};

/** The JSON-RPC body of a reply that has one (everything but a 202). */
function bodyOf<T>(r: RpcReply): T {
  assert.ok("body" in r, `expected a body, got status ${r.status}`);
  return r.body as T;
}

type ToolCallBody = { result: { isError: boolean; content: { text: string }[] } };
type ErrorBody = { error: { code: number } };

test("auth: the key works in any of the three places, Bearer is case-insensitive, any match wins", () => {
  const k = "secret-key";
  assert.ok(isAuthorized({ headers: { "x-api-key": k }, url: "/mcp" }, k));
  assert.ok(isAuthorized({ headers: { authorization: `Bearer ${k}` }, url: "/mcp" }, k));
  assert.ok(isAuthorized({ headers: { authorization: `bearer ${k}` }, url: "/mcp" }, k));
  assert.ok(isAuthorized({ headers: {}, url: `/mcp?key=${k}` }, k));
  assert.ok(isAuthorized({ headers: { authorization: "Bearer stale" }, url: `/mcp?key=${k}` }, k));
  assert.ok(!isAuthorized({ headers: { "x-api-key": "wrong" }, url: "/mcp?key=wrong" }, k));
  assert.ok(!isAuthorized({ headers: {}, url: "/mcp" }, k));
  assert.ok(isAuthorized({ headers: {}, url: "/mcp" }, ""), "no key configured means open");
  assert.ok(isAuthorized({ headers: { authorization: k }, url: "/mcp" }, k), "a bare Authorization value worked in v1");
  assert.ok(!isAuthorized({ headers: {}, url: "//[" }, k), "an unparseable URL is simply unauthorized");
});

test("initialize, tools/list and ping", async () => {
  const init = bodyOf<{ result: { serverInfo: { name: string }; protocolVersion: string } }>(
    await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, noDeps),
  );
  assert.equal(init.result.serverInfo.name, "shared-memory");
  assert.ok(init.result.protocolVersion);

  const list = bodyOf<{ result: { tools: { name: string; inputSchema: { properties: object } }[] } }>(
    await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, noDeps),
  );
  const shape = Object.fromEntries(list.result.tools.map((t) => [t.name, Object.keys(t.inputSchema.properties).sort()]));
  assert.deepEqual(shape, {
    mem_add: ["agent", "category", "content", "tags"],
    mem_search: ["agent", "category", "max", "query", "tag"],
    mem_list: ["agent", "category", "max"],
    mem_get: ["id"],
    mem_update: ["agent", "category", "content", "id", "tags"],
    mem_delete: ["id"],
    mem_stats: [],
  });

  assert.deepEqual(bodyOf(await handleRpc({ jsonrpc: "2.0", id: 3, method: "ping" }, noDeps)), { jsonrpc: "2.0", id: 3, result: {} });
});

test("initialize echoes a protocol version it knows, and answers 2025-03-26 otherwise", async () => {
  const version = async (asked?: string) =>
    bodyOf<{ result: { protocolVersion: string } }>(
      await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: asked } }, noDeps),
    ).result.protocolVersion;
  assert.equal(await version("2024-11-05"), "2024-11-05");
  assert.equal(await version("2025-03-26"), "2025-03-26");
  assert.equal(await version("2099-01-01"), "2025-03-26");
  assert.equal(await version(undefined), "2025-03-26");
});

test("unknown method is -32601, unknown tool is -32602, notifications get 202", async () => {
  assert.equal(bodyOf<ErrorBody>(await handleRpc({ jsonrpc: "2.0", id: 4, method: "nope" }, noDeps)).error.code, -32601);
  const unknownTool = await handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mem_nope", arguments: {} } }, noDeps);
  assert.equal(bodyOf<ErrorBody>(unknownTool).error.code, -32602);
  assert.deepEqual(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, noDeps), { status: 202 });
  assert.equal(bodyOf<ErrorBody>(await handleRpc("not an object", noDeps)).error.code, -32600);
});

test("bad tool input comes back as an isError result, before any database work", async () => {
  const r = await handleRpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "mem_get", arguments: { id: "x" } } }, noDeps, () => {});
  const { result } = bodyOf<ToolCallBody>(r);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Error: .*UUID/);
});

test("a database failure becomes a short generic error, never raw SQL", async () => {
  const broken = async (): Promise<ToolDeps> => ({
    sql: (() => { throw new Error('relation "memories" does not exist SELECT secret'); }) as unknown as ToolDeps["sql"],
    embedder: { enabled: false, embed: async () => null },
    config: { minSimilarity: 0.3, dedupSimilarity: 0.82, queryTimeoutMs: 100, writeTimeoutMs: 100 },
  });
  const r = await handleRpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mem_stats", arguments: {} } }, broken, () => {});
  const { result } = bodyOf<ToolCallBody>(r);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Error: the memory store is unavailable right now; try again shortly.");
});
