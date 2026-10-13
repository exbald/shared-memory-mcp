// MCP over JSON-RPC: authentication and method dispatch. Transport-free, so it is tested without HTTP.
import { createHash, timingSafeEqual } from "node:crypto";
import { log as defaultLog, type Logger } from "./log.ts";
import { TOOLS, callTool, isToolName, type ToolDeps } from "./tools.ts";

const SERVER_INFO = { name: "shared-memory", version: "2.0.0" };
// Echo a version we know; anything else gets the version every current client already works with.
const PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];

export type RpcReply = { status: 200 | 400; body: Record<string, unknown> } | { status: 202 };

export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * The key may arrive as X-API-Key, as Authorization (a Bearer token, or the bare key as v1
 * accepted), or as ?key=. Any one matching is enough.
 */
export function isAuthorized(req: AuthRequest, apiKey: string): boolean {
  if (!apiKey) return true;
  const expected = digest(apiKey);
  const header = (name: string) => [req.headers[name] ?? []].flat();
  const bearer = header("authorization").map((v) => /^bearer\s+(.+)$/i.exec(v.trim())?.[1] ?? v.trim());
  const url = req.url ?? "";
  const query = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "").get("key") ?? "";
  return [...header("x-api-key"), ...bearer, query].some((k) => k !== "" && timingSafeEqual(digest(k), expected));
}

const result = (id: unknown, value: unknown): RpcReply => ({ status: 200, body: { jsonrpc: "2.0", id, result: value } });
const error = (id: unknown, code: number, message: string, status: 200 | 400 = 200): RpcReply => ({
  status,
  body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
});

export async function handleRpc(msg: unknown, getDeps: () => Promise<ToolDeps>, log: Logger = defaultLog): Promise<RpcReply> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return error(null, -32600, "Invalid Request", 400);
  const { id, method, params } = msg as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  if (id === undefined) return { status: 202 }; // a notification: nothing to answer
  if (typeof method !== "string") return error(id, -32600, "Invalid Request", 400);

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      const protocolVersion = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return result(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      if (!isToolName(name)) return error(id, -32602, `Unknown tool: ${String(name)}`);
      const started = performance.now();
      const out = await callTool(name, params?.arguments, getDeps, log);
      log({ event: "tool", tool: name, ms: Math.round(performance.now() - started), ok: !out.isError });
      return result(id, out);
    }
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}
