import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { XeroRecord } from "./csvTables";
import { loadDataset } from "./dataStore";

export const ACCOUNT_CLASSES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

export interface Account {
  id: string;
  code: string;
  name: string;
  accountClass: AccountClass;
  type: string;
  taxRate: string;
  description: string;
  isActive: boolean;
  xeroAccountId?: string;
}

// Xero account types, kept as the sub-type under our five classes.
const XERO_TYPE_LABELS: Record<string, string> = {
  BANK: "Bank",
  CURRENT: "Current Asset",
  CURRLIAB: "Current Liability",
  DEPRECIATN: "Depreciation",
  DIRECTCOSTS: "Direct Costs",
  EQUITY: "Equity",
  EXPENSE: "Expense",
  FIXED: "Fixed Asset",
  INVENTORY: "Inventory",
  LIABILITY: "Liability",
  NONCURRENT: "Non-current Asset",
  OTHERINCOME: "Other Income",
  OVERHEADS: "Overhead",
  PREPAYMENT: "Prepayment",
  REVENUE: "Revenue",
  SALES: "Sales",
  TERMLIAB: "Non-current Liability",
};

export class BooksError extends Error {}

const getBooksDir = (tenantDir: string) => join(tenantDir, "books");
const getAccountsFile = (tenantDir: string) => join(getBooksDir(tenantDir), "accounts.json");

function writeJsonFile(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}

export function loadAccounts(tenantDir: string): Account[] {
  const file = getAccountsFile(tenantDir);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Account[]) : [];
}

function saveAccounts(tenantDir: string, accounts: Account[]) {
  const sorted = [...accounts].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  writeJsonFile(getAccountsFile(tenantDir), sorted);
  return sorted;
}

const asString = (value: unknown) => (value === null || value === undefined ? "" : String(value));

function toAccountClass(value: unknown): AccountClass {
  const key = asString(value).toLowerCase();
  return (ACCOUNT_CLASSES as readonly string[]).includes(key) ? (key as AccountClass) : "expense";
}

// Seeding keeps accounts the user already edited and only adds codes that are missing.
export function seedAccountsFromXero(tenantDir: string): { added: number; kept: number } {
  const existing = loadAccounts(tenantDir);
  const byCode = new Map(existing.map((account) => [account.code.toLowerCase(), account]));
  const xeroAccounts = loadDataset(tenantDir, "Accounts");
  const added: Account[] = [];

  for (const record of xeroAccounts as XeroRecord[]) {
    const code = asString(record.Code).trim();
    if (!code || byCode.has(code.toLowerCase())) continue;
    added.push({
      id: randomUUID(),
      code,
      name: asString(record.Name),
      accountClass: toAccountClass(record.Class),
      type: XERO_TYPE_LABELS[asString(record.Type)] ?? asString(record.Type),
      taxRate: asString(record.TaxType),
      description: asString(record.Description),
      isActive: asString(record.Status) !== "ARCHIVED",
      xeroAccountId: asString(record.AccountID) || undefined,
    });
  }

  if (added.length > 0) saveAccounts(tenantDir, [...existing, ...added]);
  return { added: added.length, kept: existing.length };
}

export interface AccountInput {
  id?: string;
  code: string;
  name: string;
  accountClass: string;
  type?: string;
  taxRate?: string;
  description?: string;
  isActive?: boolean;
}

export function upsertAccount(tenantDir: string, input: AccountInput): Account {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new BooksError("Account code is required.");
  if (!name) throw new BooksError("Account name is required.");
  if (!(ACCOUNT_CLASSES as readonly string[]).includes(input.accountClass)) {
    throw new BooksError(`Account class must be one of: ${ACCOUNT_CLASSES.join(", ")}.`);
  }

  const accounts = loadAccounts(tenantDir);
  const clash = accounts.find((a) => a.code.toLowerCase() === code.toLowerCase() && a.id !== input.id);
  if (clash) throw new BooksError(`Code ${code} is already used by "${clash.name}".`);

  const existing = input.id ? accounts.find((a) => a.id === input.id) : undefined;
  if (input.id && !existing) throw new BooksError("Account not found.");

  const account: Account = {
    id: existing?.id ?? randomUUID(),
    code,
    name,
    accountClass: input.accountClass as AccountClass,
    type: (input.type ?? existing?.type ?? "").trim(),
    taxRate: (input.taxRate ?? existing?.taxRate ?? "").trim(),
    description: (input.description ?? existing?.description ?? "").trim(),
    isActive: input.isActive ?? existing?.isActive ?? true,
    xeroAccountId: existing?.xeroAccountId,
  };

  saveAccounts(tenantDir, existing ? accounts.map((a) => (a.id === account.id ? account : a)) : [...accounts, account]);
  return account;
}
