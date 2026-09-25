// Fakes Xero's daily-quota 429 for four concurrent calls, to check they share one pause.
import { createXeroClient } from "./src/xero";

let calls = 0;
let refused = 0;
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("identity.xero.com")) return realFetch(input as string, init);

  calls++;
  if (refused < 4) {
    refused++;
    return new Response("rate limited", { status: 429, headers: { "X-Rate-Limit-Problem": "day", "Retry-After": "3600" } });
  }
  return new Response(JSON.stringify({ Accounts: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const started = Date.now();
const log = (message: string) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${message}`);

const client = createXeroClient(log, true);
const tenantId = client.connections[0].tenantId;

const results = await Promise.all(
  [1, 2, 3, 4].map(() => client.request("https://api.xero.com/api.xro/2.0/Accounts", tenantId)),
);

log(`ket qua: ${results.map((r) => r.status).join(", ")} | tong lan goi: ${calls}`);
