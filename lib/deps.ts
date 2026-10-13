// Configuration and the long-lived dependencies. Nothing here runs at import time.
import postgres from "postgres";
import type { ToolConfig } from "./tools.ts";
import type { Sql } from "./types.ts";

export interface Config {
  databaseUrl: string;
  /** Empty only when MCP_ALLOW_NO_AUTH=1. */
  apiKey: string;
  embeddingApiKey: string;
  port: number;
  poolMax: number;
  tools: ToolConfig;
}

function number(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}, got "${raw}"`);
  return n;
}

/** Reads the environment once at startup. Throws with a clear message on a missing or bad value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is required (a Postgres database with the pgvector extension available)");
  const apiKey = env.MCP_API_KEY?.trim() ?? "";
  if (!apiKey && env.MCP_ALLOW_NO_AUTH !== "1") {
    throw new Error("MCP_API_KEY is required (for example `openssl rand -hex 32`); set MCP_ALLOW_NO_AUTH=1 to run without one");
  }
  return {
    databaseUrl,
    apiKey,
    embeddingApiKey: env.EMBEDDING_API_KEY?.trim() ?? "",
    port: number(env, "PORT", 3000, 1, 65535),
    poolMax: number(env, "PG_POOL_MAX", 5, 1, 100),
    tools: {
      // Calibrated on 638 real memories with text-embedding-3-small: off-topic queries peaked
      // at 0.31 and relevant ones started near 0.47; daily logs of the same job sit at 0.88-0.96,
      // related but distinct notes at 0.80-0.84.
      minSimilarity: number(env, "SEARCH_MIN_SIMILARITY", 0.35, 0, 1),
      dedupSimilarity: number(env, "DEDUP_SIMILARITY", 0.85, 0, 1),
      queryTimeoutMs: 2000, // measured from the VPS: ~0.9 s for a cold connection, 0.2-0.5 s warm
      // With the 3 s statement timeout, a save finishes or fails within skill/scripts/mem.py's
      // 8 s, so a slow save is never retried into a duplicate.
      writeTimeoutMs: 4000,
    },
  };
}

/** Statements and lock waits are capped; the schema step lifts both for itself. */
export function createSql(url: string, max: number): Sql {
  return postgres(url, {
    max,
    idle_timeout: 60,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: "shared-memory-mcp", statement_timeout: 3000, lock_timeout: 2000 },
  });
}

/** True when the database answers `select 1` within timeoutMs. */
export async function ping(sql: Sql, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const query = sql`select 1`.then(() => true, () => false);
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reuses one result (or in-flight call) for ttlMs, so a flood of /health requests costs one query. */
export function cached<T>(fn: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let last: { at: number; value: Promise<T> } | undefined;
  return () => {
    if (!last || now() - last.at >= ttlMs) last = { at: now(), value: fn() };
    return last.value;
  };
}

/** Runs fn until it succeeds, at most `attempts` times, waiting delayMs between tries. */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; delayMs: number; onRetry?: (attempt: number, err: unknown) => void },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.attempts) throw err;
      opts.onRetry?.(attempt, err);
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
  }
}
