import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const server = new McpServer({
  name: "shared-memory",
  version: "1.0.0",
  description: "Persistent cross-agent memory store. Share context between any MCP-compatible agent.",
});

// Tool: mem_add
server.tool(
  "mem_add",
  "Save a memory to the shared memory store. Use this to persist important context that other agents should know about.",
  {
    content: z.string().describe("The memory content to save"),
    category: z.enum(["general", "preference", "decision", "fact", "project", "person", "system"]).optional().default("general").describe("Category of the memory"),
    tags: z.array(z.string()).optional().default([]).describe("Tags for filtering (e.g. ['project-z', 'work'])"),
    agent: z.string().optional().default("unknown").describe("Which agent is saving this (e.g. hermes, claude-code, claude-web)"),
  },
  async ({ content, category, tags, agent }) => {
    const { data, error } = await supabase
      .from("memories")
      .insert({ content, category, tags, source_agent: agent })
      .select("id, content, category, tags, source_agent, created_at")
      .single();

    if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }] };

    return {
      content: [{ type: "text", text: `Saved [${data.category}] (id: ${data.id})\n${data.content}\ntags: ${data.tags.join(", ") || "none"}` }],
    };
  }
);

// Tool: mem_search
server.tool(
  "mem_search",
  "Search memories by keyword, tag, or category. Returns matching memories sorted by most recent.",
  {
    query: z.string().optional().describe("Keyword to search for in memory content"),
    tag: z.string().optional().describe("Filter by a specific tag"),
    category: z.string().optional().describe("Filter by category"),
    max: z.number().optional().default(20).describe("Max results (default 20)"),
  },
  async ({ query, tag, category, max }) => {
    let req = supabase.from("memories").select("id, content, category, tags, source_agent, created_at").order("created_at", { ascending: false }).limit(max);

    if (query) req = req.ilike("content", `%${query}%`);
    if (tag) req = req.contains("tags", [tag]);
    if (category) req = req.eq("category", category);

    const { data, error } = await req;

    if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }] };

    if (!data || data.length === 0) return { content: [{ type: "text", text: "No memories found." }] };

    const formatted = data.map((m) => `[${m.created_at?.slice(0, 10)}] [${m.source_agent}] [${m.category}] ${m.content} (tags: ${m.tags?.join(", ") || "none"})`).join("\n");

    return { content: [{ type: "text", text: `Found ${data.length} memories:\n${formatted}` }] };
  }
);

// Tool: mem_list
server.tool(
  "mem_list",
  "List recent memories. Optionally filter by agent or category.",
  {
    max: z.number().optional().default(20).describe("Max results (default 20)"),
    category: z.string().optional().describe("Filter by category"),
    agent: z.string().optional().describe("Filter by source agent"),
  },
  async ({ max, category, agent }) => {
    let req = supabase.from("memories").select("id, content, category, tags, source_agent, created_at").order("created_at", { ascending: false }).limit(max);

    if (category) req = req.eq("category", category);
    if (agent) req = req.eq("source_agent", agent);

    const { data, error } = await req;

    if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }] };

    const formatted = data?.map((m) => `[${m.created_at?.slice(0, 10)}] [${m.source_agent}] [${m.category}] ${m.content} (tags: ${m.tags?.join(", ") || "none"})`).join("\n") ?? "No memories found.";

    return { content: [{ type: "text", text: formatted }] };
  }
);

// Tool: mem_get
server.tool(
  "mem_get",
  "Get a specific memory by its UUID.",
  {
    id: z.string().uuid().describe("The UUID of the memory"),
  },
  async ({ id }) => {
    const { data, error } = await supabase.from("memories").select("*").eq("id", id).single();

    if (error || !data) return { content: [{ type: "text", text: `Memory not found: ${id}` }] };

    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool: mem_delete
server.tool(
  "mem_delete",
  "Delete a memory by UUID. Use with caution.",
  {
    id: z.string().uuid().describe("The UUID of the memory to delete"),
  },
  async ({ id }) => {
    const { error } = await supabase.from("memories").delete().eq("id", id);

    if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }] };

    return { content: [{ type: "text", text: `Deleted memory: ${id}` }] };
  }
);

// Tool: mem_stats
server.tool(
  "mem_stats",
  "Get statistics about the shared memory store.",
  {},
  async () => {
    const { count: total } = await supabase.from("memories").select("*", { count: "exact", head: true });

    const { data: agents } = await supabase.from("memories").select("source_agent");
    const { data: categories } = await supabase.from("memories").select("category");

    const agentCounts: Record<string, number> = {};
    agents?.forEach((a) => { agentCounts[a.source_agent] = (agentCounts[a.source_agent] || 0) + 1; });

    const catCounts: Record<string, number> = {};
    categories?.forEach((c) => { catCounts[c.category] = (catCounts[c.category] || 0) + 1; });

    return {
      content: [{
        type: "text",
        text: `Shared Memory Stats\nTotal: ${total}\n\nBy agent:\n${Object.entries(agentCounts).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n\nBy category:\n${Object.entries(catCounts).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`,
      }],
    };
  }
);

export { server };
