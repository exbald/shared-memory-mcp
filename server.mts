import { server } from "./src/index.ts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

await server.connect(transport);

const http = await import("http");

const srv = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  
  const mockReq = Object.assign(req, { body: body ? JSON.parse(body) : undefined });
  
  try {
    await transport.handleRequest(mockReq, res, mockReq.body);
  } catch (err) {
    console.error("Error:", err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  }
});

srv.listen(8088, () => {
  console.log("MCP server running on http://localhost:8088/mcp");
});
