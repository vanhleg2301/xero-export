import { BooksError, loadAccounts, type Account } from "./books";
import { loadDataset } from "./dataStore";
import { loadJournal, type JournalEntry, type TrialBalance } from "./ledger";
import { getFinancialYear, loadSettings } from "./settings";

export interface ReportLine {
  code: string;
  name: string;
  amount: number;
}

export interface ReportSection {
  title: string;
  lines: ReportLine[];
  total: number;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  revenue: ReportSection;
  expenses: ReportSection;
  netProfit: number;
}

export interface BalanceSheet {
  asOf: string;
  assets: ReportSection;
  liabilities: ReportSection;
  equity: ReportSection;
  totalLiabilitiesAndEquity: number;
  isBalanced: boolean;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

interface Movement {
  debit: number;
  credit: number;
}

function sumMovements(entries: JournalEntry[], from: string, to: string): Map<string, Movement> {
  const totals = new Map<string, Movement>();
  for (const entry of entries) {
    if (entry.date < from || entry.date > to) continue;
    for (const line of entry.lines) {
      const running = totals.get(line.accountCode) ?? { debit: 0, credit: 0 };
      running.debit += line.debit;
      running.credit += line.credit;
      totals.set(line.accountCode, running);
    }
  }
  return totals;
}

// Debit-natured accounts (asset, expense) report debit minus credit; the others the reverse.
function buildSection(
  title: string,
  accounts: Map<string, Account>,
  movements: Map<string, Movement>,
  accountClass: Account["accountClass"],
): ReportSection {
  const isDebitNatured = accountClass === "asset" || accountClass === "expense";
  const lines: ReportLine[] = [];

  for (const [code, movement] of movements) {
    const account = accounts.get(code);
    if (!account || account.accountClass !== accountClass) continue;
    const amount = round2(isDebitNatured ? movement.debit - movement.credit : movement.credit - movement.debit);
    if (amount !== 0) lines.push({ code, name: account.name, amount });
  }

  lines.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { title, lines, total: round2(lines.reduce((sum, line) => sum + line.amount, 0)) };
}

function getNetProfit(entries: JournalEntry[], accounts: Map<string, Account>, from: string, to: string): number {
  const movements = sumMovements(entries, from, to);
  const revenue = buildSection("Revenue", accounts, movements, "revenue").total;
  const expenses = buildSection("Expenses", accounts, movements, "expense").total;
  return round2(revenue - expenses);
}

export function getProfitAndLoss(tenantDir: string, from: string, to: string): ProfitAndLoss {
  const accounts = new Map(loadAccounts(tenantDir).map((account) => [account.code, account]));
  const movements = sumMovements(loadJournal(tenantDir), from, to);
  const revenue = buildSection("Revenue", accounts, movements, "revenue");
  const expenses = buildSection("Expenses", accounts, movements, "expense");
  return { from, to, revenue, expenses, netProfit: round2(revenue.total - expenses.total) };
}

export function getBalanceSheet(tenantDir: string, asOf: string): BalanceSheet {
  const accounts = new Map(loadAccounts(tenantDir).map((account) => [account.code, account]));
  const entries = loadJournal(tenantDir);
  const settings = loadSettings(tenantDir);
  const financialYear = getFinancialYear(settings, asOf);

  const movements = sumMovements(entries, "0000-01-01", asOf);
  const assets = buildSection("Assets", accounts, movements, "asset");
  const liabilities = buildSection("Liabilities", accounts, movements, "liability");
  const equity = buildSection("Equity", accounts, movements, "equity");

  // Profit is not stored on an account: prior years roll into retained earnings, this year sits on its own line.
  const retained = getNetProfit(entries, accounts, "0000-01-01", previousDay(financialYear.start));
  const currentYear = getNetProfit(entries, accounts, financialYear.start, asOf);
  if (retained !== 0) equity.lines.push({ code: "", name: "Retained earnings (prior years)", amount: retained });
  if (currentYear !== 0) equity.lines.push({ code: "", name: `Current year earnings (from ${financialYear.start})`, amount: currentYear });
  equity.total = round2(equity.lines.reduce((sum, line) => sum + line.amount, 0));

  const totalLiabilitiesAndEquity = round2(liabilities.total + equity.total);
  return {
    asOf,
    assets,
    liabilities,
    equity,
    totalLiabilitiesAndEquity,
    isBalanced: Math.abs(assets.total - totalLiabilitiesAndEquity) <= 0.005,
  };
}

function previousDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

// ---------- account transactions ----------
export interface AccountTransactionRow {
  entryId: string;
  date: string;
  number: string;
  narration: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  status: JournalEntry["status"];
}

export interface AccountTransactions {
  code: string;
  name: string;
  accountClass: string;
  from: string;
  to: string;
  opening: number;
  rows: AccountTransactionRow[];
  totalDebit: number;
  totalCredit: number;
  closing: number;
}

const isDebitNatured = (accountClass: string) => accountClass === "asset" || accountClass === "expense";

export function getAccountTransactions(tenantDir: string, code: string, from: string, to: string): AccountTransactions {
  const account = loadAccounts(tenantDir).find((a) => a.code.toLowerCase() === code.toLowerCase());
  if (!account) throw new BooksError(`No account with code ${code} in the chart of accounts.`);

  const entries = loadJournal(tenantDir);
  const sign = isDebitNatured(account.accountClass) ? 1 : -1;
  const movementOf = (entry: JournalEntry) =>
    entry.lines
      .filter((line) => line.accountCode === account.code)
      .reduce((sum, line) => sum + sign * (line.debit - line.credit), 0);

  const opening = round2(entries.filter((entry) => entry.date < from).reduce((sum, entry) => sum + movementOf(entry), 0));

  let balance = opening;
  const rows: AccountTransactionRow[] = [];
  for (const entry of entries.filter((e) => e.date >= from && e.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))) {
    for (const line of entry.lines) {
      if (line.accountCode !== account.code) continue;
      balance = round2(balance + sign * (line.debit - line.credit));
      rows.push({
        entryId: entry.id,
        date: entry.date,
        number: entry.number,
        narration: entry.narration,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
        balance,
        status: entry.status,
      });
    }
  }

