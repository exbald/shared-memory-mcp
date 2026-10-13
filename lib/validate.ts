// Input checks for every tool. Runs before any database work, so bad input never reaches SQL.
// Writes are strict; reads degrade (a long query is cut, a filter may hold any stored value).
import { sliceSafe } from "./text.ts";

export const CATEGORIES = ["general", "preference", "decision", "fact", "project", "person", "system"] as const;

export const LIMITS = {
  content: 10_000, query: 1_000, filter: 1_000, tag: 64, tags: 20, agent: 64, maxDefault: 20, maxCap: 50,
} as const;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AddInput {
  content: string;
  category: string;
  tags: string[];
  agent: string;
}
export interface UpdateInput {
  id: string;
  content?: string;
  category?: string;
  tags?: string[];
  agent?: string;
}
export interface Filters {
  tag?: string;
  category?: string;
  agent?: string;
}
export interface SearchInput extends Filters {
  query: string;
  max: number;
}
export interface ListInput extends Filters {
  max: number;
}

type Args = Record<string, unknown>;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const asArgs = (x: unknown): Args => (x && typeof x === "object" && !Array.isArray(x) ? (x as Args) : {});
// Control characters have no place in a memory, and some (U+001C-U+001E, U+0085) split lines in
// Python clients. Tab, newline and carriage return stay.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const clean = (s: string) => s.replace(CONTROL, "").trim();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (x: unknown): x is string => typeof x === "string" && UUID.test(x);

/** Out-of-range values are clamped, never rejected: clients may send any number. */
export function clampMax(x: unknown, fallback: number = LIMITS.maxDefault): number {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(LIMITS.maxCap, Math.max(1, Math.trunc(n)));
}

/** Trims and dedupes; keeps case, because existing tags include names and acronyms. */
export function normalizeTags(x: unknown): Result<string[]> {
  if (x === undefined || x === null) return ok([]);
  const raw = typeof x === "string" ? x.split(",") : x;
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) return fail("tags must be a list of strings");
  const tags = [...new Set((raw as string[]).map(clean).filter(Boolean))];
  if (tags.length > LIMITS.tags) return fail(`at most ${LIMITS.tags} tags`);
  if (tags.some((t) => t.length > LIMITS.tag)) return fail(`each tag must be at most ${LIMITS.tag} characters`);
  return ok(tags);
}

function category(x: unknown): Result<string | undefined> {
  if (x === undefined || x === null || x === "") return ok(undefined);
  if (typeof x !== "string" || !(CATEGORIES as readonly string[]).includes(x)) {
    return fail(`category must be one of: ${CATEGORIES.join(", ")}`);
  }
  return ok(x);
}

/** "required": must be present and non-empty. "optional": absent or empty means undefined. */
function text(x: unknown, field: string, max: number, mode: "required" | "optional"): Result<string | undefined> {
  if (x === undefined || x === null) return mode === "required" ? fail(`${field} is required`) : ok(undefined);
  if (typeof x !== "string") return fail(`${field} must be a string`);
  const value = clean(x);
  if (!value) return mode === "required" ? fail(`${field} must not be empty`) : ok(undefined);
  if (value.length > max) return fail(`${field} must be at most ${max} characters`);
  return ok(value);
}

/** An agent name as stored: brackets would let it fake the `[agent] [category]` fields of a result line. */
function agentName(x: unknown, mode: "required" | "optional"): Result<string | undefined> {
  const name = text(x, "agent", LIMITS.agent, mode);
  if (name.ok && name.value && /[[\]]/.test(name.value)) return fail("agent must not contain [ or ]");
  return name;
}

function filters(a: Args): Result<Filters> {
  const out: Filters = {};
  const cat = category(a.category);
  if (!cat.ok) return cat;
  if (cat.value) out.category = cat.value;
  const tag = text(a.tag, "tag", LIMITS.filter, "optional");
  if (!tag.ok) return tag;
  if (tag.value) out.tag = tag.value;
  const agent = text(a.agent, "agent", LIMITS.filter, "optional");
  if (!agent.ok) return agent;
  if (agent.value) out.agent = agent.value;
  return ok(out);
}

/** Cut to LIMITS.query rather than rejected: a long question still deserves an answer. */
function queryText(x: unknown): Result<string> {
  if (x === undefined || x === null) return ok("");
  if (typeof x !== "string") return fail("query must be a string");
  return ok(sliceSafe(clean(x), LIMITS.query).trim());
}

/** Clients that send null for every unset field mean "leave it alone". */
const given = (x: unknown) => x !== undefined && x !== null;

export function parseAdd(input: unknown): Result<AddInput> {
  const a = asArgs(input);
  const content = text(a.content, "content", LIMITS.content, "required");
  if (!content.ok) return content;
  const cat = category(a.category);
  if (!cat.ok) return cat;
  const tags = normalizeTags(a.tags);
  if (!tags.ok) return tags;
  const agent = agentName(a.agent, "optional");
  if (!agent.ok) return agent;
  return ok({ content: content.value as string, category: cat.value ?? "general", tags: tags.value, agent: agent.value ?? "unknown" });
}

export function parseUpdate(input: unknown): Result<UpdateInput> {
  const a = asArgs(input);
  if (!isUuid(a.id)) return fail("id must be a UUID");
  const out: UpdateInput = { id: a.id };
  if (given(a.content)) {
    const c = text(a.content, "content", LIMITS.content, "required");
    if (!c.ok) return c;
    out.content = c.value;
  }
  if (given(a.category)) {
    const c = category(a.category);
    if (!c.ok) return c;
    if (c.value) out.category = c.value;
  }
  if (given(a.tags)) {
    const t = normalizeTags(a.tags);
    if (!t.ok) return t;
    out.tags = t.value;
  }
  if (given(a.agent)) {
    const g = agentName(a.agent, "required");
    if (!g.ok) return g;
    out.agent = g.value;
  }
  if (Object.keys(out).length === 1) return fail("nothing to update: give content, category, tags or agent");
  return ok(out);
}

export function parseSearch(input: unknown): Result<SearchInput> {
  const a = asArgs(input);
  const query = queryText(a.query);
  if (!query.ok) return query;
  const f = filters(a);
  if (!f.ok) return f;
  return ok({ query: query.value, ...f.value, max: clampMax(a.max) });
}

export function parseList(input: unknown): Result<ListInput> {
  const a = asArgs(input);
  const f = filters(a);
  if (!f.ok) return f;
  return ok({ max: clampMax(a.max), ...f.value });
}

export function parseId(input: unknown): Result<{ id: string }> {
  const a = asArgs(input);
  return isUuid(a.id) ? ok({ id: a.id }) : fail("id must be a UUID");
}
