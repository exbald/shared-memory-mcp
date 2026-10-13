import { readFileSync } from "node:fs";
import type { Sql } from "./types.ts";

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** Creates or upgrades the memories table. Safe on every boot, and from several processes at once. */
export async function ensureSchema(sql: Sql): Promise<void> {
  await sql.begin((tx) => tx.unsafe(SCHEMA).simple());
}
