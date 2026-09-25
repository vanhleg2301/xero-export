import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getConfig } from "./config";
import { DAILY_CALL_LIMIT, flushUsage, recordCall } from "./usage";

const AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
export const API_BASE = "https://api.xero.com/api.xro/2.0";
const TOKEN_FILE = "tokens.json";
// Xero allows 60 calls a minute and 5 concurrent calls per organisation. Staying just under
// both is far faster than sleeping between calls, which also paid for every round trip.
const MAX_CALLS_PER_MINUTE = 45;
const LOG_USAGE_EVERY = 100;
// Xero frees the daily budget as a rolling 24-hour window, so waiting a while always
// releases some quota. Retry-After tells us how long; these bound a silly value.
// Quota comes back gradually rather than all at once, so checking every few minutes makes
// steady progress; Retry-After can say an hour, which would waste that whole hour.
const MIN_QUOTA_WAIT_SECONDS = 60;
const MAX_QUOTA_WAIT_SECONDS = 300;
const MAX_CONCURRENT_CALLS = 4;
const REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

export interface XeroConnection {
  tenantId: string;
  tenantName: string;
  tenantType: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  refreshed_at: number;
  connections: XeroConnection[];
}

export class DailyLimitError extends Error {}

function getBasicAuthHeader(): string {
  const { clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) throw new Error("No Xero app Client ID / Client Secret configured.");
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function saveTokens(tokens: TokenResponse, connections: XeroConnection[]): StoredTokens {
  const stored: StoredTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    refreshed_at: Date.now(),
    connections,
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(stored, null, 2));
  return stored;
}

function loadTokens(): StoredTokens {
  if (!existsSync(TOKEN_FILE)) throw new Error("Not connected to Xero yet.");
  return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as StoredTokens;
}

export function getAuthorizeUrl(state: string): string {
  const { clientId, redirectUri, scopes } = getConfig();
  return (
    `${AUTHORIZE_URL}?` +
    new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: scopes, state })
  );
}

export async function exchangeCodeForTokens(code: string): Promise<XeroConnection[]> {
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: getBasicAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: getConfig().redirectUri }),
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`);
  const tokens = (await tokenRes.json()) as TokenResponse;

  const connRes = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const connections = (await connRes.json()) as XeroConnection[];

  saveTokens(tokens, connections);
  return connections;
}

export function getConnectionStatus() {
  const { clientId, clientSecret } = getConfig();
  const hasCredentials = Boolean(clientId && clientSecret);
  if (!existsSync(TOKEN_FILE)) return { hasCredentials, isConnected: false, connections: [] as XeroConnection[] };
  const tokens = loadTokens();
  const refreshedAt = tokens.refreshed_at ?? tokens.expires_at - 30 * 60 * 1000;
  return {
    hasCredentials,
    isConnected: true,
    connections: tokens.connections,
    refreshTokenExpiresAt: refreshedAt + REFRESH_TOKEN_LIFETIME_MS,
  };
}

async function refreshTokens(current: StoredTokens): Promise<StoredTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: getBasicAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refresh_token }),
  });
  if (!res.ok) {
    throw new Error(`Refreshing the token failed (${res.status}): ${await res.text()} — click "Reconnect to Xero".`);
  }
  return saveTokens((await res.json()) as TokenResponse, current.connections);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RateLimiter {
  private readonly callTimes: number[] = [];
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  async acquire() {
    if (this.active >= MAX_CONCURRENT_CALLS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;

    for (;;) {
      const now = Date.now();
      while (this.callTimes.length > 0 && now - this.callTimes[0] >= 60_000) this.callTimes.shift();
      if (this.callTimes.length < MAX_CALLS_PER_MINUTE) break;
      await sleep(60_000 - (now - this.callTimes[0]) + 50);
    }
    this.callTimes.push(Date.now());
  }

  release() {
    this.active--;
    this.waiting.shift()?.();
  }

  // After a 429 the whole minute is spent: forget the window so we restart cleanly.
  reset() {
    this.callTimes.length = 0;
  }
}

export type XeroClient = ReturnType<typeof createXeroClient>;

export function createXeroClient(log: (message: string) => void, shouldWaitForQuota = true) {
  let tokens = loadTokens();
  let refreshing: Promise<StoredTokens> | undefined;
  let quotaPause: Promise<void> | undefined;
  const limiter = new RateLimiter();

  // Concurrent calls must not each kick off their own refresh.
  async function getAccessToken(): Promise<string> {
    if (Date.now() > tokens.expires_at - 60_000) {
      refreshing ??= refreshTokens(tokens).finally(() => {
        refreshing = undefined;
      });
      tokens = await refreshing;
    }
    return tokens.access_token;
  }

  async function request(url: string, tenantId: string, accept = "application/json"): Promise<Response> {
    let hasRetriedAuth = false;
    for (;;) {
      const accessToken = await getAccessToken();
      await limiter.acquire();
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: accept },
        });
      } finally {
        limiter.release();
      }

      const usage = recordCall(tenantId, res.status === 429);
      if (usage.calls % LOG_USAGE_EVERY === 0) {
        log(`  ${usage.calls.toLocaleString("en-GB")} Xero calls made today (Xero allows ${DAILY_CALL_LIMIT.toLocaleString("en-GB")} per rolling 24 hours)`);
      }

      if (res.status === 429) {
        if (res.headers.get("X-Rate-Limit-Problem") === "day") {
          flushUsage();
          const retryAfter = Number(res.headers.get("Retry-After")) || 900;
          const waitSeconds = Math.min(Math.max(retryAfter, MIN_QUOTA_WAIT_SECONDS), MAX_QUOTA_WAIT_SECONDS);

          if (!shouldWaitForQuota) {
            throw new DailyLimitError(
              `Xero's daily quota is used up (${usage.calls.toLocaleString("en-GB")} calls made today). ` +
                "Everything already downloaded is kept — start the sync again later.",
            );
          }

          // One pause shared by every worker, so this is logged and waited out once.
          quotaPause ??= (async () => {
            const resumeAt = new Date(Date.now() + waitSeconds * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
            log(`  Xero's daily quota is used up — trying again at ${resumeAt}. Leave this running, it continues on its own.`);
            await sleep(waitSeconds * 1000);
            limiter.reset();
            quotaPause = undefined;
          })();
          await quotaPause;
          continue;
        }
        const waitSeconds = Number(res.headers.get("Retry-After") ?? 60);
        log(`  Xero rate limit — waiting ${waitSeconds}s`);
        await sleep(waitSeconds * 1000);
        limiter.reset();
        continue;
      }

      if (res.status === 401 && !hasRetriedAuth) {
        hasRetriedAuth = true;
        tokens.expires_at = 0;
        continue;
      }

      if (!res.ok) throw new Error(`${res.status} ${url}: ${(await res.text()).slice(0, 500)}`);
      return res;
    }
  }

  return { connections: tokens.connections, request };
}
