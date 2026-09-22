import { randomUUID } from "node:crypto";
import { BooksError, loadAccounts, readBooksFile, writeBooksFile, type Account } from "./books";
import { loadJournal, postEntry, type JournalEntry } from "./ledger";

export interface StatementLine {
  id: string;
  bankAccountCode: string;
  date: string;
  description: string;
  reference: string;
  amount: number; // positive = money in, negative = money out
  status: "unreconciled" | "reconciled";
  journalEntryId?: string;
  importedAt: string;
}

const LINES_FILE = "statement-lines.json";
const MATCH_WINDOW_DAYS = 7;

const round2 = (value: number) => Math.round(value * 100) / 100;

export function loadStatementLines(tenantDir: string): StatementLine[] {
  return readBooksFile<StatementLine[]>(tenantDir, LINES_FILE) ?? [];
}

function saveStatementLines(tenantDir: string, lines: StatementLine[]) {
  writeBooksFile(tenantDir, LINES_FILE, [...lines].sort((a, b) => a.date.localeCompare(b.date)));
}

export function getBankAccounts(tenantDir: string): Account[] {
  return loadAccounts(tenantDir).filter((account) => account.isBankAccount && account.isActive);
}

function requireBankAccount(tenantDir: string, code: string): Account {
  const account = getBankAccounts(tenantDir).find((a) => a.code === code);
  if (!account) throw new BooksError(`${code} is not marked as a bank account. Tick "Bank account" on it in the chart of accounts.`);
  return account;
}

// ---------- statement import ----------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') inQuotes = false;
      else value += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") value += char;
  }
  row.push(value);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  return rows;
}

function normaliseDate(value: string): string {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parts = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (parts) return `${parts[3]}-${parts[2].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  throw new BooksError(`Cannot read the date "${value}". Use dd/mm/yyyy or yyyy-mm-dd.`);
}

const toAmount = (value: string) => {
  const cleaned = value.replace(/[^0-9.,-]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", ".");
  return cleaned ? Number(cleaned) : 0;
};

const findColumn = (header: string[], candidates: string[]) =>
  header.findIndex((name) => candidates.some((candidate) => name.trim().toLowerCase() === candidate));

export interface ImportStatementResult {
  added: number;
  skipped: number;
}

export function importStatementCsv(tenantDir: string, bankAccountCode: string, csv: string): ImportStatementResult {
  requireBankAccount(tenantDir, bankAccountCode);
  const rows = parseCsv(csv).filter((row) => row.some((cell) => cell.trim() !== ""));
  if (rows.length < 2) throw new BooksError("That file has no rows.");

  const header = rows[0];
  const dateIndex = findColumn(header, ["date", "transaction date", "posting date"]);
  const descriptionIndex = findColumn(header, ["description", "details", "narrative", "payee", "particulars"]);
  const amountIndex = findColumn(header, ["amount", "value"]);
  const inIndex = findColumn(header, ["money in", "credit", "deposit", "paid in"]);
  const outIndex = findColumn(header, ["money out", "debit", "withdrawal", "paid out"]);
  const referenceIndex = findColumn(header, ["reference", "ref", "cheque number"]);

  if (dateIndex < 0) throw new BooksError('No "Date" column found in that file.');
  if (amountIndex < 0 && inIndex < 0 && outIndex < 0) {
    throw new BooksError('No "Amount" column found — or a pair of "Money In" / "Money Out" columns.');
  }

  const existing = loadStatementLines(tenantDir);
  const seen = new Set(existing.map((line) => `${line.bankAccountCode}|${line.date}|${line.amount}|${line.description}`));
  const added: StatementLine[] = [];
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const date = normaliseDate(row[dateIndex] ?? "");
    const amount =
      amountIndex >= 0
        ? round2(toAmount(row[amountIndex] ?? ""))
        : round2(toAmount(row[inIndex] ?? "") - Math.abs(toAmount(row[outIndex] ?? "")));
    if (amount === 0) {
      skipped++;
      continue;
    }
    const description = (row[descriptionIndex] ?? "").trim();
    const key = `${bankAccountCode}|${date}|${amount}|${description}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    added.push({
      id: randomUUID(),
      bankAccountCode,
      date,
      description,
      reference: (row[referenceIndex] ?? "").trim(),
      amount,
      status: "unreconciled",
      importedAt: new Date().toISOString(),
    });
  }

  if (added.length > 0) saveStatementLines(tenantDir, [...existing, ...added]);
  return { added: added.length, skipped };
}

export function addStatementLine(
  tenantDir: string,
  input: { bankAccountCode: string; date: string; description: string; reference?: string; amount: number },
): StatementLine {
  requireBankAccount(tenantDir, input.bankAccountCode);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new BooksError("Date must look like 2026-09-22.");
  const amount = round2(input.amount);
  if (!amount) throw new BooksError("Amount cannot be zero. Use a minus sign for money out.");

  const line: StatementLine = {
    id: randomUUID(),
    bankAccountCode: input.bankAccountCode,
    date: input.date,
    description: input.description.trim(),
    reference: (input.reference ?? "").trim(),
    amount,
    status: "unreconciled",
    importedAt: new Date().toISOString(),
  };
  saveStatementLines(tenantDir, [...loadStatementLines(tenantDir), line]);
  return line;
}