  return {
    code: account.code,
    name: account.name,
    accountClass: account.accountClass,
    from,
    to,
    opening,
    rows,
    totalDebit: round2(rows.reduce((sum, row) => sum + row.debit, 0)),
    totalCredit: round2(rows.reduce((sum, row) => sum + row.credit, 0)),
    closing: balance,
  };
}

// ---------- aged receivables / payables ----------
export type AgedKind = "receivables" | "payables";

export interface AgedRow {
  contact: string;
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  older: number;
  total: number;
}

export interface AgedReport {
  kind: AgedKind;
  asOf: string;
  rows: AgedRow[];
  totals: AgedRow;
  invoiceCount: number;
}

const BUCKETS = ["current", "days1to30", "days31to60", "days61to90", "older"] as const;

function getBucket(dueDate: string, asOf: string): (typeof BUCKETS)[number] {
  if (!dueDate || dueDate >= asOf) return "current";
  const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000);
  if (days <= 30) return "days1to30";
  if (days <= 60) return "days31to60";
  if (days <= 90) return "days61to90";
  return "older";
}

const emptyAgedRow = (contact: string): AgedRow => ({ contact, current: 0, days1to30: 0, days31to60: 0, days61to90: 0, older: 0, total: 0 });

// Outstanding amounts come from Xero's own AmountDue, so allocations across payments and
// credit notes are already applied; only invoices dated on or before asOf are included.
export function getAgedBalances(tenantDir: string, kind: AgedKind, asOf: string): AgedReport {
  const wantedType = kind === "receivables" ? "ACCREC" : "ACCPAY";
  const byContact = new Map<string, AgedRow>();
  let invoiceCount = 0;

  for (const invoice of loadDataset(tenantDir, "Invoices")) {
    if (String(invoice.Type ?? "") !== wantedType) continue;
    if (String(invoice.Status ?? "") !== "AUTHORISED") continue;
    const due = round2(Number(invoice.AmountDue) || 0);
    if (due <= 0) continue;
    const date = String(invoice.DateString ?? "").slice(0, 10);
    if (date && date > asOf) continue;

    const contact = String((invoice.Contact as Record<string, unknown> | undefined)?.Name ?? "(no contact)");
    const row = byContact.get(contact) ?? emptyAgedRow(contact);
    row[getBucket(String(invoice.DueDateString ?? "").slice(0, 10), asOf)] += due;
    row.total = round2(row.total + due);
    byContact.set(contact, row);
    invoiceCount++;
  }

  const rows = [...byContact.values()]
    .map((row) => ({ ...row, ...Object.fromEntries(BUCKETS.map((bucket) => [bucket, round2(row[bucket])])) }) as AgedRow)
    .sort((a, b) => b.total - a.total);

  const totals = rows.reduce((sum, row) => {
    for (const bucket of BUCKETS) sum[bucket] = round2(sum[bucket] + row[bucket]);
    sum.total = round2(sum.total + row.total);
    return sum;
  }, emptyAgedRow("Total"));

  return { kind, asOf, rows, totals, invoiceCount };
}

