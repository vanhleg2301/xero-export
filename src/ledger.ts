import { randomUUID } from "node:crypto";
import { BooksError, loadAccounts, readBooksFile, writeBooksFile, type Account } from "./books";
import type { XeroRecord } from "./csvTables";
import { loadDataset } from "./dataStore";
import { assertNotLocked } from "./settings";

export type SourceType = "manual" | "invoice" | "bill" | "payment";

export interface JournalLine {
  accountCode: string;
  accountName: string;
  description: string;
  debit: number;
  credit: number;
}

export interface JournalEntry {
  id: string;
  number: string;
  date: string;
  narration: string;
  status: "posted" | "voided";
  sourceType: SourceType;
  sourceKey: string;
  sourceLabel: string;
  lines: JournalLine[];
  total: number;
  createdAt: string;
  reversalOf?: string;
  reversedBy?: string;
}

export interface EntryInput {
  date: string;
  narration: string;
  lines: { accountCode: string; description?: string; debit?: number; credit?: number }[];
  sourceType?: SourceType;
  sourceKey?: string;
  sourceLabel?: string;
}

const JOURNAL_FILE = "journal.json";
const CENT = 0.005;

const round2 = (value: number) => Math.round(value * 100) / 100;
const asString = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const asNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function loadJournal(tenantDir: string): JournalEntry[] {
  return readBooksFile<JournalEntry[]>(tenantDir, JOURNAL_FILE) ?? [];
}

function saveJournal(tenantDir: string, entries: JournalEntry[]) {
  writeBooksFile(tenantDir, JOURNAL_FILE, entries);
}

function getNextNumber(entries: JournalEntry[]): string {
  const highest = entries.reduce((max, entry) => Math.max(max, Number(entry.number.replace(/\D/g, "")) || 0), 0);
  return `JE-${String(highest + 1).padStart(4, "0")}`;
}

