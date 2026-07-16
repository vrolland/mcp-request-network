import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const RN_API_BASE = "https://api.stage.request.network";

/**
 * Guidance for LLMs: amounts are always human-readable USD, never on-chain units.
 * Repeated on each amount field because not every client surfaces server instructions.
 */
const AMOUNT_USD_FIELD_DESCRIPTION =
  'USD amount as a plain decimal string (e.g. "12" for $12, "0.12" for $0.12). ' +
  "Always the dollar value the user intends, regardless of payment token (USDC, ETH, etc.). " +
  'Do NOT multiply by on-chain decimals (wrong: $0.12 → "120000"; correct: "0.12"). ' +
  'Do NOT shift or pad decimals (wrong: $12 → "1200"; correct: "12"). ' +
  "Request Network converts to token units internally — never do that conversion yourself.";

const MCP_SERVER_INSTRUCTIONS = `# Request Network MCP — amount format (read before payment tools)

All \`amount\` fields are **human-readable USD values** as decimal strings. The payment token (e.g. USDC-base) only selects which asset settles on-chain; it does NOT change how you format the amount.

## Correct examples
| User intent | Pass |
|-------------|------|
| $12 | "12" |
| $0.12 | "0.12" |
| $1,500.50 | "1500.50" |

## Common LLM mistakes (never do this)
- $12 → "1200" (shifted decimal / extra zeros)
- $0.12 USDC → "120000" (multiplied by 6 on-chain decimals)
- $100 ETH → wei / smallest-unit conversion

Never convert to smallest on-chain units. Pass the dollar amount exactly as the user means it.`;

/**
 * Per-client settings from mcp.json (HTTP `headers`, or stdio `env` mapped at startup).
 * Not loaded from the MCP server's own .env.
 */
export type RequestNetworkClientConfig = {
  /** Request Network Dashboard Client ID → API header x-client-id */
  clientId?: string;
  /** Payer EVM wallet (creatorWalletAddress) for batch payouts */
  payer?: string;
};

function envTrim(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() || undefined;
}

/** Full EVM address (0x + 40 hex) — rejects placeholders like 0x742...HERE. */
function isLikelyEvmWalletAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

/** Tool parameter takes precedence only if it looks like a real address; otherwise mcp.json payer. */
function resolvePayerWallet(
  toolValue: string | undefined,
  clientConfig: RequestNetworkClientConfig,
): string | undefined {
  const fromTool = toolValue?.trim();
  if (fromTool && isLikelyEvmWalletAddress(fromTool)) {
    return fromTool;
  }
  const fromClient = clientConfig.payer?.trim();
  if (fromClient && isLikelyEvmWalletAddress(fromClient)) {
    return fromClient;
  }
  return undefined;
}

function requireClientId(clientConfig: RequestNetworkClientConfig): string {
  const clientId = clientConfig.clientId?.trim();
  if (!clientId) {
    throw new Error(
      'Missing client ID — set headers["x-client-id"] in mcp.json (HTTP) or RN_CLIENT_ID in the client mcp.json env (stdio).',
    );
  }
  return clientId;
}

function requireAuth(clientConfig: RequestNetworkClientConfig): void {
  if (envTrim("RN_API_KEY")) return;
  if (envTrim("RN_ORCHESTRATOR_KEY")) {
    requireClientId(clientConfig);
    return;
  }
  requireClientId(clientConfig);
}

/** @see https://api.request.network/open-api/#tag/v2secure-payment/POST/v2/secure-payments */
function buildAuthHeaders(
  clientConfig: RequestNetworkClientConfig,
): Record<string, string> {
  const apiKey = envTrim("RN_API_KEY");
  if (apiKey) {
    return { "x-api-key": apiKey };
  }

  const orchestratorKey = envTrim("RN_ORCHESTRATOR_KEY");
  const origin = envTrim("RN_ORIGIN");
  const clientId = requireClientId(clientConfig);

  if (orchestratorKey) {
    const headers: Record<string, string> = {
      "x-client-id": clientId,
      "x-orchestrator-key": orchestratorKey,
    };
    if (origin) headers.Origin = origin;
    return headers;
  }

  const headers: Record<string, string> = { "x-client-id": clientId };
  if (origin) headers.Origin = origin;
  return headers;
}

