import { BooksError, readBooksFile, writeBooksFile } from "./books";

export interface BooksSettings {
  financialYearEndMonth: number; // 1-12
  financialYearEndDay: number;
  lockDate: string; // "" or yyyy-mm-dd; nothing may be posted on or before it
  baseCurrency: string;
}

const DEFAULTS: BooksSettings = {
  financialYearEndMonth: 12,
  financialYearEndDay: 31,
  lockDate: "",
  baseCurrency: "",
};

const SETTINGS_FILE = "settings.json";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function loadSettings(tenantDir: string): BooksSettings {
  return { ...DEFAULTS, ...(readBooksFile<Partial<BooksSettings>>(tenantDir, SETTINGS_FILE) ?? {}) };
}

export function saveSettings(tenantDir: string, input: Partial<BooksSettings>): BooksSettings {
  const current = loadSettings(tenantDir);
  const month = Number(input.financialYearEndMonth ?? current.financialYearEndMonth);
  const day = Number(input.financialYearEndDay ?? current.financialYearEndDay);
  const lockDate = (input.lockDate ?? current.lockDate).trim();

  if (!Number.isInteger(month) || month < 1 || month > 12) throw new BooksError("Financial year end month must be 1-12.");
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new BooksError("Financial year end day must be 1-31.");
  if (lockDate && !DATE_PATTERN.test(lockDate)) throw new BooksError("Lock date must look like 2026-09-30.");

  const settings: BooksSettings = {
    financialYearEndMonth: month,
    financialYearEndDay: day,
    lockDate,
    baseCurrency: (input.baseCurrency ?? current.baseCurrency).trim(),
  };
  writeBooksFile(tenantDir, SETTINGS_FILE, settings);
  return settings;
}

export function assertNotLocked(tenantDir: string, date: string) {
  const { lockDate } = loadSettings(tenantDir);
  if (lockDate && date <= lockDate) {
    throw new BooksError(`The books are locked up to ${lockDate}. Nothing can be posted on or before that date.`);
  }
}

// The financial year containing `date`, derived from the year-end day the user set.
export function getFinancialYear(settings: BooksSettings, date: string): { start: string; end: string } {
  const year = Number(date.slice(0, 4));
  const endFor = (y: number) =>
    `${y}-${String(settings.financialYearEndMonth).padStart(2, "0")}-${String(settings.financialYearEndDay).padStart(2, "0")}`;

  const end = date <= endFor(year) ? endFor(year) : endFor(year + 1);
  const previousEnd = new Date(`${end}T00:00:00Z`);
  previousEnd.setUTCFullYear(previousEnd.getUTCFullYear() - 1);
  previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);

  return { start: previousEnd.toISOString().slice(0, 10), end };
}
