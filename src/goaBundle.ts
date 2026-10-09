// Builds the file GOA Smart CorpSec imports to move one organisation off Xero.
//
// GOA takes over at a conversion date. Rather than replaying history (Xero
// will not hand out its journals without the Advanced plan), it takes:
//   - the chart of accounts and contacts,
//   - the trial balance as at the conversion date, which becomes one opening
//     balance journal,
//   - the sales invoices and bills still owing on that date, so later receipts
//     and payments can be matched to them.
// Everything here is pure: the caller reads the JSON files and fetches the
// trial balance; this turns them into the bundle.

type XeroRecord = Record<string, unknown>;

export interface BundleAccount {
  xeroId: string;
  code: string | null;
  name: string;
  type: string;
  /** ASSET, LIABILITY, EQUITY, REVENUE or EXPENSE: the fallback when GOA does not know the type. */
  accountClass: string | null;
  taxType: string | null;
  systemAccount: string | null;
  status: string;
  description: string | null;
}

export interface BundleContact {
  xeroId: string;
  name: string;
  email: string | null;
  isCustomer: boolean;
  isSupplier: boolean;
}

export interface TrialBalanceLine {
  accountXeroId: string | null;
  code: string | null;
  name: string;
  debit: number;
  credit: number;
}

export interface OpenDocument {
  xeroId: string;
  number: string;
  reference: string | null;
  contactXeroId: string | null;
  contactName: string;
  date: string;
  dueDate: string | null;
  total: number;
  outstanding: number;
  currency: string;
}