async function rnApiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    clientConfig: RequestNetworkClientConfig;
  },
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${RN_API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeaders(options.clientConfig),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data: T;
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    data = { raw: text } as T;
  }

  if (!response.ok) {
    const apiMessage =
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof (data as { message: unknown }).message === "string"
        ? (data as { message: string }).message
        : JSON.stringify(data);

    throw new Error(apiMessage);
  }

  return { status: response.status, data };
}

interface SecurePaymentRequestItem {
  destinationId?: string;
  amount: string;
}

interface SecurePaymentBody {
  requests: SecurePaymentRequestItem[];
  reference?: string;
  payerIdentifier?: string;
  redirectUrl?: string;
  redirectLabel?: string;
}

interface SecurePaymentResponse {
  securePaymentUrl?: string;
  token?: string;
  requestIds?: string[];
  [key: string]: unknown;
}

const ACCESS_POLICY_NO_SCREENING = {
  mode: "off" as const,
  screeningProvider: null,
  hideUntilApproved: false,
  hidePayeeAddress: false,
};

interface SecurePayoutLine {
  recipient: string;
  network: string;
  currency: string;
  amount: string;
  reference?: string;
  recipientIdentifier?: string;
}

interface SecurePayoutSingleBody {
  creatorWalletAddress: string;
  recipient: string;
  network: string;
  currency: string;
  amount: string;
  accessPolicy: typeof ACCESS_POLICY_NO_SCREENING;
  reference?: string;
  recipientIdentifier?: string;
  redirectUrl?: string;
  redirectLabel?: string;
}

interface SecurePayoutResponse {
  token?: string;
  requestIds?: string[];
  [key: string]: unknown;
}

interface MulticallPayoutsResponse {
  securePaymentUrl?: string;
  expiresAt?: string;
  items?: Array<{ position?: number; requestId?: string }>;
  [key: string]: unknown;
}

interface RequestStatusResponse {
  hasBeenPaid?: boolean;
  requestId?: string;
  txHash?: string | null;
  status?: string;
  reference?: string | null;
  payments?: unknown[];
  [key: string]: unknown;
}

function buildSecurePaymentBody(params: {
  destinationId?: string;
  amount: string;
  reference?: string;
  payerIdentifier?: string;
  redirectUrl?: string;
  redirectLabel?: string;
}): SecurePaymentBody {
  const requestItem: SecurePaymentRequestItem = { amount: params.amount };
  if (params.destinationId) {
    requestItem.destinationId = params.destinationId;
  }

  const body: SecurePaymentBody = {
    requests: [requestItem],
  };
  if (params.reference) body.reference = params.reference;
  if (params.payerIdentifier) body.payerIdentifier = params.payerIdentifier;
  if (params.redirectUrl) {
    body.redirectUrl = params.redirectUrl;
    if (params.redirectLabel) body.redirectLabel = params.redirectLabel;
  }
  return body;
}

function parsePayeeFromDestinationId(destinationId: string): string {
  const trimmed = destinationId.trim();
  const at = trimmed.indexOf("@");
  if (at <= 0) {
    throw new Error(
      `Invalid destinationId (expected wallet@eip155:…#…:…) : ${trimmed}`,
    );
  }
  return trimmed.slice(0, at);
}

function parseCurrencyNetwork(paymentCurrency: string): {
  currency: string;
  network: string;
} {
  const trimmed = paymentCurrency.trim();
  const dash = trimmed.indexOf("-");
  if (dash <= 0 || dash === trimmed.length - 1) {
    throw new Error(
      `Invalid paymentCurrency (expected TOKEN-network, e.g. USDC-base) : ${trimmed}`,
    );
  }
  return {
    currency: trimmed,
    network: trimmed.slice(dash + 1),
  };
}

