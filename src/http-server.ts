import "./load-env.js";

import { randomUUID } from "node:crypto";

import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  createRequestNetworkMcpServer,
  type RequestNetworkClientConfig,
} from "./mcp-server-factory.js";

const DEFAULT_PORT = 3100;

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  clientConfig: RequestNetworkClientConfig;
};

const sessions = new Map<string, SessionEntry>();
const eventStore = new InMemoryEventStore();

const app = createMcpExpressApp();

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(raw)) {
    const first = raw[0]?.trim();
    return first || undefined;
  }
  return undefined;
}

/** Client credentials from mcp.json `headers` (not server .env). */
function clientConfigFromRequest(req: Request): RequestNetworkClientConfig {
  return {
    clientId: headerValue(req, "x-client-id"),
    payer: headerValue(req, "x-payer-address"),
  };
}

function mergeClientConfig(
  target: RequestNetworkClientConfig,
  source: RequestNetworkClientConfig,
): void {
  if (source.clientId) target.clientId = source.clientId;
  if (source.payer) target.payer = source.payer;
}

app.all("/mcp", async (req: Request, res: Response) => {
  const sessionHeader = req.headers["mcp-session-id"];
  const existingId =
    typeof sessionHeader === "string" ? sessionHeader : undefined;

  let entry = existingId ? sessions.get(existingId) : undefined;
  const incomingConfig = clientConfigFromRequest(req);

  if (!entry) {
    const clientConfig: RequestNetworkClientConfig = { ...incomingConfig };
    const server = createRequestNetworkMcpServer(clientConfig);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore,
      retryInterval: 2000,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server, clientConfig });
        console.error(`[mcp-http] session ${sessionId} ready`);

        transport.onclose = () => {
          sessions.delete(sessionId);
          console.error(`[mcp-http] session ${sessionId} closed`);
        };
      },
    });

    await server.connect(transport);
    entry = { transport, server, clientConfig };
  } else {
    mergeClientConfig(entry.clientConfig, incomingConfig);
  }

  try {
    await entry.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[mcp-http] MCP request error:", error);
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
  console.error("Listening...");
});
