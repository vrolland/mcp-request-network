# Request Network MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects AI assistants (Cursor, Claude Desktop, etc.) to the [Request Network](https://request.network/) payment APIs. Create secure payment links, batch payroll payouts, and check payment status from natural-language workflows.

The server targets the staging API (`https://api.stage.request.network`) by default.

## MCP tools

| Tool | Description |
|------|-------------|
| `create_payment_link` | Single payment or batch secure payments via `POST /v2/secure-payments`. |
| `create_batch_payout_payment_link` | One payout per beneficiary, then a multicall link via `/v2/secure-payments/payouts` and `/multicall-payouts`. |
| `get_payment_status` | Poll payment completion by `requestId` (`GET /v2/request/{id}`). |

Amount fields are **human-readable USD decimal strings** (e.g. `"12"` for $12, `"0.12"` for $0.12). Do not convert to on-chain smallest units; Request Network handles token conversion.

## Requirements

- Node.js 20+ (uses `process.loadEnvFile` when available)
- npm
- A Request Network **Client ID** (Dashboard)
- For batch payouts: payer EVM wallet (`0x` + 40 hex characters)

## Install

```bash
npm install
npm run build
```

## Run modes

### HTTP

Starts a Streamable HTTP MCP endpoint on port `3100` (override with `MCP_HTTP_PORT`).

```bash
npm run mcp:http
```

Configure your MCP client with the URL and per-client headers (not the server’s `.env`):

```json
{
  "mcpServers": {
    "request-network-http": {
      "url": "http://localhost:3100/mcp",
      "headers": {
        "x-client-id": "cli_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "x-payer-address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  }
}
```

See [`mcp.json.example`](mcp.json.example).

- `x-client-id` — Request Network Client ID (`x-client-id` API header).
- `x-payer-address` — Payer wallet for `create_batch_payout_payment_link` (`creatorWalletAddress`).

### Stdio

For clients that spawn a local process:

```bash
node build/index.js
```

Pass client settings via the **client’s** `mcp.json` `env` block (not the MCP server’s `.env`):

```json
{
  "mcpServers": {
    "request-network": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-request-network/build/index.js"],
      "env": {
        "RN_CLIENT_ID": "cli_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "RN_PAYER": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  }
}
```

## Server-side configuration (`.env`)

Optional file at the project root (loaded by `src/load-env.ts`). Used for **server** secrets and defaults—not for Client ID / payer when using HTTP headers or stdio client `env`.

| Variable | Purpose |
|----------|---------|
| `MCP_HTTP_PORT` | HTTP server port (default `3100`). |

## Authentication

**Client ID** from MCP client config (`x-client-id` header or `RN_CLIENT_ID` in stdio `env`).

## Batch payouts

`create_batch_payout_payment_link` implements the two-step flow documented in [`external-doc/doc-en-batch-payoout.md`](external-doc/doc-en-batch-payoout.md): create one payout per recipient, collect `token`s, then call multicall to obtain a single `securePaymentUrl`.

## Development

```bash
npm run build   # compile TypeScript to build/
```

Entry points:

- `src/http-server.ts` — HTTP transport
- `src/index.ts` — stdio transport
- `src/mcp-server-factory.ts` — shared tools and API client
