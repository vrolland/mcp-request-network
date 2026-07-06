# Programmatic Batch Payouts with a Secure Payment Page Link

This guide shows how to **create multiple payouts programmatically and bundle them into a single hosted Secure Payment Page link**. The payer opens one link, reviews the full list, approves once, and pays everyone.

---

## Overview of the flow

It is a two-step process:

1. **Create one payout per recipient** → `POST /v2/secure-payments/payouts`. Each call returns a `token`.
2. **Bundle the tokens into one batch link** → `POST /v2/secure-payments/multicall-payouts` with the list of `token`s. The response contains the `securePaymentUrl` to share with the payer.

```
For each recipient:
   POST /v2/secure-payments/payouts   ──►  { token, securePaymentUrl }
                                                 │
   collect every token  ─────────────────────────┘
                                                 ▼
   POST /v2/secure-payments/multicall-payouts  { childTokens: [...] }
                                                 │
                                                 ▼
                          { securePaymentUrl }  ──►  share this link
```

---

## Authentication

All endpoints use this header:

- `x-client-id: <YOUR_CLIENT_ID>` — use a **backend Client ID** (one with no domain restriction) for server-to-server calls. A **frontend Client ID** (restricted to specific domains) requires a matching `Origin` header and will be rejected from a server — it only works from a browser on an allowed domain.

> **Use one Client ID consistently.** Every payout you intend to bundle must be created with the **same** Client ID (see *Constraints* below). Don't mix two different Client IDs in the same batch.

---

## Step 1 — Create each payout

`POST https://api.request.network/v2/secure-payments/payouts`

**Request body**

| Field | Required | Description |
|-------|----------|-------------|
| `creatorWalletAddress` | yes | The wallet address creating the payout (the payer). |
| `recipient` | yes | Recipient wallet address. |
| `network` | yes | Chain name, e.g. `base`, `sepolia`. |
| `currency` | yes | Payment currency as `<TOKEN>-<network>`, e.g. `USDC-base`. |
| `amount` | yes | Human-readable amount, e.g. `"50"`. |
| `reference` | no | Your own reference for the payout. |
| `recipientIdentifier` | no | Optional identifier for the recipient. |
| `redirectUrl` | no | URL to send the payer to after payment. |
| `redirectLabel` | no | Label for the redirect link. |
| `accessPolicy` | yes | Payer-screening policy. Use the "no screening" value below unless you need KYT. |

**`accessPolicy` — no screening (most common):**

```json
{
  "mode": "off",
  "screeningProvider": null,
  "hideUntilApproved": false,
  "hidePayeeAddress": false
}
```

**`accessPolicy` — with wallet screening (optional):**

```json
{
  "mode": "kyt_all_wallets",
  "screeningProvider": "hypernative",
  "hideUntilApproved": false,
  "hidePayeeAddress": true
}
```

**Example**

```bash
curl -X POST https://api.request.network/v2/secure-payments/payouts \
  -H "Content-Type: application/json" \
  -H "x-client-id: $RN_CLIENT_ID" \
  -d '{
    "creatorWalletAddress": "0xYourPayerWallet",
    "recipient": "0xb07d2398d2004378cad234da0ef14f1c94a530e4",
    "network": "base",
    "currency": "USDC-base",
    "amount": "50",
    "reference": "payroll-2026-04",
    "accessPolicy": { "mode": "off", "screeningProvider": null, "hideUntilApproved": false, "hidePayeeAddress": false }
  }'
```

**Response**

```json
{
  "requestIds": ["01..."],
  "securePaymentUrl": "https://pay.request.network/?token=01...",
  "token": "01..."
}
```

Keep each `token`. (The per-payout `securePaymentUrl` would pay just that one recipient — you don't need it for the batch.)

---

## Step 2 — Bundle the payouts into one batch link

`POST https://api.request.network/v2/secure-payments/multicall-payouts`

**Request body**

| Field | Required | Description |
|-------|----------|-------------|
| `childTokens` | yes | Array of the `token` values from Step 1. |

**Example**

```bash
curl -X POST https://api.request.network/v2/secure-payments/multicall-payouts \
  -H "Content-Type: application/json" \
  -H "x-client-id: $RN_CLIENT_ID" \
  -d '{ "childTokens": ["01...A", "01...B", "01...C"] }'
```

**Response**

```json
{
  "type": "multicall",
  "token": "01...PARENT",
  "securePaymentUrl": "https://pay.request.network/?token=01...PARENT",
  "status": "pending",
  "expiresAt": "2026-06-29T12:15:00.000Z",
  "items": [
    { "securePaymentToken": "01...A", "requestId": "01...", "position": 0 },
    { "securePaymentToken": "01...B", "requestId": "01...", "position": 1 }
  ]
}
```

Share `securePaymentUrl` with the payer. Opening it shows the full payee list and total, with a single approve-then-pay flow.

---

## End-to-end example (TypeScript)

```ts
const API = "https://api.request.network";
const headers = {
  "Content-Type": "application/json",
  "x-client-id": process.env.RN_CLIENT_ID!, // one Client ID for ALL calls
};

const noScreening = {
  mode: "off",
  screeningProvider: null,
  hideUntilApproved: false,
  hidePayeeAddress: false,
};

const recipients = [
  { address: "0xAAA...", amount: "50", reference: "payroll-alice" },
  { address: "0xBBB...", amount: "75", reference: "payroll-bob" },
];

// Step 1 — create one payout per recipient
const childTokens: string[] = [];
for (const r of recipients) {
  const res = await fetch(`${API}/v2/secure-payments/payouts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      creatorWalletAddress: process.env.PAYER_WALLET,
      recipient: r.address,
      network: "base",
      currency: "USDC-base",
      amount: r.amount,
      reference: r.reference,
      accessPolicy: noScreening,
    }),
  });
  if (!res.ok) throw new Error(`Payout failed: ${await res.text()}`);
  const { token } = await res.json();
  childTokens.push(token);
}

// Step 2 — bundle into one batch link
const batchRes = await fetch(`${API}/v2/secure-payments/multicall-payouts`, {
  method: "POST",
  headers,
  body: JSON.stringify({ childTokens }),
});
if (!batchRes.ok) throw new Error(`Batch failed: ${await batchRes.text()}`);
const batch = await batchRes.json();

console.log("Send this to the payer:", batch.securePaymentUrl);
```

---

## Constraints and things to know

- **Same Client ID for every payout.** All `childTokens` must be created with the same Client ID.
- **Tokens expire.** Payout and batch tokens have a limited lifetime (around 15 minutes by default). Create the payouts and bundle them promptly; the batch response's `expiresAt` tells you when the link stops being payable.
- **Cross-chain is supported.** Recipients can be on different chains and currencies. Tron is not supported in a batch.
- **One signature for the payer.** The hosted page lets the payer approve once and pay the whole list.

---

## Field/response quick reference

**`POST /v2/secure-payments/payouts` →**
`{ requestIds: string[], securePaymentUrl: string, token: string }`

**`POST /v2/secure-payments/multicall-payouts` →**
`{ type: "multicall", token: string, securePaymentUrl: string, status: "pending", expiresAt: string, items: { securePaymentToken, requestId, position }[] }`