function resolveSecurePayoutLine(
  emp: {
    name?: string;
    recipient?: string;
    payee?: string;
    address?: string;
    destinationId?: string;
    amount: string;
    paymentCurrency?: string;
    reference?: string;
    recipientIdentifier?: string;
  },
  defaults: {
    paymentCurrency?: string;
    reference?: string;
  },
  index: number,
): SecurePayoutLine {
  const amount = String(emp.amount).trim();

  let recipient =
    emp.recipient?.trim() || emp.payee?.trim() || emp.address?.trim();
  const destinationId = emp.destinationId?.trim();
  if (!recipient && destinationId) {
    recipient = parsePayeeFromDestinationId(destinationId);
  }

  const paymentCurrency =
    emp.paymentCurrency?.trim() || defaults.paymentCurrency?.trim();

  const who = emp.name?.trim() || `line #${index + 1}`;
  if (!recipient) {
    throw new Error(
      `${who}: payee or destinationId is required (POST /v2/secure-payments/payouts).`,
    );
  }
  if (!paymentCurrency) {
    throw new Error(
      `${who}: paymentCurrency is required (beneficiary field or batch-level paymentCurrency / RN_DEFAULT_PAYMENT_CURRENCY).`,
    );
  }

  const { currency, network } = parseCurrencyNetwork(paymentCurrency);

  const line: SecurePayoutLine = {
    recipient,
    network,
    currency,
    amount,
  };
  const ref = emp.reference?.trim() || defaults.reference?.trim();
  if (ref) line.reference = ref;
  const recipientIdentifier = emp.recipientIdentifier?.trim();
  if (recipientIdentifier) line.recipientIdentifier = recipientIdentifier;
  return line;
}

function buildSecurePayoutBody(params: {
  creatorWalletAddress: string;
  line: SecurePayoutLine;
  accessPolicy?: typeof ACCESS_POLICY_NO_SCREENING;
  redirectUrl?: string;
  redirectLabel?: string;
}): SecurePayoutSingleBody {
  const payer = params.creatorWalletAddress.trim();
  if (!payer) {
    throw new Error(
      "creatorWalletAddress is required — payer wallet (payer parameter or mcp.json x-payer-address).",
    );
  }

  const body: SecurePayoutSingleBody = {
    creatorWalletAddress: payer,
    recipient: params.line.recipient,
    network: params.line.network,
    currency: params.line.currency,
    amount: params.line.amount,
    accessPolicy: params.accessPolicy ?? ACCESS_POLICY_NO_SCREENING,
  };
  if (params.line.reference) body.reference = params.line.reference;
  if (params.line.recipientIdentifier) {
    body.recipientIdentifier = params.line.recipientIdentifier;
  }
  if (params.redirectUrl?.trim()) {
    body.redirectUrl = params.redirectUrl.trim();
    if (params.redirectLabel?.trim()) {
      body.redirectLabel = params.redirectLabel.trim();
    }
  }
  return body;
}

function buildBatchSecurePaymentBody(params: {
  requests: SecurePaymentRequestItem[];
  reference?: string;
  payerIdentifier?: string;
  redirectUrl?: string;
  redirectLabel?: string;
}): SecurePaymentBody {
  const body: SecurePaymentBody = {
    requests: params.requests,
  };
  if (params.reference) body.reference = params.reference;
  if (params.payerIdentifier) body.payerIdentifier = params.payerIdentifier;
  if (params.redirectUrl) {
    body.redirectUrl = params.redirectUrl;
    if (params.redirectLabel) body.redirectLabel = params.redirectLabel;
  }
  return body;
}

function formatSecurePaymentResult(data: SecurePaymentResponse): string {
  const lines = [JSON.stringify(data, null, 2)];
  if (data.securePaymentUrl) {
    lines.push("", "Link to send to the payer (batch):", data.securePaymentUrl);
  }
  if (data.requestIds?.length) {
    lines.push(
      "",
      `${data.requestIds.length} request(s) created. Verify each payment with get_payment_status:`,
    );
    for (const id of data.requestIds) {
      lines.push(`  requestId: ${id}`);
    }
  }
  return lines.join("\n");
}

