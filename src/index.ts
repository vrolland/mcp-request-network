import "./load-env.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createRequestNetworkMcpServer } from "./mcp-server-factory.js";

async function main() {
  const server = createRequestNetworkMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Request Network MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
