import { randomUUID } from "node:crypto";
import { BooksError, loadAccounts, readBooksFile, writeBooksFile, type Account } from "./books";
import type { XeroRecord } from "./csvTables";
import { loadDataset } from "./dataStore";
import { assertNotLocked } from "./settings";

export type SourceType =
  | "manual"
  | "invoice"
  | "bill"
  | "payment"
  | "credit-note"
  | "bank-transaction"
  | "bank-transfer"
  | "xero-journal";

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
const asRecord = (value: unknown) => (value ?? {}) as XeroRecord;

// Xero sends dates either as "2026-09-02T00:00:00" or as "/Date(1756771200000+0000)/".
function toIsoDate(value: unknown): string {
  const raw = asString(value);
  const ms = /^\/Date\((-?\d+)/.exec(raw);
  return ms ? new Date(Number(ms[1])).toISOString().slice(0, 10) : raw.slice(0, 10);
}

// On a tax-inclusive document LineAmount already contains the tax, so the tax has to come
// off before it is posted — otherwise the tax would be counted twice.
function getLineNetAmount(item: XeroRecord, lineAmountTypes: string): number {
  const amount = asNumber(item.LineAmount);
  return round2(lineAmountTypes === "Inclusive" ? amount - asNumber(item.TaxAmount) : amount);
}

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
  accountsByXeroId: Map<string, Account>;
}

// Xero names the bank account on a transaction by code when it has one and by id otherwise.
function getBankCode(ctx: PostingContext, bankAccount: XeroRecord): string {
  const code = asString(bankAccount.Code).trim();
  if (code) return code;
  const byId = ctx.accountsByXeroId.get(asString(bankAccount.AccountID));
  if (byId) return byId.code;
  throw new BooksError(`bank account "${asString(bankAccount.Name)}" is not in the chart of accounts — import it from Xero first`);
}

function getSystemAccount(ctx: PostingContext, systemAccount: string, label: string): Account {
  const account = ctx.accountsBySystem.get(systemAccount);
  if (!account) throw new BooksError(`No ${label} account found. Import the chart of accounts from Xero first.`);
  return account;
}

