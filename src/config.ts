import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ENV_FILE = ".env";

export const DEFAULT_REDIRECT_URI = "http://localhost:3000/callback";
export const DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.banktransactions.read",
  "accounting.manualjournals.read",
  "accounting.reports.trialbalance.read",
  "accounting.reports.balancesheet.read",
  "accounting.attachments.read",
  "accounting.budgets.read",
].join(" ");

export interface Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
}

function parseEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

// Environment variables win, so the tool still works when values come from the shell or a container.
export function getConfig(): Config {
  const file = parseEnvFile();
  const read = (key: string) => process.env[key] || file[key] || "";
  return {
    clientId: read("XERO_CLIENT_ID"),
    clientSecret: read("XERO_CLIENT_SECRET"),
    redirectUri: read("XERO_REDIRECT_URI") || DEFAULT_REDIRECT_URI,
    scopes: read("XERO_SCOPES") || DEFAULT_SCOPES,
  };
}

export function saveCredentials(clientId: string, clientSecret: string) {
  const values: Record<string, string> = { ...parseEnvFile(), XERO_CLIENT_ID: clientId, XERO_CLIENT_SECRET: clientSecret };
  values.XERO_REDIRECT_URI ||= DEFAULT_REDIRECT_URI;
  values.XERO_SCOPES ||= DEFAULT_SCOPES;
  writeFileSync(ENV_FILE, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
}
