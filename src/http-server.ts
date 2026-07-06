import "./load-env.js";

import { randomUUID } from "node:crypto";

import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createRequestNetworkMcpServer } from "./mcp-server-factory.js";

const DEFAULT_PORT = 3100;

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

const sessions = new Map<string, SessionEntry>();
const eventStore = new InMemoryEventStore();

const app = createMcpExpressApp();

app.all("/mcp", async (req: Request, res: Response) => {
  const sessionHeader = req.headers["mcp-session-id"];
  const existingId =
    typeof sessionHeader === "string" ? sessionHeader : undefined;

  let entry = existingId ? sessions.get(existingId) : undefined;

  if (!entry) {
    const server = createRequestNetworkMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore,
      retryInterval: 2000,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server });
        console.error(`[mcp-http] session ${sessionId} prête`);

        transport.onclose = () => {
          sessions.delete(sessionId);
          console.error(`[mcp-http] session ${sessionId} fermée`);
        };
      },
    });

    await server.connect(transport);
    entry = { transport, server };
  }

  try {
    await entry.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[mcp-http] erreur requête MCP:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const port = Number(process.env.MCP_HTTP_PORT) || DEFAULT_PORT;

app.listen(port, () => {
  console.error(`Request Network MCP (HTTP) — http://127.0.0.1:${port}/mcp`);
  console.error('Listening...');
});
