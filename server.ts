// Standalone HTTP server for self-hosting (Docker, Coolify). Wraps the same
// handler Vercel runs from api/mcp.ts, adding the small parts of Vercel's
// request/response helpers it relies on: req.body, req.query, res.status(),
// res.json() and res.send(). Serves /mcp and /api/mcp, plus /health.
import http from "node:http";
import handler from "./api/mcp.ts";

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 1_000_000;

function withHelpers(res: http.ServerResponse) {
  const r = res as any;
  r.status = (code: number) => {
    res.statusCode = code;
    return r;
  };
  r.json = (data: unknown) => {
    if (!res.headersSent) res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
    return r;
  };
  r.send = (data: string) => {
    res.end(data);
    return r;
  };
  return r;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const r = withHelpers(res);

  if (url.pathname === "/health") {
    r.status(200).json({ ok: true });
    return;
  }
  if (url.pathname !== "/mcp" && url.pathname !== "/api/mcp") {
    r.status(404).json({ error: "Not found" });
    return;
  }

  try {
    const raw = req.method === "POST" ? await readBody(req) : "";
    const body = raw ? JSON.parse(raw) : undefined;
    const query = Object.fromEntries(url.searchParams);
    await handler(Object.assign(req, { body, query }), r);
  } catch (error) {
    console.error("Request failed:", error);
    if (!res.headersSent) r.status(400).json({ error: "Bad request" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`shared-memory MCP listening on :${PORT} (/mcp, /health)`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