function buildEntry(input: EntryInput, accountsByCode: Map<string, Account>, entries: JournalEntry[]): JournalEntry {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new BooksError("Date must look like 2026-09-22.");
  if (input.lines.length < 2) throw new BooksError("A journal entry needs at least two lines.");

  const lines: JournalLine[] = input.lines.map((line) => {
    const account = accountsByCode.get(line.accountCode.trim().toLowerCase());
    if (!account) throw new BooksError(`No account with code ${line.accountCode} in the chart of accounts.`);
    const debit = round2(Math.abs(line.debit ?? 0));
    const credit = round2(Math.abs(line.credit ?? 0));
    if (debit > 0 && credit > 0) throw new BooksError(`Line ${account.code} has both a debit and a credit.`);
    if (debit === 0 && credit === 0) throw new BooksError(`Line ${account.code} has no amount.`);
    return { accountCode: account.code, accountName: account.name, description: (line.description ?? "").trim(), debit, credit };
  });

  const totalDebit = round2(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = round2(lines.reduce((sum, line) => sum + line.credit, 0));
  if (Math.abs(totalDebit - totalCredit) > CENT) {
    throw new BooksError(`Debits (${totalDebit.toFixed(2)}) do not equal credits (${totalCredit.toFixed(2)}).`);
  }
  if (totalDebit === 0) throw new BooksError("A journal entry cannot be for zero.");

  return {
    id: randomUUID(),
    number: getNextNumber(entries),
    date: input.date,
    narration: input.narration.trim(),
    status: "posted",
    sourceType: input.sourceType ?? "manual",
    sourceKey: input.sourceKey ?? "",
    sourceLabel: input.sourceLabel ?? "",
    lines,
    total: totalDebit,
    createdAt: new Date().toISOString(),
  };
}

export function postEntry(tenantDir: string, input: EntryInput): JournalEntry {
  assertNotLocked(tenantDir, input.date);
  const accountsByCode = new Map(loadAccounts(tenantDir).map((a) => [a.code.toLowerCase(), a]));
  const entries = loadJournal(tenantDir);
  const entry = buildEntry(input, accountsByCode, entries);
  saveJournal(tenantDir, [...entries, entry]);
  return entry;
}

// Posted entries are never edited: voiding posts the mirror image and links the two.
export function voidEntry(tenantDir: string, id: string): JournalEntry {
  const entries = loadJournal(tenantDir);
  const original = entries.find((entry) => entry.id === id);
  if (!original) throw new BooksError("Journal entry not found.");
  if (original.status === "voided") throw new BooksError(`${original.number} is already voided.`);

  const reversalDate = new Date().toISOString().slice(0, 10);
  assertNotLocked(tenantDir, reversalDate);

  const reversal: JournalEntry = {
    ...original,
    id: randomUUID(),
    number: getNextNumber(entries),
    narration: `Reversal of ${original.number}${original.narration ? ` — ${original.narration}` : ""}`,
    date: reversalDate,
    lines: original.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
    createdAt: new Date().toISOString(),
    sourceKey: "",
    reversalOf: original.id,
    reversedBy: undefined,
  };

  saveJournal(
    tenantDir,
    [...entries.map((entry) => (entry.id === original.id ? { ...entry, status: "voided" as const, reversedBy: reversal.id } : entry)), reversal],
  );
  return reversal;
}

// ---------- posting Xero documents ----------
interface PostingContext {
  accountsByCode: Map<string, Account>;
  accountsBySystem: Map<string, Account>;
}

function getSystemAccount(ctx: PostingContext, systemAccount: string, label: string): Account {
  const account = ctx.accountsBySystem.get(systemAccount);
  if (!account) throw new BooksError(`No ${label} account found. Import the chart of accounts from Xero first.`);
  return account;
}

function buildInvoiceInput(invoice: XeroRecord, ctx: PostingContext): EntryInput {
  const isBill = asString(invoice.Type) === "ACCPAY";
  const control = getSystemAccount(ctx, isBill ? "CREDITORS" : "DEBTORS", isBill ? "Accounts Payable" : "Accounts Receivable");
  const contact = asString((invoice.Contact as XeroRecord | undefined)?.Name);
  const number = asString(invoice.InvoiceNumber) || asString(invoice.InvoiceID).slice(0, 8);
  const lines: EntryInput["lines"] = [];

  for (const item of (invoice.LineItems as XeroRecord[] | undefined) ?? []) {
    const amount = round2(asNumber(item.LineAmount));
    if (amount === 0) continue;
    lines.push({
      accountCode: asString(item.AccountCode),
      description: asString(item.Description),
      debit: isBill ? amount : 0,
      credit: isBill ? 0 : amount,
    });
  }

  const tax = round2(asNumber(invoice.TotalTax));
  if (tax !== 0) {
    const gst = getSystemAccount(ctx, "GST", "GST / Sales Tax");
    lines.push({ accountCode: gst.code, description: "Tax", debit: isBill ? tax : 0, credit: isBill ? 0 : tax });
  }

  const total = round2(asNumber(invoice.Total));
  lines.push({
    accountCode: control.code,
    description: contact,
    debit: isBill ? 0 : total,
    credit: isBill ? total : 0,
  });

  return {
    date: asString(invoice.DateString).slice(0, 10),
    narration: `${isBill ? "Bill" : "Invoice"} ${number} — ${contact}`,
    lines,
    sourceType: isBill ? "bill" : "invoice",
    sourceKey: `invoice:${asString(invoice.InvoiceID)}`,
    sourceLabel: number,
  };
}

function buildPaymentInput(payment: XeroRecord, ctx: PostingContext): EntryInput {
  const invoice = (payment.Invoice as XeroRecord | undefined) ?? {};
  const isBillPayment = asString(invoice.Type) === "ACCPAY";
  const control = getSystemAccount(ctx, isBillPayment ? "CREDITORS" : "DEBTORS", isBillPayment ? "Accounts Payable" : "Accounts Receivable");
  const bankCode = asString((payment.Account as XeroRecord | undefined)?.Code);
  const amount = round2(asNumber(payment.Amount));
  const number = asString(invoice.InvoiceNumber);
  const contact = asString((invoice.Contact as XeroRecord | undefined)?.Name);

  return {
    date: asString(payment.Date).replace(/^\/Date\((-?\d+).*$/, (_, ms) => new Date(Number(ms)).toISOString().slice(0, 10)).slice(0, 10),
    narration: `Payment ${number ? `for ${number} ` : ""}— ${contact}`,
    lines: [
      { accountCode: bankCode, description: contact, debit: isBillPayment ? 0 : amount, credit: isBillPayment ? amount : 0 },
      { accountCode: control.code, description: number, debit: isBillPayment ? amount : 0, credit: isBillPayment ? 0 : amount },
    ],
    sourceType: "payment",
    sourceKey: `payment:${asString(payment.PaymentID)}`,
    sourceLabel: number,
  };
}

export interface ImportResult {
  posted: number;
  skipped: number;
  failures: string[];
}

const POSTABLE_INVOICE_STATUSES = new Set(["AUTHORISED", "PAID"]);

export function importXeroDocuments(tenantDir: string): ImportResult {
  const accounts = loadAccounts(tenantDir);
  if (accounts.length === 0) throw new BooksError("Import the chart of accounts first.");

  const ctx: PostingContext = {
    accountsByCode: new Map(accounts.map((a) => [a.code.toLowerCase(), a])),
    accountsBySystem: new Map(accounts.filter((a) => a.systemAccount).map((a) => [a.systemAccount as string, a])),
  };

  const entries = loadJournal(tenantDir);
  const alreadyPosted = new Set(entries.filter((e) => e.sourceKey).map((e) => e.sourceKey));
  const result: ImportResult = { posted: 0, skipped: 0, failures: [] };
  const added: JournalEntry[] = [];

  const documents: { records: XeroRecord[]; build: (record: XeroRecord) => EntryInput; keyOf: (record: XeroRecord) => string; skip: (record: XeroRecord) => boolean }[] = [
    {
      records: loadDataset(tenantDir, "Invoices"),
      build: (record) => buildInvoiceInput(record, ctx),
      keyOf: (record) => `invoice:${asString(record.InvoiceID)}`,
      skip: (record) => !POSTABLE_INVOICE_STATUSES.has(asString(record.Status)),
    },
    {
      records: loadDataset(tenantDir, "Payments"),
      build: (record) => buildPaymentInput(record, ctx),
      keyOf: (record) => `payment:${asString(record.PaymentID)}`,
      skip: (record) => asString(record.Status) === "DELETED",
    },
  ];

  for (const document of documents) {
    for (const record of document.records) {
      const key = document.keyOf(record);
      if (document.skip(record) || alreadyPosted.has(key)) {
        result.skipped++;
        continue;
      }
      try {
        const input = document.build(record);
        assertNotLocked(tenantDir, input.date);
        const entry = buildEntry(input, ctx.accountsByCode, [...entries, ...added]);
        added.push(entry);
        alreadyPosted.add(key);
        result.posted++;
      } catch (err) {
        result.failures.push(`${key.split(":")[0]} ${asString(record.InvoiceNumber) || key.slice(-8)}: ${(err as Error).message}`);
      }
    }
  }

  if (added.length > 0) saveJournal(tenantDir, [...entries, ...added]);
  return result;
}

// ---------- trial balance ----------
export interface TrialBalanceRow {
  code: string;
  name: string;
  accountClass: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
  entryCount: number;
}

export function getTrialBalance(tenantDir: string, asOf?: string): TrialBalance {
  const accounts = new Map(loadAccounts(tenantDir).map((a) => [a.code, a]));
  const entries = loadJournal(tenantDir).filter((entry) => !asOf || entry.date <= asOf);
  const totals = new Map<string, { debit: number; credit: number }>();

  for (const entry of entries) {
    for (const line of entry.lines) {
      const running = totals.get(line.accountCode) ?? { debit: 0, credit: 0 };
      running.debit += line.debit;
      running.credit += line.credit;
      totals.set(line.accountCode, running);
    }
  }

  const rows: TrialBalanceRow[] = [...totals]
    .map(([code, { debit, credit }]) => ({
      code,
      name: accounts.get(code)?.name ?? "(unknown account)",
      accountClass: accounts.get(code)?.accountClass ?? "",
      debit: round2(debit),
      credit: round2(credit),
      balance: round2(debit - credit),
    }))
    .filter((row) => row.debit !== 0 || row.credit !== 0)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const totalDebit = round2(rows.reduce((sum, row) => sum + row.debit, 0));
  const totalCredit = round2(rows.reduce((sum, row) => sum + row.credit, 0));

  return { rows, totalDebit, totalCredit, isBalanced: Math.abs(totalDebit - totalCredit) <= CENT, entryCount: entries.length };
}
