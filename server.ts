import { server } from "./dist/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

await server.connect(transport);

const httpServer = import("http").then((http) => {
  const s = http.createServer(async (req, res) => {
    // Collect body for POST requests
    let body = "";
    for await (const chunk of req) body += chunk;

    // Minimal mock of Vercel req/res
    const mockReq = Object.assign(req, { body: body ? JSON.parse(body) : undefined });
    const mockRes = res;
    
    try {
      await transport.handleRequest(mockReq, mockRes, mockReq.body);
    } catch (err) {
      console.error("Error handling request:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  });

  s.listen(3001, () => {
    console.log("MCP server running on http://localhost:3001/mcp");
  });
});
