import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;
const API_KEY = process.env.MCP_API_KEY || "";
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// The same model either way, so stored vectors stay comparable: OpenRouter keys
// ("sk-or-…") go through OpenRouter, any other key is sent to OpenAI directly.
const EMBEDDING_ENDPOINT = EMBEDDING_API_KEY.startsWith("sk-or-")
  ? { url: "https://openrouter.ai/api/v1/embeddings", model: "openai/text-embedding-3-small" }
  : { url: "https://api.openai.com/v1/embeddings", model: "text-embedding-3-small" };

async function getEmbedding(text: string): Promise<number[] | null> {
  if (!EMBEDDING_API_KEY) return null;
  try {
    const res = await fetch(EMBEDDING_ENDPOINT.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${EMBEDDING_API_KEY}` },
      body: JSON.stringify({ model: EMBEDDING_ENDPOINT.model, input: text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data[0].embedding;
  } catch {
    return null;
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: any;
  error?: { code: number; message: string };
}

function jsonRpcResponse(id: any, result: any): string {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`;
}

function jsonRpcError(id: any, code: number, message: string): string {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n\n`;
}

async function handleToolCall(name: string, args: any): Promise<any> {
  switch (name) {
    case "mem_add": {
      const [embedding, insertResult] = await Promise.all([
        getEmbedding(args.content),
        supabase
          .from("memories")
          .insert({ content: args.content, category: args.category ?? "general", tags: args.tags ?? [], source_agent: args.agent ?? "unknown" })
          .select("id, content, category, tags, source_agent, created_at")
          .single(),
      ]);
      if (insertResult.error) return { content: [{ type: "text", text: `Error: ${insertResult.error.message}` }] };
      if (embedding) {
        await supabase.from("memories").update({ embedding: `[${embedding.join(",")}]` }).eq("id", insertResult.data.id);
      }
      const data = insertResult.data;
      return { content: [{ type: "text", text: `Saved [${data.category}] (id: ${data.id})\n${data.content}\ntags: ${data.tags.join(", ") || "none"}${embedding ? "\n[embedded]" : ""}` }] };
    }
    case "mem_search": {
      const max = args.max ?? 20;
      const buildQuery = (selectEmbedding = false) => {
        const cols = selectEmbedding ? "id, content, category, tags, source_agent, created_at, embedding" : "id, content, category, tags, source_agent, created_at";
        let req = supabase.from("memories").select(cols).order("created_at", { ascending: false }).limit(max * 3);
        if (args.tag) req = req.contains("tags", [args.tag]);
        if (args.category) req = req.eq("category", args.category);
        return req;
      };
      if (args.query && EMBEDDING_API_KEY) {
        const [embedding, keywordResults] = await Promise.all([
          getEmbedding(args.query),
          (() => {
            let req = buildQuery(false);
            if (args.query) req = req.ilike("content", `%${args.query}%`);
            return req;
          })(),
        ]);
        let results = keywordResults.data || [];
        if (embedding) {
          const { data: withEmbeddings } = await buildQuery(true);
          if (withEmbeddings) {
            const cosine = (a: number[], b: number[]) => {
              let dot = 0, na = 0, nb = 0;
              for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
              return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
            };
            const parsed = withEmbeddings
              .filter((m: any) => m.embedding)
              .map((m: any) => ({ ...m, _emb: typeof m.embedding === "string" ? JSON.parse(m.embedding) : m.embedding, _sim: 0 }));
            for (const m of parsed) m._sim = cosine(embedding, m._emb);
            parsed.sort((a: any, b: any) => b._sim - a._sim);
            const seen = new Set<string>();
            const merged: any[] = [];
            for (const m of [...parsed, ...results]) {
              if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
            }
            results = merged.slice(0, max);
          }
        }
        if (results.length === 0) return { content: [{ type: "text", text: "No memories found." }] };
        return { content: [{ type: "text", text: `Found ${results.length} memories:\n${results.map((m: any) => `[${m.id}] [${m.created_at?.slice(0, 10)}] [${m.source_agent}] [${m.category}] ${m.content}`).join("\n")}` }] };
      }
      let req = buildQuery(false);
      if (args.query) req = req.ilike("content", `%${args.query}%`);
      const { data, error } = await req;
      if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      if (!data || data.length === 0) return { content: [{ type: "text", text: "No memories found." }] };
      return { content: [{ type: "text", text: `Found ${data.length} memories:\n${data.map((m: any) => `[${m.id}] [${m.created_at?.slice(0, 10)}] [${m.source_agent}] [${m.category}] ${m.content}`).join("\n")}` }] };
    }
    case "mem_list": {
      let req = supabase.from("memories").select("id, content, category, tags, source_agent, created_at").order("created_at", { ascending: false }).limit(args.max ?? 20);
      if (args.category) req = req.eq("category", args.category);
      if (args.agent) req = req.eq("source_agent", args.agent);
      const { data, error } = await req;
      if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      return { content: [{ type: "text", text: data?.map((m: any) => `[${m.id}] [${m.created_at?.slice(0, 10)}] [${m.source_agent}] [${m.category}] ${m.content}`).join("\n") ?? "No memories found." }] };
    }
    case "mem_get": {
      const { data, error } = await supabase.from("memories").select("*").eq("id", args.id).single();
      if (error || !data) return { content: [{ type: "text", text: `Memory not found: ${args.id}` }] };
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    case "mem_update": {
      const updates: any = {};
      if (args.content !== undefined) updates.content = args.content;
      if (args.category !== undefined) updates.category = args.category;
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.agent !== undefined) updates.source_agent = args.agent;
      if (Object.keys(updates).length === 0) return { content: [{ type: "text", text: "Error: no fields to update" }] };
      // Re-embed if content changed
      if (args.content) {
        const emb = await getEmbedding(args.content);
        if (emb) updates.embedding = `[${emb.join(",")}]`;
      }
      const { data, error } = await supabase.from("memories").update(updates).eq("id", args.id).select("id, content, category, tags, source_agent, created_at").single();
      if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      return { content: [{ type: "text", text: `Updated [${data.id}]
${data.content}
tags: ${data.tags.join(", ") || "none"}` }] };
    }
    case "mem_delete": {
      const { error } = await supabase.from("memories").delete().eq("id", args.id);
      if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      return { content: [{ type: "text", text: `Deleted memory: ${args.id}` }] };
    }
    case "mem_stats": {
      const { count: total } = await supabase.from("memories").select("*", { count: "exact", head: true });
      const { data: agents } = await supabase.from("memories").select("source_agent");
      const { data: categories } = await supabase.from("memories").select("category");
      const ac: Record<string, number> = {};
      agents?.forEach((a: any) => { ac[a.source_agent] = (ac[a.source_agent] || 0) + 1; });
      const cc: Record<string, number> = {};
      categories?.forEach((c: any) => { cc[c.category] = (cc[c.category] || 0) + 1; });
      return { content: [{ type: "text", text: `Total: ${total}\n\nBy agent:\n${Object.entries(ac).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n\nBy category:\n${Object.entries(cc).map(([k, v]) => `  ${k}: ${v}`).join("\n")}` }] };
    }
    default:
      return null;
  }
}

const TOOLS = [
  { name: "mem_add", description: "Save a memory to the shared memory store.", inputSchema: { type: "object", properties: { content: { type: "string", description: "The memory content to save" }, category: { type: "string", enum: ["general", "preference", "decision", "fact", "project", "person", "system"], default: "general", description: "Category" }, tags: { type: "array", items: { type: "string" }, default: [], description: "Tags for filtering" }, agent: { type: "string", default: "unknown", description: "Which agent is saving this" } }, required: ["content"] } },
  { name: "mem_search", description: "Search memories by keyword, tag, or category. Uses hybrid search (vector + keyword) when available.", inputSchema: { type: "object", properties: { query: { type: "string", description: "Keyword to search for" }, tag: { type: "string", description: "Filter by tag" }, category: { type: "string", description: "Filter by category" }, max: { type: "number", default: 20, description: "Max results" } } } },
  { name: "mem_list", description: "List recent memories.", inputSchema: { type: "object", properties: { max: { type: "number", default: 20 }, category: { type: "string" }, agent: { type: "string" } } } },
  { name: "mem_get", description: "Get a specific memory by UUID.", inputSchema: { type: "object", properties: { id: { type: "string", description: "UUID of the memory" } }, required: ["id"] } },
  { name: "mem_update", description: "Update an existing memory. Preserves created_at. Re-embeds if content changes.", inputSchema: { type: "object", properties: { id: { type: "string", description: "UUID of the memory to update" }, content: { type: "string", description: "New content" }, category: { type: "string", enum: ["general", "preference", "decision", "fact", "project", "person", "system"], description: "New category" }, tags: { type: "array", items: { type: "string" }, description: "New tags" }, agent: { type: "string", description: "New source agent" } }, required: ["id"] } },
  { name: "mem_delete", description: "Delete a memory by UUID.", inputSchema: { type: "object", properties: { id: { type: "string", description: "UUID of the memory to delete" } }, required: ["id"] } },
  { name: "mem_stats", description: "Get statistics about the shared memory store.", inputSchema: { type: "object", properties: {} } },
];

export default async function handler(req: any, res: any) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, Mcp-Session-Id");
    res.status(200).end();
    return;
  }
  if (API_KEY) {
    const key = req.headers["x-api-key"]
      || req.headers["authorization"]?.replace("Bearer ", "")
      || req.query?.key;
    if (key !== API_KEY) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.status(200).end();
    return;
  }
  if (req.method === "DELETE") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const msg: JsonRpcRequest = body;
    let response = "";
    switch (msg.method) {
      case "initialize":
        response = jsonRpcResponse(msg.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "shared-memory", version: "1.2.0", description: "Persistent cross-agent memory store with hybrid vector search" },
        });
        break;
      case "notifications/initialized":
        res.status(202).end();
        return;
      case "tools/list":
        response = jsonRpcResponse(msg.id, { tools: TOOLS });
        break;
      case "tools/call":
        const result = await handleToolCall(msg.params?.name, msg.params?.arguments);
        response = jsonRpcResponse(msg.id, result);
        break;
      case "ping":
        response = jsonRpcResponse(msg.id, {});
        break;
      default:
        response = jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.status(200).send(response);
  } catch (error: any) {
    console.error("MCP handler error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
}
