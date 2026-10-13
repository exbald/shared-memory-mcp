// Entry point: `node server.ts` (Node 24 runs the TypeScript directly). Prepares the database,
// serves MCP on PORT, and keeps filling in embeddings that failed at save time.
import { createApp } from "./lib/app.ts";
import { cached, createSql, loadConfig, ping, retry } from "./lib/deps.ts";
import { createEmbedder } from "./lib/embeddings.ts";
import { log } from "./lib/log.ts";
import { backfillEmbeddings } from "./lib/memories.ts";
import { ensureSchema } from "./lib/schema.ts";
import type { ToolDeps } from "./lib/tools.ts";

const BACKFILL_EVERY_MS = 60 * 60 * 1000;
const BACKFILL_BATCH = 50;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** On boot, then hourly; one run at a time. */
function startBackfill(deps: ToolDeps): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const counts = await backfillEmbeddings(deps.sql, deps.embedder, { limit: BACKFILL_BATCH, timeoutMs: deps.config.writeTimeoutMs });
      if (counts.filled || counts.failed || counts.skipped) log({ event: "backfill", ...counts });
    } catch (err) {
      log({ event: "backfill_error", error: errorText(err) });
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, BACKFILL_EVERY_MS);
  return () => clearInterval(timer);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const sql = createSql(config.databaseUrl, config.poolMax);
  // The database may still be starting (fresh container, rolling deploy): about 30 s of retries.
  await retry(() => ensureSchema(sql), {
    attempts: 10,
    delayMs: 3000,
    onRetry: (attempt, err) => log({ event: "schema_retry", attempt, error: errorText(err) }),
  });

  const embedder = createEmbedder({ apiKey: config.embeddingApiKey });
  const deps: ToolDeps = { sql, embedder, config: config.tools };
  if (!config.apiKey) log({ event: "warning", message: "MCP_ALLOW_NO_AUTH=1: /mcp accepts requests without a key" });
  if (!embedder.enabled) log({ event: "warning", message: "EMBEDDING_API_KEY is not set: search uses keywords only" });

  const health = cached(() => ping(sql, 2000), 2000);
  const server = createApp({ apiKey: config.apiKey, getDeps: async () => deps, health, log });
  server.listen(config.port, "0.0.0.0", () => log({ event: "listening", port: config.port }));
  const stopBackfill = startBackfill(deps);

  const shutdown = (signal: string) => {
    log({ event: "shutdown", signal });
    stopBackfill();
    setTimeout(() => process.exit(1), 10_000).unref(); // never hang a redeploy
    server.close(() => {
      sql.end({ timeout: 5 }).finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log({ event: "fatal", error: errorText(err) });
  process.exit(1);
});
