import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const RN_API_BASE = "https://api.stage.request.network";

function envTrim(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() || undefined;
}

/** Adresse EVM complète (0x + 40 hex) — rejette les placeholders du type 0x742...HERE. */
function isLikelyEvmWalletAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

/** Paramètre outil prioritaire seulement s'il ressemble à une vraie adresse ; sinon .env. */
function resolveWalletFromToolOrEnv(
  toolValue: string | undefined,
  envName: string,
): string | undefined {
  const fromTool = toolValue?.trim();
  if (fromTool && isLikelyEvmWalletAddress(fromTool)) {
    return fromTool;
  }
  return envTrim(envName);
}

function requireClientId(): string {
  const clientId = envTrim("RN_CLIENT_ID");
  if (!clientId) {
    throw new Error(
      "Variable d'environnement manquante : RN_CLIENT_ID (Client ID du Dashboard Request Network)",
    );
  }
  return clientId;
}

function requireAuth(): void {
  if (envTrim("RN_API_KEY")) return;
  if (envTrim("RN_ORCHESTRATOR_KEY")) {
    requireClientId();
    return;
  }
  requireClientId();
}

/** @see https://api.request.network/open-api/#tag/v2secure-payment/POST/v2/secure-payments */
function buildAuthHeaders(): Record<string, string> {
  const apiKey = envTrim("RN_API_KEY");
  if (apiKey) {
    return { "x-api-key": apiKey };
  }

  const orchestratorKey = envTrim("RN_ORCHESTRATOR_KEY");
  const origin = envTrim("RN_ORIGIN");
  const clientId = requireClientId();

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
  } = {},
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${RN_API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeaders(),
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
      `destinationId invalide (attendu wallet@eip155:…#…:…) : ${trimmed}`,
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
      `paymentCurrency invalide (attendu TOKEN-network, ex. USDC-base) : ${trimmed}`,
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

  const who = emp.name?.trim() || `ligne #${index + 1}`;
  if (!recipient) {
    throw new Error(
      `${who} : payee ou destinationId obligatoire (POST /v2/secure-payments/payouts).`,
    );
  }
  if (!paymentCurrency) {
    throw new Error(
      `${who} : paymentCurrency obligatoire (champ beneficiaire ou paymentCurrency / RN_DEFAULT_PAYMENT_CURRENCY au niveau batch).`,
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
      "creatorWalletAddress obligatoire — wallet du payeur (paramètre payer ou RN_PAYER).",
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
    lines.push("", "Lien à envoyer au payeur (batch) :", data.securePaymentUrl);
  }
  if (data.requestIds?.length) {
    lines.push(
      "",
      `${data.requestIds.length} requête(s) créée(s). Vérifiez chaque paiement avec get_payment_status :`,
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
    `beneficiaires : ${beneficiaries.length}`,
    "Regrouper les tokens rapidement (~15 min) avec la même auth.",
  ];

  const total = beneficiaries.reduce((sum, e) => {
    const n = Number(e.amount);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
  if (total > 0) {
    lines.push(`Total des montants (unités token) : ${total}`);
  }

  if (data.securePaymentUrl) {
    lines.push(
      "",
      `Lien à envoyer au payeur (valide jusqu'à ${data.expiresAt ?? "?"}) :`,
      data.securePaymentUrl,
    );
  }

  const items = data.items;
  if (Array.isArray(items) && items.length) {
    lines.push(
      "",
      `${items.length} payout(s) dans le batch — requestId par ligne :`,
    );
    for (const item of items) {
      const emp = beneficiaries[(item.position ?? 1) - 1];
      const label = emp?.name?.trim() || `ligne #${item.position ?? "?"}`;
      lines.push(`  [${item.position ?? "?"}] ${label} — requestId: ${item.requestId ?? "?"}`);
    }
    lines.push(
      "",
      "Vérifiez chaque paiement avec get_payment_status (requestId).",
    );
  }

  lines.push("", "---", "", JSON.stringify(data, null, 2));
  return lines.join("\n");
}

async function postSecurePaymentPayout(
  body: SecurePayoutSingleBody,
): Promise<SecurePayoutResponse> {
  const { data } = await rnApiRequest<SecurePayoutResponse>(
    "/v2/secure-payments/payouts",
    { method: "POST", body },
  );
  return data;
}

async function postMulticallPayouts(
  childTokens: string[],
): Promise<MulticallPayoutsResponse> {
  if (!childTokens.length) {
    throw new Error("childTokens[] doit contenir au moins un token.");
  }
  const { data } = await rnApiRequest<MulticallPayoutsResponse>(
    "/v2/secure-payments/multicall-payouts",
    { method: "POST", body: { childTokens } },
  );
  return data;
}

async function postSecurePayment(
  body: SecurePaymentBody,
): Promise<SecurePaymentResponse> {
  const { data } = await rnApiRequest<SecurePaymentResponse>(
    "/v2/secure-payments",
    { method: "POST", body },
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
      `  paiement effectué: ${paid ? "oui" : "non"}`,
    );
    if (requestStatus.status) {
      lines.push(`  statut: ${requestStatus.status}`);
    }
    if (requestStatus.txHash) {
      lines.push(`  txHash: ${requestStatus.txHash}`);
    }
    if (requestStatus.reference) {
      lines.push(`  référence: ${requestStatus.reference}`);
    }
    lines.push("", `Synthèse — paiement reçu: ${paid ? "oui" : "non"}`);
  } else {
    lines.push("Aucune donnée récupérée.");
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

export function createRequestNetworkMcpServer(): McpServer {
  requireAuth();

  const server = new McpServer(
    {
      name: "request-network",
      version: "1.0.0",
    },
    {
      capabilities: { logging: {} },
    },
  );

  server.registerTool(
    "create_payment_link",
    {
      description:
        "Crée un Secure Payment link via POST /v2/secure-payments. Paiement simple (amount) ou batch payroll : passer requests[] avec destinationId + amount par bénéficiaire (un seul lien pay.request.network, une signature). RN_CLIENT_ID obligatoire.",
      inputSchema: {
        destinationId: z
          .string()
          .optional()
          .describe(
            "ID composite destination (wallet@chain#...:token). Optionnel si le Client ID a une destination par défaut ; sinon RN_DESTINATION_ID.",
          ),
        amount: z
          .string()
          .optional()
          .describe(
            "Montant en unités du token (défaut : RN_AMOUNT ou \"100\")",
          ),
        reference: z
          .string()
          .optional()
          .describe("Référence optionnelle, ex. ID commande"),
        payerIdentifier: z
          .string()
          .optional()
          .describe("Identifiant payeur optionnel, ex. email client"),
        redirectUrl: z
          .string()
          .optional()
          .describe("URL http(s) de redirection après paiement"),
        redirectLabel: z
          .string()
          .optional()
          .describe("Libellé du bouton de retour après paiement"),
        requests: z
          .array(
            z.object({
              destinationId: z
                .string()
                .optional()
                .describe(
                  "destinationId composite (wallet@chain#...:token) du salarié / bénéficiaire",
                ),
              amount: z
                .string()
                .describe("Montant en unités du token pour ce bénéficiaire"),
              reference: z
                .string()
                .optional()
                .describe("Référence optionnelle pour cette ligne"),
            }),
          )
          .optional()
          .describe(
            "Batch payout : chaque entrée doit avoir le destinationId du bénéficiaire (payee). Jusqu'à 200 entrées. Ne pas confondre avec la destination par défaut du Client ID (paiement simple uniquement).",
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
              "Chaque entrée du batch doit avoir un destinationId, ou définissez RN_DESTINATION_ID / destinationId par défaut (une seule destination pour toutes les lignes).",
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

        const data = await postSecurePayment(body);

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
        "Créé plusieurs payouts et un lien uniquement de paiement via Secure Payment Page : un POST /v2/secure-payments/payouts par bénéficiaire, puis POST /v2/secure-payments/multicall-payouts → securePaymentUrl. payer = wallet du payeur (RN_PAYER). paymentCurrency au format TOKEN-network (ex. USDC-base). Chaque bénéficiaire : recipient, payee ou destinationId + amount. RN_CLIENT_ID.",
      inputSchema: {
        payer: z
          .string()
          .optional()
          .describe(
            "Wallet EVM du payeur (creatorWalletAddress). Omettre pour utiliser RN_PAYER — ne pas inventer ni passer de placeholder.",
          ),
        paymentCurrency: z
          .string()
          .optional()
          .describe(
            'Devise TOKEN-network pour toutes les lignes si omis par salarié, ex. "USDC-base" (défaut : RN_DEFAULT_PAYMENT_CURRENCY)',
          ),
        beneficiaries: z
          .array(
            z.object({
              name: z
                .string()
                .optional()
                .describe("Nom affiché (récapitulatif uniquement)"),
              recipient: z
                .string()
                .optional()
                .describe("Adresse EVM du bénéficiaire — ou payee / destinationId"),
              payee: z
                .string()
                .optional()
                .describe("Adresse EVM du salarié (0x…) — ou recipient / destinationId"),
              destinationId: z
                .string()
                .optional()
                .describe(
                  "Alternative : destinationId composite ; le payee est extrait avant @",
                ),
              paymentCurrency: z
                .string()
                .optional()
                .describe("Devise TOKEN-network pour cette ligne si différente du défaut batch"),
              amount: z
                .string()
                .describe("Montant en unités du token pour ce salarié"),
              reference: z
                .string()
                .optional()
                .describe("Référence optionnelle pour cette ligne"),
              recipientIdentifier: z
                .string()
                .optional()
                .describe("Identifiant bénéficiaire optionnel (API secure-payments/payouts)"),
            }),
          )
          .min(1)
          .max(200)
          .describe("Liste des salariés à payer dans le même lien multicall"),
        payrollPeriod: z
          .string()
          .optional()
          .describe(
            'Période de paie pour la référence API, ex. "2026-06" → reference payroll-2026-06 si reference non fournie',
          ),
        reference: z
          .string()
          .optional()
          .describe("Référence batch (ex. payroll-2026-06) pour regrouper les webhooks"),
        redirectUrl: z
          .string()
          .optional()
          .describe(
            "URL http(s) de redirection après paiement (défaut : RN_REDIRECT_URL), appliquée à chaque payout",
          ),
        redirectLabel: z
          .string()
          .optional()
          .describe(
            "Libellé du bouton de retour (défaut : RN_REDIRECT_LABEL), appliqué à chaque payout",
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
        const resolvedPayer = resolveWalletFromToolOrEnv(payer, "RN_PAYER");
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
            "payer obligatoire — adresse 0x… valide (paramètre outil) ou RN_PAYER dans .env / mcp.json.",
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
          const who = emp.name?.trim() || `ligne #${index + 1}`;

          const body = buildSecurePayoutBody({
            creatorWalletAddress: resolvedPayer,
            line,
            redirectUrl: resolvedRedirectUrl,
            redirectLabel: resolvedRedirectLabel,
          });

          const payoutData = await postSecurePaymentPayout(body);
          const token = payoutData.token;
          if (!token) {
            throw new Error(
              `Réponse payout sans token pour ${who} : ${JSON.stringify(payoutData)}`,
            );
          }
          childTokens.push(token);
          labels.push({
            name: emp.name,
            amount: line.amount,
            recipient: line.recipient,
          });
        }

        const batchData = await postMulticallPayouts(childTokens);

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
        "Vérifie si un paiement a été effectué via requestId (GET /v2/request, RN_CLIENT_ID).",
      inputSchema: {
        requestId: z
          .string()
          .describe(
            "ID de requête retourné par create_payment_link ou create_batch_payout_payment_link (champ requestIds)",
          ),
      },
    },
    async ({ requestId }) => {
      const resolvedRequestId = requestId?.trim();

      if (!resolvedRequestId) {
        return toolError(
          "Indiquez requestId (élément de requestIds retourné par create_payment_link ou create_batch_payout_payment_link).",
        );
      }

      try {
        const { data: requestStatus } =
          await rnApiRequest<RequestStatusResponse>(
            `/v2/request/${encodeURIComponent(resolvedRequestId)}`,
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
