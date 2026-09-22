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
  isBankAccount?: boolean;
  systemAccount?: string;
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

const getBooksFile = (tenantDir: string, name: string) => join(tenantDir, "books", name);

export function readBooksFile<T>(tenantDir: string, name: string): T | undefined {
  const file = getBooksFile(tenantDir, name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
}

// Write to a temp file first so a crash mid-write cannot leave the books truncated.
export function writeBooksFile(tenantDir: string, name: string, value: unknown) {
  const file = getBooksFile(tenantDir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}

export function loadAccounts(tenantDir: string): Account[] {
  return readBooksFile<Account[]>(tenantDir, "accounts.json") ?? [];
}

function saveAccounts(tenantDir: string, accounts: Account[]) {
  const sorted = [...accounts].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  writeBooksFile(tenantDir, "accounts.json", sorted);
  return sorted;
}

const asString = (value: unknown) => (value === null || value === undefined ? "" : String(value));

function toAccountClass(value: unknown): AccountClass {
  const key = asString(value).toLowerCase();
  return (ACCOUNT_CLASSES as readonly string[]).includes(key) ? (key as AccountClass) : "expense";
}

// Seeding keeps accounts the user already edited: it adds missing codes and fills in the
// Xero links (system account, id) on accounts that do not have them yet.
export function seedAccountsFromXero(tenantDir: string): { added: number; kept: number } {
  const existing = loadAccounts(tenantDir);
  const byCode = new Map(existing.map((account) => [account.code.toLowerCase(), account]));
  const xeroAccounts = loadDataset(tenantDir, "Accounts");
  const added: Account[] = [];

  for (const record of xeroAccounts as XeroRecord[]) {
    const code = asString(record.Code).trim();
    if (!code) continue;

    const current = byCode.get(code.toLowerCase());
    if (current) {
      current.systemAccount ??= asString(record.SystemAccount) || undefined;
      current.xeroAccountId ??= asString(record.AccountID) || undefined;
      continue;
    }
    added.push({
      id: randomUUID(),
      code,
      name: asString(record.Name),
      accountClass: toAccountClass(record.Class),
      type: XERO_TYPE_LABELS[asString(record.Type)] ?? asString(record.Type),
      taxRate: asString(record.TaxType),
      description: asString(record.Description),
      isActive: asString(record.Status) !== "ARCHIVED",
      isBankAccount: asString(record.Type) === "BANK" || undefined,
      systemAccount: asString(record.SystemAccount) || undefined,
      xeroAccountId: asString(record.AccountID) || undefined,
    });
  }

  saveAccounts(tenantDir, [...existing, ...added]);
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
  isBankAccount?: boolean;
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
    isBankAccount: input.isBankAccount ?? existing?.isBankAccount,
    systemAccount: existing?.systemAccount,
    xeroAccountId: existing?.xeroAccountId,
  };

  saveAccounts(tenantDir, existing ? accounts.map((a) => (a.id === account.id ? account : a)) : [...accounts, account]);
  return account;
}
