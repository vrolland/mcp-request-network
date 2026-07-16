import "./load-env.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createRequestNetworkMcpServer } from "./mcp-server-factory.js";

async function main() {
  // Stdio: client supplies these via mcp.json `env` (not the server's own .env).
  const server = createRequestNetworkMcpServer({
    clientId: process.env.RN_CLIENT_ID?.trim() || undefined,
    payer: process.env.RN_PAYER?.trim() || undefined,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Request Network MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
