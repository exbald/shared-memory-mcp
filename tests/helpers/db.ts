// Integration-test database helpers. Tests that need Postgres skip themselves unless
// TEST_DATABASE_URL is set, which docker-compose.test.yml does.
import postgres from "postgres";
import type { Sql } from "../../lib/types.ts";
import { ensureSchema } from "../../lib/schema.ts";
import { toVectorLiteral } from "../../lib/embeddings.ts";
import { fakeVector } from "./fake-embedder.ts";

export const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
export const skipWithoutDb: string | false = TEST_URL ? false : "TEST_DATABASE_URL not set (run `npm test`)";

export function testSql(): Sql {
  return postgres(TEST_URL, { max: 4, onnotice: () => {} });
}

export async function freshSchema(sql: Sql): Promise<void> {
  await sql`drop table if exists memories`;
  await ensureSchema(sql);
}

export interface SeedRow {
  content: string;
  category?: string;
  tags?: string[];
  agent?: string;
  createdAt?: Date;
  embedded?: boolean;
}

/** Inserts rows with explicit timestamps; returns their ids in order. */
export async function seed(sql: Sql, rows: SeedRow[]): Promise<string[]> {
  const ids: string[] = [];
  for (const r of rows) {
    const vector = r.embedded === false ? null : toVectorLiteral(fakeVector(r.content));
    const at = r.createdAt ?? new Date();
    const [row] = await sql<{ id: string }[]>`
      insert into memories (content, category, tags, source_agent, embedding, created_at, updated_at)
      values (${r.content}, ${r.category ?? "fact"}, ${sql.array(r.tags ?? [])}::text[], ${r.agent ?? "test"},
              ${vector}::vector, ${at}, ${at})
      returning id`;
    ids.push(row.id);
  }
  return ids;
}

/** n unrelated, recent filler memories (newer than anything seeded with an older createdAt). */
export function fillers(n: number, start = new Date("2026-10-01T00:00:00Z")): SeedRow[] {
  const topics = ["kitchen renovation budget", "weekly running schedule", "garden tomato watering", "guitar practice routine",
    "travel packing list", "bicycle tire pressure", "coffee grinder settings", "photo backup folders"];
  return Array.from({ length: n }, (_, i) => ({
    content: `Note ${i}: ${topics[i % topics.length]} item ${i}`,
    createdAt: new Date(start.getTime() + i * 60_000),
  }));
}
