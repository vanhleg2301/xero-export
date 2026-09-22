import { loadAccounts, type Account } from "./books";
import { loadJournal, type JournalEntry } from "./ledger";
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