// ---------- reports as CSV ----------
const money = (value: number) => (value === 0 ? "" : value.toFixed(2));

function sectionToRows(section: ReportSection): string[][] {
  return [
    [section.title, ""],
    ...section.lines.map((line) => [line.code ? `${line.code} ${line.name}` : line.name, money(line.amount)]),
    [`Total ${section.title}`, section.total.toFixed(2)],
    ["", ""],
  ];
}

export function profitAndLossToMatrix(report: ProfitAndLoss): string[][] {
  return [
    ["Profit and Loss", ""],
    [`${report.from} to ${report.to}`, ""],
    ["", ""],
    ...sectionToRows(report.revenue),
    ...sectionToRows(report.expenses),
    [`Net ${report.netProfit >= 0 ? "profit" : "loss"}`, report.netProfit.toFixed(2)],
  ];
}

export function balanceSheetToMatrix(report: BalanceSheet): string[][] {
  return [
    ["Balance Sheet", ""],
    [`As at ${report.asOf}`, ""],
    ["", ""],
    ...sectionToRows(report.assets),
    ...sectionToRows(report.liabilities),
    ...sectionToRows(report.equity),
    ["Total liabilities and equity", report.totalLiabilitiesAndEquity.toFixed(2)],
  ];
}

export function trialBalanceToMatrix(report: TrialBalance): string[][] {
  return [
    ["Code", "Account", "Class", "Debit", "Credit"],
    ...report.rows.map((row) => [row.code, row.name, row.accountClass, money(row.debit), money(row.credit)]),
    ["", "Total", "", report.totalDebit.toFixed(2), report.totalCredit.toFixed(2)],
  ];
}

export function accountTransactionsToMatrix(report: AccountTransactions): string[][] {
  return [
    [`${report.code} ${report.name}`, "", "", "", "", ""],
    [`${report.from} to ${report.to}`, "", "", "", "", ""],
    ["Date", "Entry", "Narration", "Description", "Debit", "Credit", "Balance"],
    ["", "", "Opening balance", "", "", "", report.opening.toFixed(2)],
    ...report.rows.map((row) => [
      row.date,
      row.number,
      row.status === "voided" ? `${row.narration} (voided)` : row.narration,
      row.description,
      money(row.debit),
      money(row.credit),
      row.balance.toFixed(2),
    ]),
    ["", "", "Closing balance", "", report.totalDebit.toFixed(2), report.totalCredit.toFixed(2), report.closing.toFixed(2)],
  ];
}

export function agedToMatrix(report: AgedReport): string[][] {
  const header = ["Contact", "Current", "1-30 days", "31-60 days", "61-90 days", "Older", "Total"];
  const toRow = (row: AgedRow) => [row.contact, ...BUCKETS.map((bucket) => row[bucket].toFixed(2)), row.total.toFixed(2)];
  return [
    [`Aged ${report.kind === "receivables" ? "Receivables" : "Payables"} as at ${report.asOf}`, "", "", "", "", "", ""],
    ["", "", "", "", "", "", ""],
    header,
    ...report.rows.map(toRow),
    toRow(report.totals),
  ];
}

export function journalToMatrix(entries: JournalEntry[]): string[][] {
  return [
    ["Entry", "Date", "Status", "Narration", "Source", "Account code", "Account", "Description", "Debit", "Credit"],
    ...entries.flatMap((entry) =>
      entry.lines.map((line) => [
        entry.number,
        entry.date,
        entry.status,
        entry.narration,
        entry.sourceLabel || entry.sourceType,
        line.accountCode,
        line.accountName,
        line.description,
        money(line.debit),
        money(line.credit),
      ]),
    ),
  ];
}