export interface GoaBundle {
  format: "goa-xero-bundle";
  version: 1;
  exportedAt: string;
  conversionDate: string;
  organisation: {
    name: string;
    legalName: string | null;
    baseCurrency: string;
    financialYearEndDay: number | null;
    financialYearEndMonth: number | null;
  };
  accounts: BundleAccount[];
  contacts: BundleContact[];
  trialBalance: TrialBalanceLine[];
  openInvoices: OpenDocument[];
  openBills: OpenDocument[];
  warnings: string[];
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const arr = (v: unknown): XeroRecord[] => (Array.isArray(v) ? (v as XeroRecord[]) : []);
const obj = (v: unknown): XeroRecord => (v && typeof v === "object" && !Array.isArray(v) ? (v as XeroRecord) : {});
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Xero dates come as "/Date(1767225600000+0000)/" or "2026-01-01T00:00:00". */
export function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const ms = /^\/Date\((-?\d+)/.exec(value);
  const iso = ms ? new Date(Number(ms[1])).toISOString() : value;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** "1,234.56" or "" from a report cell. */
export function toAmount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return 0;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function mapAccounts(accounts: XeroRecord[]): BundleAccount[] {
  return accounts
    .filter((a) => str(a.Status) !== "DELETED")
    .map((a) => ({
      xeroId: String(a.AccountID),
      code: str(a.Code),
      name: String(a.Name ?? ""),
      type: String(a.Type ?? ""),
      accountClass: str(a.Class),
      taxType: str(a.TaxType),
      systemAccount: str(a.SystemAccount),
      status: String(a.Status ?? "ACTIVE"),
      description: str(a.Description),
    }));
}

export function mapContacts(contacts: XeroRecord[]): BundleContact[] {
  return contacts
    .filter((c) => str(c.ContactStatus) !== "ARCHIVED" || c.IsCustomer === true || c.IsSupplier === true)
    .map((c) => ({
      xeroId: String(c.ContactID),
      name: String(c.Name ?? "").trim(),
      email: str(c.EmailAddress),
      isCustomer: c.IsCustomer === true,
      isSupplier: c.IsSupplier === true,
    }))
    .filter((c) => c.name);
}

/**
 * The trial balance report as one line per account.
 *
 * Xero's report has Debit / Credit and YTD Debit / YTD Credit columns. The pair
 * that balances is taken; if neither does, the Debit/Credit pair is used and a
 * warning says so, because GOA must not import a ledger that does not balance.
 */
export function parseTrialBalance(report: XeroRecord, warnings: string[]): TrialBalanceLine[] {
  const rows = arr(report.Rows);
  const header = rows.find((r) => r.RowType === "Header");
  const headers = arr(header?.Cells).map((c) => String(c.Value ?? "").toLowerCase());
  const col = (name: string) => headers.indexOf(name);
  const pairs: [number, number][] = [[col("debit"), col("credit")], [col("ytd debit"), col("ytd credit")]];

  const raw: { accountXeroId: string | null; label: string; cells: XeroRecord[] }[] = [];
  for (const section of rows.filter((r) => r.RowType === "Section")) {
    for (const row of arr(section.Rows)) {
      if (row.RowType !== "Row") continue;
      const cells = arr(row.Cells);
      const first = cells[0] ?? {};
      const accountAttr = arr(first.Attributes).find((a) => a.Id === "account");
      raw.push({ accountXeroId: str(accountAttr?.Value), label: String(first.Value ?? ""), cells });
    }
  }

  const build = ([d, c]: [number, number]) =>
    raw.map((r) => ({ r, debit: d >= 0 ? toAmount(r.cells[d]?.Value) : 0, credit: c >= 0 ? toAmount(r.cells[c]?.Value) : 0 }));
  // An empty column pair "balances" at zero; it only counts if it holds amounts.
  const balances = (lines: { debit: number; credit: number }[]) =>
    lines.some((l) => l.debit !== 0 || l.credit !== 0)
    && Math.abs(lines.reduce((s, l) => s + l.debit - l.credit, 0)) < 0.01;

  let chosen = build(pairs[0]);
  if (!balances(chosen)) {
    const ytd = pairs[1][0] >= 0 ? build(pairs[1]) : null;
    if (ytd && balances(ytd)) chosen = ytd;
    else warnings.push("The Xero trial balance does not balance in either column pair; check it in Xero before importing.");
  }

  return chosen
    .map(({ r, debit, credit }) => {
      // "Accounts Receivable (610)" -> name and code.
      const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(r.label);
      const net = round2(debit - credit);
      return {
        accountXeroId: r.accountXeroId,
        code: m ? m[2] : null,
        name: m ? m[1] : r.label,
        debit: net > 0 ? net : 0,
        credit: net < 0 ? -net : 0,
      };
    })
    .filter((l) => l.debit !== 0 || l.credit !== 0);
}

/**
 * What was still owed on a document at the conversion date: its total less
 * every payment, credit note and prepayment/overpayment dated on or before it.
 * Xero does not expose the date a credit note was allocated, so the credit
 * note's own date stands in for it.
 */
export function outstandingAt(doc: XeroRecord, conversionDate: string): number {
  const docDate = toIsoDate(doc.DateString ?? doc.Date);
  if (!docDate || docDate > conversionDate) return 0;
  const status = String(doc.Status ?? "");
  if (!["AUTHORISED", "PAID"].includes(status)) return 0;

  let settled = 0;
  for (const p of arr(doc.Payments)) {
    const d = toIsoDate(p.Date);
    if (d && d <= conversionDate) settled += toAmount(p.Amount);
  }
  for (const cn of arr(doc.CreditNotes)) {
    const d = toIsoDate(cn.DateString ?? cn.Date) ?? docDate;
    if (d <= conversionDate) settled += toAmount(cn.AppliedAmount ?? cn.Total);
  }
  for (const key of ["Prepayments", "Overpayments"]) {
    for (const pp of arr(doc[key])) {
      const d = toIsoDate(pp.DateString ?? pp.Date) ?? docDate;
      if (d <= conversionDate) settled += toAmount(pp.AppliedAmount ?? pp.Total);
    }
  }
  return round2(toAmount(doc.Total) - settled);
}

export function openDocuments(invoices: XeroRecord[], type: "ACCREC" | "ACCPAY", conversionDate: string, baseCurrency: string, warnings: string[]): OpenDocument[] {
  const out: OpenDocument[] = [];
  for (const doc of invoices) {
    if (doc.Type !== type) continue;
    const outstanding = outstandingAt(doc, conversionDate);
    if (outstanding <= 0.005) continue;
    const contact = obj(doc.Contact);
    const currency = String(doc.CurrencyCode ?? baseCurrency);
    if (currency !== baseCurrency) {
      warnings.push(`${doc.InvoiceNumber ?? doc.InvoiceID} is in ${currency}; it is imported at its ${currency} amount, not converted.`);
    }
    out.push({
      xeroId: String(doc.InvoiceID),
      number: String(doc.InvoiceNumber ?? "") || String(doc.InvoiceID).slice(0, 8),
      reference: str(doc.Reference),
      contactXeroId: str(contact.ContactID),
      contactName: String(contact.Name ?? ""),
      date: toIsoDate(doc.DateString ?? doc.Date) ?? conversionDate,
      dueDate: toIsoDate(doc.DueDateString ?? doc.DueDate),
      total: round2(toAmount(doc.Total)),
      outstanding,
      currency,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function buildGoaBundle(input: {
  conversionDate: string;
  organisation: XeroRecord;
  accounts: XeroRecord[];
  contacts: XeroRecord[];
  invoices: XeroRecord[];
  trialBalanceReport: XeroRecord;
  now?: Date;
}): GoaBundle {
  const warnings: string[] = [];
  const org = input.organisation;
  const baseCurrency = String(org.BaseCurrency ?? "SGD");
  const accounts = mapAccounts(input.accounts);
  const trialBalance = parseTrialBalance(input.trialBalanceReport, warnings);
  const openInvoices = openDocuments(input.invoices, "ACCREC", input.conversionDate, baseCurrency, warnings);
  const openBills = openDocuments(input.invoices, "ACCPAY", input.conversionDate, baseCurrency, warnings);

  // The documents must add up to the receivable and payable on the trial balance,
  // or the import would leave GOA's sub-ledger out of step with its ledger.
  const balanceOf = (systemAccount: string) => {
    const acc = accounts.find((a) => a.systemAccount === systemAccount);
    const line = acc ? trialBalance.find((l) => l.accountXeroId === acc.xeroId) : undefined;
    return line ? round2(line.debit - line.credit) : 0;
  };
  const ar = balanceOf("DEBTORS");
  const ap = -balanceOf("CREDITORS");
  const sumAr = round2(openInvoices.reduce((s, d) => s + d.outstanding, 0));
  const sumAp = round2(openBills.reduce((s, d) => s + d.outstanding, 0));
  if (Math.abs(ar - sumAr) > 0.01) warnings.push(`Open invoices total ${sumAr.toFixed(2)} but Accounts Receivable is ${ar.toFixed(2)} on the trial balance.`);
  if (Math.abs(ap - sumAp) > 0.01) warnings.push(`Open bills total ${sumAp.toFixed(2)} but Accounts Payable is ${ap.toFixed(2)} on the trial balance.`);

  return {
    format: "goa-xero-bundle",
    version: 1,
    exportedAt: (input.now ?? new Date()).toISOString(),
    conversionDate: input.conversionDate,
    organisation: {
      name: String(org.Name ?? ""),
      legalName: str(org.LegalName),
      baseCurrency,
      financialYearEndDay: org.FinancialYearEndDay == null ? null : Number(org.FinancialYearEndDay),
      financialYearEndMonth: org.FinancialYearEndMonth == null ? null : Number(org.FinancialYearEndMonth),
    },
    accounts,
    contacts: mapContacts(input.contacts),
    trialBalance,
    openInvoices,
    openBills,
    warnings,
  };
}