interface PayrollBeneficiaryLabel {
  name?: string;
  amount: string;
  recipient?: string;
}

function formatMulticallPayrollResult(
  data: MulticallPayoutsResponse,
  beneficiaries: PayrollBeneficiaryLabel[],
): string {
  const lines: string[] = [
    "Secure payouts + multicall — POST /v2/secure-payments/payouts puis /multicall-payouts",
    `beneficiaries: ${beneficiaries.length}`,
    "Bundle tokens quickly (~15 min) using the same auth.",
  ];

  const total = beneficiaries.reduce((sum, e) => {
    const n = Number(e.amount);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
  if (total > 0) {
    lines.push(`Total amounts (USD): ${total}`);
  }

  if (data.securePaymentUrl) {
    lines.push(
      "",
      `Link to send to the payer (valid until ${data.expiresAt ?? "?"}):`,
      data.securePaymentUrl,
    );
  }

  const items = data.items;
  if (Array.isArray(items) && items.length) {
    lines.push(
      "",
      `${items.length} payout(s) in the batch — requestId per line:`,
    );
    for (const item of items) {
      const emp = beneficiaries[(item.position ?? 1) - 1];
      const label = emp?.name?.trim() || `line #${item.position ?? "?"}`;
      lines.push(`  [${item.position ?? "?"}] ${label} — requestId: ${item.requestId ?? "?"}`);
    }
    lines.push(
      "",
      "Verify each payment with get_payment_status (requestId).",
    );
  }

  lines.push("", "---", "", JSON.stringify(data, null, 2));
  return lines.join("\n");
}

async function postSecurePaymentPayout(
  body: SecurePayoutSingleBody,
  clientConfig: RequestNetworkClientConfig,
): Promise<SecurePayoutResponse> {
  const { data } = await rnApiRequest<SecurePayoutResponse>(
    "/v2/secure-payments/payouts",
    { method: "POST", body, clientConfig },
  );
  return data;
}

async function postMulticallPayouts(
  childTokens: string[],
  clientConfig: RequestNetworkClientConfig,
): Promise<MulticallPayoutsResponse> {
  if (!childTokens.length) {
    throw new Error("childTokens[] must contain at least one token.");
  }
  const { data } = await rnApiRequest<MulticallPayoutsResponse>(
    "/v2/secure-payments/multicall-payouts",
    { method: "POST", body: { childTokens }, clientConfig },
  );
  return data;
}

async function postSecurePayment(
  body: SecurePaymentBody,
  clientConfig: RequestNetworkClientConfig,
): Promise<SecurePaymentResponse> {
  const { data } = await rnApiRequest<SecurePaymentResponse>(
    "/v2/secure-payments",
    { method: "POST", body, clientConfig },
  );
  return data;
}

function buildPaymentStatusSummary(
  requestStatus: RequestStatusResponse | undefined,
): string {
  const lines: string[] = [];

  if (requestStatus) {
    const paid = requestStatus.hasBeenPaid === true;
    lines.push(
      "Request Network (requestId):",
      `  hasBeenPaid: ${paid}`,
      `  payment completed: ${paid ? "yes" : "no"}`,
    );
    if (requestStatus.status) {
      lines.push(`  status: ${requestStatus.status}`);
    }
    if (requestStatus.txHash) {
      lines.push(`  txHash: ${requestStatus.txHash}`);
    }
    if (requestStatus.reference) {
      lines.push(`  reference: ${requestStatus.reference}`);
    }
    lines.push("", `Summary — payment received: ${paid ? "yes" : "no"}`);
  } else {
    lines.push("No data retrieved.");
  }

  return lines.join("\n");
}

function compactRequestStatus(
  requestStatus: RequestStatusResponse | undefined,
): Record<string, unknown> | undefined {
  if (!requestStatus) return undefined;

  const payments = Array.isArray(requestStatus.payments)
    ? requestStatus.payments
    : [];
  const firstPayment = payments[0] as Record<string, unknown> | undefined;

  return {
    requestId: requestStatus.requestId,
    hasBeenPaid: requestStatus.hasBeenPaid,
    status: requestStatus.status,
    reference: requestStatus.reference,
    payerIdentifier: requestStatus.payerIdentifier,
    requestAmount: requestStatus.requestAmount,
    invoiceCurrency: requestStatus.invoiceCurrency,
    paymentCurrency: requestStatus.paymentCurrency,
    paymentCount: payments.length,
    latestPayment: firstPayment
      ? {
          paidAmount: firstPayment.paidAmount,
          paidCurrency: firstPayment.paidCurrency,
          receivedAmount: firstPayment.receivedAmount,
          receivedCurrency: firstPayment.receivedCurrency,
          sourceTxHash: firstPayment.sourceTxHash,
          destinationTxHash: firstPayment.destinationTxHash,
          timestamp: firstPayment.timestamp,
        }
      : undefined,
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function createRequestNetworkMcpServer(
  clientConfig: RequestNetworkClientConfig = {},
): McpServer {
  requireAuth(clientConfig);

  const server = new McpServer(
    {
      name: "request-network",
      version: "1.0.0",
    },
    {
      capabilities: { logging: {} },
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "create_payment_link",
    {
      description:
        "Creates a Secure Payment link via POST /v2/secure-payments. Simple payment (amount) or batch payroll: pass requests[] with destinationId + amount per beneficiary (single pay.request.network link, one signature). All amounts are USD decimal strings — never on-chain units (see server instructions). Client ID required via mcp.json (x-client-id).",
      inputSchema: {
        destinationId: z
          .string()
          .optional()
          .describe(
            "Composite destination ID (wallet@chain#...:token). Optional if the Client ID has a default destination; otherwise RN_DESTINATION_ID.",
          ),
        amount: z
          .string()
          .optional()
          .describe(
            `${AMOUNT_USD_FIELD_DESCRIPTION} Default: RN_AMOUNT or "100".`,
          ),
        reference: z
          .string()
          .optional()
          .describe("Optional reference, e.g. order ID"),
        payerIdentifier: z
          .string()
          .optional()
          .describe("Optional payer identifier, e.g. customer email"),
        redirectUrl: z
          .string()
          .optional()
          .describe("http(s) redirect URL after payment"),
        redirectLabel: z
          .string()
          .optional()
          .describe("Return button label after payment"),
        requests: z
          .array(
            z.object({
              destinationId: z
                .string()
                .optional()
                .describe(
                  "Composite destinationId (wallet@chain#...:token) for the employee / beneficiary",
                ),
              amount: z
                .string()
                .describe(AMOUNT_USD_FIELD_DESCRIPTION),
              reference: z
                .string()
                .optional()
                .describe("Optional reference for this line"),
            }),
          )
          .optional()
          .describe(
            "Batch payout: each entry must have the beneficiary's destinationId (payee). Up to 200 entries. Do not confuse with the Client ID default destination (simple payment only).",
          ),
      },
    },
    async ({
      destinationId,
      amount,
      reference,
      payerIdentifier,
      redirectUrl,
      redirectLabel,
      requests,
    }) => {
      try {
        const defaultDestinationId =
          destinationId?.trim() || envTrim("RN_DESTINATION_ID");

        const resolvedReference =
          reference?.trim() || envTrim("RN_REFERENCE");
        const resolvedPayerIdentifier =
          payerIdentifier?.trim() || envTrim("RN_PAYER_IDENTIFIER");
        const resolvedRedirectUrl =
          redirectUrl?.trim() || envTrim("RN_REDIRECT_URL");
        const resolvedRedirectLabel =
          redirectLabel?.trim() || envTrim("RN_REDIRECT_LABEL");

        let body: SecurePaymentBody;

        if (requests?.length) {
          const batchRequests: SecurePaymentRequestItem[] = requests.map(
            (item) => {
              const line: SecurePaymentRequestItem = {
                amount: item.amount.trim(),
              };
              const lineDestination =
                item.destinationId?.trim() || defaultDestinationId;
              if (lineDestination) {
                line.destinationId = lineDestination;
              }
              return line;
            },
          );

          const missingDestination = batchRequests.some(
            (r) => !r.destinationId,
          );
          if (missingDestination) {
            return toolError(
              "Each batch entry must have a destinationId, or set RN_DESTINATION_ID / a default destinationId (single destination for all lines).",
            );
          }

          body = buildBatchSecurePaymentBody({
            requests: batchRequests,
            reference: resolvedReference,
            payerIdentifier: resolvedPayerIdentifier,
            redirectUrl: resolvedRedirectUrl,
            redirectLabel: resolvedRedirectLabel,
          });
        } else {
          const resolvedAmount =
            amount?.trim() || envTrim("RN_AMOUNT") || "100";

          body = buildSecurePaymentBody({
            ...(defaultDestinationId
              ? { destinationId: defaultDestinationId }
              : {}),
            amount: resolvedAmount,
            reference: resolvedReference,
            payerIdentifier: resolvedPayerIdentifier,
            redirectUrl: resolvedRedirectUrl,
            redirectLabel: resolvedRedirectLabel,
          });
        }

        const data = await postSecurePayment(body, clientConfig);

        return {
          content: [
            {
              type: "text",
              text: formatSecurePaymentResult(data),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return toolError(message);
      }
    },
  );

  server.registerTool(
    "create_batch_payout_payment_link",
    {
      description:
        "Creates multiple payouts and a payment-only link via Secure Payment Page: one POST /v2/secure-payments/payouts per beneficiary, then POST /v2/secure-payments/multicall-payouts → securePaymentUrl. payer = payer wallet (mcp.json x-payer-address). paymentCurrency in TOKEN-network format (e.g. USDC-base). Per beneficiary: recipient, payee or destinationId + amount (USD decimal string — see server instructions). Client ID via mcp.json x-client-id.",
      inputSchema: {
        payer: z
          .string()
          .optional()
          .describe(
            "Payer EVM wallet (creatorWalletAddress). Omit to use mcp.json x-payer-address — do not invent or pass a placeholder.",
          ),
        paymentCurrency: z
          .string()
          .optional()
          .describe(
            'TOKEN-network currency for all lines if omitted per employee, e.g. "USDC-base" (default: RN_DEFAULT_PAYMENT_CURRENCY)',
          ),
        beneficiaries: z
          .array(
            z.object({
              name: z
                .string()
                .optional()
                .describe("Display name (summary only)"),
              recipient: z
                .string()
                .optional()
                .describe("Beneficiary EVM address — or payee / destinationId"),
              payee: z
                .string()
                .optional()
                .describe("Employee EVM address (0x…) — or recipient / destinationId"),
              destinationId: z
                .string()
                .optional()
                .describe(
                  "Alternative: composite destinationId; payee is extracted before @",
                ),
              paymentCurrency: z
                .string()
                .optional()
                .describe("TOKEN-network currency for this line if different from batch default"),
              amount: z
                .string()
                .describe(AMOUNT_USD_FIELD_DESCRIPTION),
              reference: z
                .string()
                .optional()
                .describe("Optional reference for this line"),
              recipientIdentifier: z
                .string()
                .optional()
                .describe("Optional beneficiary identifier (secure-payments/payouts API)"),
            }),
          )
          .min(1)
          .max(200)
          .describe("List of employees to pay in the same multicall link"),
        payrollPeriod: z
          .string()
          .optional()
          .describe(
            'Payroll period for API reference, e.g. "2026-06" → reference payroll-2026-06 if reference not provided',
          ),
        reference: z
          .string()
          .optional()
          .describe("Batch reference (e.g. payroll-2026-06) to group webhooks"),
        redirectUrl: z
          .string()
          .optional()
          .describe(
            "http(s) redirect URL after payment (default: RN_REDIRECT_URL), applied to each payout",
          ),
        redirectLabel: z
          .string()
          .optional()
          .describe(
            "Return button label (default: RN_REDIRECT_LABEL), applied to each payout",
          ),
      },
    },
    async ({
      payer,
      paymentCurrency,
      beneficiaries,
      payrollPeriod,
      reference,
      redirectUrl,
      redirectLabel,
    }) => {
      try {
        const resolvedPayer = resolvePayerWallet(payer, clientConfig);
        console.log("create_batch_payout_payment_link", {
          payerArg: payer,
          resolvedPayer,
          paymentCurrency,
          beneficiaries,
          payrollPeriod,
          reference,
          redirectUrl,
          redirectLabel,
        });
        if (!resolvedPayer) {
          throw new Error(
            'payer is required — valid 0x… address (tool parameter) or headers["x-payer-address"] in mcp.json.',
          );
        }
        const defaultPaymentCurrency =
          paymentCurrency?.trim() || envTrim("RN_DEFAULT_PAYMENT_CURRENCY");

        const resolvedReference =
          reference?.trim() ||
          envTrim("RN_REFERENCE") ||
          (payrollPeriod?.trim()
            ? `payroll-${payrollPeriod.trim()}`
            : undefined);

        const resolvedRedirectUrl =
          redirectUrl?.trim() || envTrim("RN_REDIRECT_URL");
        const resolvedRedirectLabel =
          redirectLabel?.trim() || envTrim("RN_REDIRECT_LABEL");

        const defaults = {
          paymentCurrency: defaultPaymentCurrency,
          reference: resolvedReference,
        };

        const childTokens: string[] = [];
        const labels: PayrollBeneficiaryLabel[] = [];

        for (let index = 0; index < beneficiaries.length; index++) {
          const emp = beneficiaries[index];
          const line = resolveSecurePayoutLine(emp, defaults, index);
          const who = emp.name?.trim() || `line #${index + 1}`;

          const body = buildSecurePayoutBody({
            creatorWalletAddress: resolvedPayer,
            line,
            redirectUrl: resolvedRedirectUrl,
            redirectLabel: resolvedRedirectLabel,
          });

          const payoutData = await postSecurePaymentPayout(body, clientConfig);
          const token = payoutData.token;
          if (!token) {
            throw new Error(
              `Payout response missing token for ${who}: ${JSON.stringify(payoutData)}`,
            );
          }
          childTokens.push(token);
          labels.push({
            name: emp.name,
            amount: line.amount,
            recipient: line.recipient,
          });
        }

        const batchData = await postMulticallPayouts(childTokens, clientConfig);

        return {
          content: [
            {
              type: "text",
              text: formatMulticallPayrollResult(batchData, labels),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return toolError(message);
      }
    },
  );

  server.registerTool(
    "get_payment_status",
    {
      description:
        "Checks whether a payment was completed via requestId (GET /v2/request; client ID from mcp.json x-client-id).",
      inputSchema: {
        requestId: z
          .string()
          .describe(
            "Request ID returned by create_payment_link or create_batch_payout_payment_link (requestIds field)",
          ),
      },
    },
    async ({ requestId }) => {
      const resolvedRequestId = requestId?.trim();

      if (!resolvedRequestId) {
        return toolError(
          "Provide requestId (item from requestIds returned by create_payment_link or create_batch_payout_payment_link).",
        );
      }

      try {
        const { data: requestStatus } =
          await rnApiRequest<RequestStatusResponse>(
            `/v2/request/${encodeURIComponent(resolvedRequestId)}`,
            { clientConfig },
          );

        const summary = buildPaymentStatusSummary(requestStatus);

        const payload: Record<string, unknown> = {
          summary,
          request: compactRequestStatus(requestStatus),
        };

        return {
          content: [
            {
              type: "text",
              text: `${summary}\n\n---\n\n${JSON.stringify(payload, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return toolError(message);
      }
    },
  );

  return server;
}
