// The HTTP layer: POST /mcp (and /api/mcp, the v1 path) answers MCP JSON-RPC as one SSE message,
// the framing every client and skill/scripts/mem.py already parse. GET /health checks the database.
import http from "node:http";
import type { Logger } from "./log.ts";
import { handleRpc, isAuthorized } from "./rpc.ts";
import type { ToolDeps } from "./tools.ts";

const MAX_BODY_BYTES = 1_000_000;
const MCP_PATHS = new Set(["/mcp", "/api/mcp"]);

export interface AppOptions {
  /** Empty means no authentication. */
  apiKey: string;
  getDeps: () => Promise<ToolDeps>;
  health: () => Promise<boolean>;
  log: Logger;
}

class BodyTooLarge extends Error {}

/** At most MAX_BODY_BYTES; a declared Content-Length over the limit is refused without reading. */
async function readBody(req: http.IncomingMessage): Promise<string> {
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw new BodyTooLarge();
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

// Valid inside JSON strings, but line-based readers (Python's str.splitlines, for one) break
// lines on them, which would cut the SSE `data:` line in two. JSON.stringify already escapes C0.
const LINE_BREAKERS = /[\u0085\u2028\u2029]/g;
const escapeLineBreakers = (json: string) =>
  json.replace(LINE_BREAKERS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function sendSse(res: http.ServerResponse, body: unknown): void {
  res
    .writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    .end(`event: message\ndata: ${escapeLineBreakers(JSON.stringify(body))}\n\n`);
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, path: string, opts: AppOptions): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version",
    });
    res.end();
    return;
  }
  if (!isAuthorized({ headers: req.headers, url: req.url }, opts.apiKey)) {
    opts.log({ event: "unauthorized", path });
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  // No server-initiated stream and no sessions: the spec's answer for GET and DELETE is 405.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let msg: unknown;
  try {
    msg = JSON.parse(await readBody(req));
  } catch (err) {
    if (err instanceof BodyTooLarge) sendJson(res, 413, { error: "Request body too large" });
    else sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  const reply = await handleRpc(msg, opts.getDeps, opts.log);
  if (reply.status === 202) res.writeHead(202).end();
  else if (reply.status === 400) sendJson(res, 400, reply.body);
  else sendSse(res, reply.body);
}

/** The request path, or null when the target does not parse (such as `//`). */
function pathOf(url: string | undefined): string | null {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, opts: AppOptions): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const path = pathOf(req.url);
  try {
    if (path === null) {
      sendJson(res, 400, { error: "Bad request" });
    } else if (path === "/health") {
      const ok = await opts.health().catch(() => false);
      sendJson(res, ok ? 200 : 503, { ok });
    } else if (MCP_PATHS.has(path)) {
      await handleMcp(req, res, path, opts);
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  } catch (err) {
    opts.log({ event: "request_error", path, error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
    else res.end();
  }
}

export function createApp(opts: AppOptions): http.Server {
  return http.createServer((req, res) => {
    // Last line of defence: an exception escaping here would otherwise end the process.
    route(req, res, opts).catch(() => res.destroy());
  });
}
