// The seven MCP tools: schemas (names and arguments unchanged since v1), validation and dispatch.
import { randomUUID } from "node:crypto";
import type { Embedder } from "./embeddings.ts";
import { formatAdded, formatGet, formatList, formatSearch, formatStats, formatUpdated } from "./format.ts";
import { log as defaultLog, type Logger } from "./log.ts";
import {
  addMemory, deleteMemory, getMemory, listMemories, memoryStats, similarMemories, updateMemory,
} from "./memories.ts";
import { searchMemories } from "./search.ts";
import type { Sql } from "./types.ts";
import { CATEGORIES, LIMITS, parseAdd, parseId, parseList, parseSearch, parseUpdate, type Result } from "./validate.ts";

export interface ToolConfig {
  /** Cosine floor for the meaning half of search. */
  minSimilarity: number;
  /** Cosine at or above which mem_add lists an existing memory as a likely duplicate. */
  dedupSimilarity: number;
  queryTimeoutMs: number;
  writeTimeoutMs: number;
}

export interface ToolDeps {
  sql: Sql;
  embedder: Embedder;
  config: ToolConfig;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

const DUPLICATE_HINTS = 3;
const UNAVAILABLE = "the memory store is unavailable right now; try again shortly.";

const category = { type: "string", enum: [...CATEGORIES] };
const max = { type: "number", minimum: 1, maximum: LIMITS.maxCap, default: LIMITS.maxDefault, description: "Max results" };
const id = (what: string) => ({ type: "string", description: `UUID of the memory${what}` });

export const TOOLS = [
  {
    name: "mem_add",
    description:
      "Save a memory to the shared store. The reply lists similar memories already saved, so you can update or merge instead of keeping a duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content to save" },
        category: { ...category, default: "general", description: "Category" },
        tags: { type: "array", items: { type: "string" }, default: [], description: "Tags for filtering" },
        agent: { type: "string", default: "unknown", description: "Which agent is saving this" },
      },
      required: ["content"],
    },
  },
  {
    name: "mem_search",
    description:
      "Search all memories by meaning and by keyword (hybrid). Exact words, phrases, code identifiers and paraphrases all work. An empty query lists the newest memories. Filter by tag, category or agent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
        tag: { type: "string", description: "Filter by tag" },
        category: { ...category, description: "Filter by category" },
        agent: { type: "string", description: "Filter by the agent that saved it" },
        max,
      },
    },
  },
  {
    name: "mem_list",
    description: "List the newest memories, optionally filtered by category or agent.",
    inputSchema: {
      type: "object",
      properties: { max, category: { ...category, description: "Filter by category" }, agent: { type: "string", description: "Filter by agent" } },
    },
  },
  {
    name: "mem_get",
    description: "Get one memory in full by UUID (search and list shorten long memories).",
    inputSchema: { type: "object", properties: { id: id("") }, required: ["id"] },
  },
  {
    name: "mem_update",
    description:
      "Update a memory by UUID. Only the fields you pass change; created_at is kept, updated_at is set, and changed content is re-embedded.",
    inputSchema: {
      type: "object",
      properties: {
        id: id(" to update"),
        content: { type: "string", description: "New content" },
        category: { ...category, description: "New category" },
        tags: { type: "array", items: { type: "string" }, description: "New tags (replace the old ones)" },
        agent: { type: "string", description: "New source agent" },
      },
      required: ["id"],
    },
  },
  {
    name: "mem_delete",
    description: "Delete a memory by UUID.",
    inputSchema: { type: "object", properties: { id: id(" to delete") }, required: ["id"] },
  },
  {
    name: "mem_stats",
    description: "Counts: total memories, how many lack an embedding, and totals by agent and by category.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];
const NAMES = new Set<string>(TOOLS.map((t) => t.name));
export const isToolName = (name: unknown): name is ToolName => typeof name === "string" && NAMES.has(name);

const reply = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const failure = (message: string): ToolResult => ({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
const notFound = (id: string) => failure(`memory not found: ${id}`);

/** Validates first, so bad input never reaches the database; database failures become a generic error. */
export async function callTool(
  name: string,
  args: unknown,
  getDeps: () => Promise<ToolDeps>,
  log: Logger = defaultLog,
): Promise<ToolResult> {
  if (!isToolName(name)) return failure(`unknown tool: ${name}`);
  const run = HANDLERS[name](args);
  if (!run.ok) return failure(run.error);
  try {
    return await run.value(await getDeps(), log);
  } catch (err) {
    log({ event: "tool_error", tool: name, error: errorText(err) });
    return failure(UNAVAILABLE);
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Run = (deps: ToolDeps, log: Logger) => Promise<ToolResult>;
type Handler = (args: unknown) => Result<Run>;

const bind = <T>(parsed: Result<T>, run: (input: T, deps: ToolDeps, log: Logger) => Promise<ToolResult>): Result<Run> =>
  parsed.ok ? { ok: true, value: (deps, log) => run(parsed.value, deps, log) } : parsed;

const HANDLERS: Record<ToolName, Handler> = {
  mem_add: (args) =>
    bind(parseAdd(args), async (input, { sql, embedder, config }, log) => {
      const embedding = await embedder.embed(input.content, { timeoutMs: config.writeTimeoutMs });
      const newId = randomUUID();
      // Hints are a courtesy. If they fail, the insert may already have committed, and calling
      // the whole save a failure would invite a retry, and with it a duplicate.
      const hints = embedding
        ? similarMemories(sql, embedding, { excludeId: newId, minSimilarity: config.dedupSimilarity, limit: DUPLICATE_HINTS })
            .catch((err) => {
              log({ event: "hint_error", error: errorText(err) });
              return [];
            })
        : Promise.resolve([]);
      const [row, similar] = await Promise.all([addMemory(sql, { ...input, id: newId, embedding }), hints]);
      return reply(formatAdded(row, { embedded: embedder.enabled ? embedding !== null : null, similar }));
    }),

  mem_search: (args) =>
    bind(parseSearch(args), async (input, { sql, embedder, config }) => {
      const { rows, keywordOnly } = await searchMemories(sql, embedder, input, config);
      return reply(formatSearch(rows, { keywordOnly }));
    }),

  mem_list: (args) => bind(parseList(args), async (input, { sql }) => reply(formatList(await listMemories(sql, input)))),

  mem_get: (args) =>
    bind(parseId(args), async ({ id }, { sql }) => {
      const row = await getMemory(sql, id);
      return row ? reply(formatGet(row)) : notFound(id);
    }),

  mem_update: (args) =>
    bind(parseUpdate(args), async (input, { sql, embedder, config }) => {
      const embedding = input.content === undefined ? null : await embedder.embed(input.content, { timeoutMs: config.writeTimeoutMs });
      const row = await updateMemory(sql, input, embedding);
      if (!row) return notFound(input.id);
      return reply(formatUpdated(row, { contentChanged: row.content_changed, embedded: embedder.enabled ? row.embedded : null }));
    }),

  mem_delete: (args) =>
    bind(parseId(args), async ({ id }, { sql }) => ((await deleteMemory(sql, id)) ? reply(`Deleted memory: ${id}`) : notFound(id))),

  mem_stats: () => bind({ ok: true, value: null }, async (_, { sql }) => reply(formatStats(await memoryStats(sql)))),
};
