import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Xero counts 5,000 calls per organisation per day, and the day resets at midnight UTC.
export const DAILY_CALL_LIMIT = 5000;

const USAGE_FILE = resolve("data", "usage.json");
const FLUSH_EVERY = 20;

export interface TenantUsage {
  date: string;
  calls: number;
  rateLimited: number;
}

type UsageFile = Record<string, TenantUsage>;

let cache: UsageFile | undefined;
let unsaved = 0;

const getUtcDate = () => new Date().toISOString().slice(0, 10);

function load(): UsageFile {
  if (cache) return cache;
  cache = existsSync(USAGE_FILE) ? (JSON.parse(readFileSync(USAGE_FILE, "utf8")) as UsageFile) : {};
  return cache;
}

export function flushUsage() {
  if (!cache || unsaved === 0) return;
  mkdirSync(dirname(USAGE_FILE), { recursive: true });
  writeFileSync(USAGE_FILE, JSON.stringify(cache, null, 2));
  unsaved = 0;
}

export function getUsage(tenantId: string): TenantUsage {
  const usage = load()[tenantId];
  return usage && usage.date === getUtcDate() ? usage : { date: getUtcDate(), calls: 0, rateLimited: 0 };
}

// Counting every response, including 429s, because Xero charges the daily budget for those too.
export function recordCall(tenantId: string, wasRateLimited: boolean): TenantUsage {
  const usageFile = load();
  const current = getUsage(tenantId);
  current.calls++;
  if (wasRateLimited) current.rateLimited++;
  usageFile[tenantId] = current;

  if (++unsaved >= FLUSH_EVERY) flushUsage();
  return current;
}