// ---------- matching ----------
function getBankMovement(entry: JournalEntry, bankAccountCode: string): number {
  return round2(
    entry.lines
      .filter((line) => line.accountCode === bankAccountCode)
      .reduce((sum, line) => sum + line.debit - line.credit, 0),
  );
}

const daysBetween = (a: string, b: string) =>
  Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000;

export interface LineSuggestion {
  entryId: string;
  number: string;
  date: string;
  narration: string;
  amount: number;
}

// A journal entry can back a statement line when it moves the same bank account by the same
// amount, around the same date, and nothing else claims it yet.
export function getSuggestions(tenantDir: string, line: StatementLine): LineSuggestion[] {
  const claimed = new Set(loadStatementLines(tenantDir).map((other) => other.journalEntryId).filter(Boolean));
  return loadJournal(tenantDir)
    .filter((entry) => entry.status === "posted" && !claimed.has(entry.id))
    .map((entry) => ({ entry, movement: getBankMovement(entry, line.bankAccountCode) }))
    .filter(({ entry, movement }) => Math.abs(movement - line.amount) <= 0.005 && daysBetween(entry.date, line.date) <= MATCH_WINDOW_DAYS)
    .map(({ entry, movement }) => ({
      entryId: entry.id,
      number: entry.number,
      date: entry.date,
      narration: entry.narration,
      amount: movement,
    }));
}

function updateLine(tenantDir: string, id: string, change: Partial<StatementLine>): StatementLine {
  const lines = loadStatementLines(tenantDir);
  const line = lines.find((item) => item.id === id);
  if (!line) throw new BooksError("Statement line not found.");
  const updated = { ...line, ...change };
  saveStatementLines(tenantDir, lines.map((item) => (item.id === id ? updated : item)));
  return updated;
}

export function matchLine(tenantDir: string, id: string, journalEntryId: string): StatementLine {
  const line = loadStatementLines(tenantDir).find((item) => item.id === id);
  if (!line) throw new BooksError("Statement line not found.");
  const entry = loadJournal(tenantDir).find((item) => item.id === journalEntryId);
  if (!entry) throw new BooksError("Journal entry not found.");

  const movement = getBankMovement(entry, line.bankAccountCode);
  if (Math.abs(movement - line.amount) > 0.005) {
    throw new BooksError(`${entry.number} moves the bank by ${movement.toFixed(2)}, not ${line.amount.toFixed(2)}.`);
  }
  return updateLine(tenantDir, id, { status: "reconciled", journalEntryId });
}

// Coding a line posts the other half of the movement and reconciles it in one go.
export function createFromLine(tenantDir: string, id: string, accountCode: string, description: string): StatementLine {
  const line = loadStatementLines(tenantDir).find((item) => item.id === id);
  if (!line) throw new BooksError("Statement line not found.");
  if (line.status === "reconciled") throw new BooksError("That line is already reconciled.");

  const isMoneyIn = line.amount > 0;
  const amount = Math.abs(line.amount);
  const narration = description.trim() || line.description || "Bank transaction";

  const entry = postEntry(tenantDir, {
    date: line.date,
    narration,
    lines: [
      { accountCode: line.bankAccountCode, description: narration, debit: isMoneyIn ? amount : 0, credit: isMoneyIn ? 0 : amount },
      { accountCode, description: narration, debit: isMoneyIn ? 0 : amount, credit: isMoneyIn ? amount : 0 },
    ],
    sourceType: "manual",
    sourceKey: `statement:${line.id}`,
    sourceLabel: line.reference || line.description,
  });

  return updateLine(tenantDir, id, { status: "reconciled", journalEntryId: entry.id });
}

export function unmatchLine(tenantDir: string, id: string): StatementLine {
  return updateLine(tenantDir, id, { status: "unreconciled", journalEntryId: undefined });
}

// ---------- summary ----------
export interface BankSummary {
  bankAccountCode: string;
  statementBalance: number;
  ledgerBalance: number;
  unreconciledCount: number;
  difference: number;
}

export function getBankSummary(tenantDir: string, bankAccountCode: string): BankSummary {
  const lines = loadStatementLines(tenantDir).filter((line) => line.bankAccountCode === bankAccountCode);
  const statementBalance = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const ledgerBalance = round2(
    loadJournal(tenantDir).reduce((sum, entry) => sum + getBankMovement(entry, bankAccountCode), 0),
  );
  return {
    bankAccountCode,
    statementBalance,
    ledgerBalance,
    unreconciledCount: lines.filter((line) => line.status === "unreconciled").length,
    difference: round2(statementBalance - ledgerBalance),
  };
}