function buildInvoiceInput(invoice: XeroRecord, ctx: PostingContext): EntryInput {
  const isBill = asString(invoice.Type) === "ACCPAY";
  const control = getSystemAccount(ctx, isBill ? "CREDITORS" : "DEBTORS", isBill ? "Accounts Payable" : "Accounts Receivable");
  const contact = asString(asRecord(invoice.Contact).Name);
  const number = asString(invoice.InvoiceNumber) || asString(invoice.InvoiceID).slice(0, 8);
  const lines: EntryInput["lines"] = [];

  for (const item of (invoice.LineItems as XeroRecord[] | undefined) ?? []) {
    const amount = getLineNetAmount(item, asString(invoice.LineAmountTypes));
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

// Xero's PaymentType says which control account the payment settles and which way the cash
// moved; a refund on a credit note runs the opposite way to a payment on an invoice.
const PAYMENT_TYPES: Record<string, { systemAccount: "DEBTORS" | "CREDITORS"; isMoneyIn: boolean }> = {
  ACCRECPAYMENT: { systemAccount: "DEBTORS", isMoneyIn: true },
  ARCREDITPAYMENT: { systemAccount: "DEBTORS", isMoneyIn: false },
  ACCPAYPAYMENT: { systemAccount: "CREDITORS", isMoneyIn: false },
  APCREDITPAYMENT: { systemAccount: "CREDITORS", isMoneyIn: true },
};

function getPaymentType(payment: XeroRecord): string {
  const declared = asString(payment.PaymentType);
  if (declared) return declared;
  // Older payloads leave PaymentType out; fall back to the document it settles.
  return asString(asRecord(payment.Invoice).Type) === "ACCPAY" ? "ACCPAYPAYMENT" : "ACCRECPAYMENT";
}

function buildPaymentInput(payment: XeroRecord, ctx: PostingContext): EntryInput {
  const paymentType = PAYMENT_TYPES[getPaymentType(payment)];
  if (!paymentType) throw new BooksError(`payment type ${getPaymentType(payment)} is not supported`);

  const settled = asRecord(asRecord(payment.Invoice).InvoiceID ? payment.Invoice : payment.CreditNote);
  const control = getSystemAccount(ctx, paymentType.systemAccount, paymentType.systemAccount === "DEBTORS" ? "Accounts Receivable" : "Accounts Payable");
  const bankCode = getBankCode(ctx, asRecord(payment.Account));

  const amount = round2(asNumber(payment.Amount));
  const number = asString(settled.InvoiceNumber) || asString(settled.CreditNoteNumber);
  const contact = asString(asRecord(settled.Contact).Name);

  return {
    date: toIsoDate(payment.DateString || payment.Date),
    narration: `${paymentType.isMoneyIn ? "Payment received" : "Payment made"}${number ? ` for ${number}` : ""}${contact ? ` — ${contact}` : ""}`,
    lines: [
      { accountCode: bankCode, description: contact, debit: paymentType.isMoneyIn ? amount : 0, credit: paymentType.isMoneyIn ? 0 : amount },
      { accountCode: control.code, description: number, debit: paymentType.isMoneyIn ? 0 : amount, credit: paymentType.isMoneyIn ? amount : 0 },
    ],
    sourceType: "payment",
    sourceKey: `payment:${asString(payment.PaymentID)}`,
    sourceLabel: number,
  };
}

// A credit note is the mirror image of the invoice it credits.
function buildCreditNoteInput(note: XeroRecord, ctx: PostingContext): EntryInput {
  const isSupplierCredit = asString(note.Type) === "ACCPAYCREDIT";
  const control = getSystemAccount(ctx, isSupplierCredit ? "CREDITORS" : "DEBTORS", isSupplierCredit ? "Accounts Payable" : "Accounts Receivable");
  const contact = asString(asRecord(note.Contact).Name);
  const number = asString(note.CreditNoteNumber) || asString(note.CreditNoteID).slice(0, 8);
  const lines: EntryInput["lines"] = [];

  for (const item of (note.LineItems as XeroRecord[] | undefined) ?? []) {
    const amount = getLineNetAmount(item, asString(note.LineAmountTypes));
    if (amount === 0) continue;
    lines.push({
      accountCode: asString(item.AccountCode),
      description: asString(item.Description),
      debit: isSupplierCredit ? 0 : amount,
      credit: isSupplierCredit ? amount : 0,
    });
  }

  const tax = round2(asNumber(note.TotalTax));
  if (tax !== 0) {
    const gst = getSystemAccount(ctx, "GST", "GST / Sales Tax");
    lines.push({ accountCode: gst.code, description: "Tax", debit: isSupplierCredit ? 0 : tax, credit: isSupplierCredit ? tax : 0 });
  }

  const total = round2(asNumber(note.Total));
  lines.push({
    accountCode: control.code,
    description: contact,
    debit: isSupplierCredit ? total : 0,
    credit: isSupplierCredit ? 0 : total,
  });

  return {
    date: toIsoDate(note.DateString || note.Date),
    narration: `Credit note ${number} — ${contact}`,
    lines,
    sourceType: "credit-note",
    sourceKey: `creditnote:${asString(note.CreditNoteID)}`,
    sourceLabel: number,
  };
}

// Spend and receive money: cash against the coded lines, no invoice involved.
function buildBankTransactionInput(transaction: XeroRecord, ctx: PostingContext): EntryInput {
  const isSpend = asString(transaction.Type) === "SPEND";
  const bankCode = getBankCode(ctx, asRecord(transaction.BankAccount));

  const contact = asString(asRecord(transaction.Contact).Name);
  const reference = asString(transaction.Reference);
  const lines: EntryInput["lines"] = [];

  for (const item of (transaction.LineItems as XeroRecord[] | undefined) ?? []) {
    const amount = getLineNetAmount(item, asString(transaction.LineAmountTypes));
    if (amount === 0) continue;
    lines.push({
      accountCode: asString(item.AccountCode),
      description: asString(item.Description),
      debit: isSpend ? amount : 0,
      credit: isSpend ? 0 : amount,
    });
  }

  const tax = round2(asNumber(transaction.TotalTax));
  if (tax !== 0) {
    const gst = getSystemAccount(ctx, "GST", "GST / Sales Tax");
    lines.push({ accountCode: gst.code, description: "Tax", debit: isSpend ? tax : 0, credit: isSpend ? 0 : tax });
  }

  const total = round2(asNumber(transaction.Total));
  lines.push({ accountCode: bankCode, description: contact || reference, debit: isSpend ? 0 : total, credit: isSpend ? total : 0 });

  return {
    date: toIsoDate(transaction.DateString || transaction.Date),
    narration: `${isSpend ? "Spend money" : "Receive money"}${contact ? ` — ${contact}` : ""}${reference ? ` (${reference})` : ""}`,
    lines,
    sourceType: "bank-transaction",
    sourceKey: `banktransaction:${asString(transaction.BankTransactionID)}`,
    sourceLabel: reference,
  };
}

function buildBankTransferInput(transfer: XeroRecord, ctx: PostingContext): EntryInput {
  const fromCode = getBankCode(ctx, asRecord(transfer.FromBankAccount));
  const toCode = getBankCode(ctx, asRecord(transfer.ToBankAccount));

  const amount = round2(asNumber(transfer.Amount));
  const fromName = asString(asRecord(transfer.FromBankAccount).Name);
  const toName = asString(asRecord(transfer.ToBankAccount).Name);

  return {
    date: toIsoDate(transfer.DateString || transfer.Date),
    narration: `Bank transfer ${fromName || fromCode} to ${toName || toCode}`,
    lines: [
      { accountCode: toCode, description: `From ${fromName || fromCode}`, debit: amount, credit: 0 },
      { accountCode: fromCode, description: `To ${toName || toCode}`, debit: 0, credit: amount },
    ],
    sourceType: "bank-transfer",
    sourceKey: `banktransfer:${asString(transfer.BankTransferID)}`,
    sourceLabel: "",
  };
}

// Manual journals come across already balanced: a positive LineAmount is a debit.
function buildManualJournalInput(journal: XeroRecord): EntryInput {
  const journalLines = (journal.JournalLines as XeroRecord[] | undefined) ?? [];
  const tax = round2(journalLines.reduce((sum, line) => sum + asNumber(line.TaxAmount), 0));
  if (tax !== 0) throw new BooksError("manual journals that carry tax are not supported yet");

  const lines: EntryInput["lines"] = [];
  for (const line of journalLines) {
    const amount = round2(asNumber(line.LineAmount));
    if (amount === 0) continue;
    lines.push({
      accountCode: asString(line.AccountCode),
      description: asString(line.Description),
      debit: amount > 0 ? amount : 0,
      credit: amount < 0 ? -amount : 0,
    });
  }

  return {
    date: toIsoDate(journal.DateString || journal.Date),
    narration: asString(journal.Narration) || "Manual journal from Xero",
    lines,
    sourceType: "xero-journal",
    sourceKey: `manualjournal:${asString(journal.ManualJournalID)}`,
    sourceLabel: "",
  };
}

export interface ImportResult {
  posted: number;
  skipped: number;
  /** Records Xero holds that this ledger deliberately does not post, counted by kind. */
  notPosted: Record<string, number>;
  failures: string[];
}

interface DocumentSource {
  dataset: string;
  keyOf: (record: XeroRecord) => string;
  labelOf: (record: XeroRecord) => string;
  /** Drafts, voided and deleted records never belong in the ledger. */
  isSkipped: (record: XeroRecord) => boolean;
  /** A label when the record is real but out of scope, so the user can see what was left out. */
  getUnsupported?: (record: XeroRecord) => string | undefined;
  build: (record: XeroRecord, ctx: PostingContext) => EntryInput;
}

const POSTABLE_INVOICE_STATUSES = new Set(["AUTHORISED", "PAID"]);
// Xero mirrors transfers, prepayments and overpayments as hyphenated bank transactions as well
// as their own documents; posting both sides would count the cash twice.
const POSTABLE_BANK_TRANSACTION_TYPES = new Set(["SPEND", "RECEIVE"]);

const DOCUMENT_SOURCES: DocumentSource[] = [
  {
    dataset: "Invoices",
    keyOf: (record) => `invoice:${asString(record.InvoiceID)}`,
    labelOf: (record) => `${asString(record.Type) === "ACCPAY" ? "bill" : "invoice"} ${asString(record.InvoiceNumber)}`,
    isSkipped: (record) => !POSTABLE_INVOICE_STATUSES.has(asString(record.Status)),
    build: buildInvoiceInput,
  },
  {
    dataset: "CreditNotes",
    keyOf: (record) => `creditnote:${asString(record.CreditNoteID)}`,
    labelOf: (record) => `credit note ${asString(record.CreditNoteNumber)}`,
    isSkipped: (record) => !POSTABLE_INVOICE_STATUSES.has(asString(record.Status)),
    build: buildCreditNoteInput,
  },
  {
    dataset: "Payments",
    keyOf: (record) => `payment:${asString(record.PaymentID)}`,
    labelOf: (record) => `payment ${asString(record.PaymentID).slice(0, 8)}`,
    isSkipped: (record) => asString(record.Status) === "DELETED",
    getUnsupported: (record) => (PAYMENT_TYPES[getPaymentType(record)] ? undefined : `Payments of type ${getPaymentType(record)}`),
    build: buildPaymentInput,
  },
  {
    dataset: "BankTransactions",
    keyOf: (record) => `banktransaction:${asString(record.BankTransactionID)}`,
    labelOf: (record) => `bank transaction ${asString(record.Reference) || asString(record.BankTransactionID).slice(0, 8)}`,
    isSkipped: (record) => asString(record.Status) === "DELETED" || asString(record.Status) === "VOIDED",
    getUnsupported: (record) =>
      POSTABLE_BANK_TRANSACTION_TYPES.has(asString(record.Type)) ? undefined : `Bank transactions of type ${asString(record.Type)}`,
    build: buildBankTransactionInput,
  },
  {
    dataset: "BankTransfers",
    keyOf: (record) => `banktransfer:${asString(record.BankTransferID)}`,
    labelOf: (record) => `bank transfer ${asString(record.BankTransferID).slice(0, 8)}`,
    isSkipped: () => false,
    build: buildBankTransferInput,
  },
  {
    dataset: "ManualJournals",
    keyOf: (record) => `manualjournal:${asString(record.ManualJournalID)}`,
    labelOf: (record) => `manual journal ${asString(record.ManualJournalID).slice(0, 8)}`,
    isSkipped: (record) => asString(record.Status) !== "POSTED",
    build: buildManualJournalInput,
  },
  {
    dataset: "Prepayments",
    keyOf: (record) => `prepayment:${asString(record.PrepaymentID)}`,
    labelOf: (record) => `prepayment ${asString(record.PrepaymentID).slice(0, 8)}`,
    isSkipped: (record) => asString(record.Status) === "VOIDED",
    getUnsupported: () => "Prepayments",
    build: () => {
      throw new BooksError("prepayments are not supported yet");
    },
  },
  {
    dataset: "Overpayments",
    keyOf: (record) => `overpayment:${asString(record.OverpaymentID)}`,
    labelOf: (record) => `overpayment ${asString(record.OverpaymentID).slice(0, 8)}`,
    isSkipped: (record) => asString(record.Status) === "VOIDED",
    getUnsupported: () => "Overpayments",
    build: () => {
      throw new BooksError("overpayments are not supported yet");
    },
  },
];

export function importXeroDocuments(tenantDir: string): ImportResult {
  const accounts = loadAccounts(tenantDir);
  if (accounts.length === 0) throw new BooksError("Import the chart of accounts first.");

  const ctx: PostingContext = {
    accountsByCode: new Map(accounts.map((a) => [a.code.toLowerCase(), a])),
    accountsBySystem: new Map(accounts.filter((a) => a.systemAccount).map((a) => [a.systemAccount as string, a])),
    accountsByXeroId: new Map(accounts.filter((a) => a.xeroAccountId).map((a) => [a.xeroAccountId as string, a])),
  };

  const entries = loadJournal(tenantDir);
  const alreadyPosted = new Set(entries.filter((e) => e.sourceKey).map((e) => e.sourceKey));
  const result: ImportResult = { posted: 0, skipped: 0, notPosted: {}, failures: [] };
  const added: JournalEntry[] = [];

  for (const source of DOCUMENT_SOURCES) {
    for (const record of loadDataset(tenantDir, source.dataset)) {
      const key = source.keyOf(record);
      if (source.isSkipped(record) || alreadyPosted.has(key)) {
        result.skipped++;
        continue;
      }

      const unsupported = source.getUnsupported?.(record);
      if (unsupported) {
        result.notPosted[unsupported] = (result.notPosted[unsupported] ?? 0) + 1;
        continue;
      }

      try {
        const input = source.build(record, ctx);
        assertNotLocked(tenantDir, input.date);
        const entry = buildEntry(input, ctx.accountsByCode, [...entries, ...added]);
        added.push(entry);
        alreadyPosted.add(key);
        result.posted++;
      } catch (err) {
        result.failures.push(`${source.labelOf(record)}: ${(err as Error).message}`);
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
