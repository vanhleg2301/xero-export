// Builds import.json, the file inside "Download all data" that GOA Smart
// CorpSec imports to take one organisation over from Xero.
//
// GOA takes over at a conversion date. Rather than replaying history (Xero
// will not hand out its journals without the Advanced plan), it takes:
//   - the chart of accounts and contacts,
//   - the trial balance as at the conversion date, which becomes one opening
//     balance journal,
//   - every sales invoice, bill and credit note up to that date, with its
//     lines and attachments. They never post (the trial balance already holds
//     them); the ones still owing keep that balance so later receipts and
//     payments can be matched to them, the rest are kept as history.
// Everything here is pure: the caller reads the JSON files and fetches the
// trial balance; this turns them into the bundle.

type XeroRecord = Record<string, unknown>;

export interface BundleAccount {
  sourceId: string;
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
  sourceId: string;
  name: string;
  email: string | null;
  isCustomer: boolean;
  isSupplier: boolean;
}

export interface TrialBalanceLine {
  accountSourceId: string | null;
  code: string | null;
  name: string;
  debit: number;
  credit: number;
}

export interface DocumentLine {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Net of tax. */
  amount: number;
  taxAmount: number;
  accountCode: string | null;
  taxType: string | null;
}

export interface BundleDocument {
  kind: "invoice" | "bill" | "credit_note";
  sourceId: string;
  number: string;
  reference: string | null;
  contactSourceId: string | null;
  contactName: string;
  date: string;
  dueDate: string | null;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  /** Still owing (or, for a credit note, still to allocate) at the conversion date. */
  outstanding: number;
  /** The day it was settled in full, when that was on or before the conversion date. */
  paidDate: string | null;
  lines: DocumentLine[];
  /** Paths of its files inside the export. */
  attachments: string[];
}

export interface ImportBundle {
  format: "books-import";
  version: 2;
  source: "xero";
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
  documents: BundleDocument[];
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
      sourceId: String(a.AccountID),
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
      sourceId: String(c.ContactID),
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

  const raw: { accountSourceId: string | null; label: string; cells: XeroRecord[] }[] = [];
  for (const section of rows.filter((r) => r.RowType === "Section")) {
    for (const row of arr(section.Rows)) {
      if (row.RowType !== "Row") continue;
      const cells = arr(row.Cells);
      const first = cells[0] ?? {};
      const accountAttr = arr(first.Attributes).find((a) => a.Id === "account");
      raw.push({ accountSourceId: str(accountAttr?.Value), label: String(first.Value ?? ""), cells });
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
        accountSourceId: r.accountSourceId,
        code: m ? m[2] : null,
        name: m ? m[1] : r.label,
        debit: net > 0 ? net : 0,
        credit: net < 0 ? -net : 0,
      };
    })
    .filter((l) => l.debit !== 0 || l.credit !== 0);
}

const IN_BOOKS = ["AUTHORISED", "PAID"];

/**
 * What was still owed on an invoice or bill at the conversion date: its total
 * less every payment, credit note and prepayment/overpayment dated on or
 * before it. Xero does not expose the date a credit note was allocated, so the
 * credit note's own date stands in for it.
 */
export function outstandingAt(doc: XeroRecord, conversionDate: string): number {
  const docDate = toIsoDate(doc.DateString ?? doc.Date);
  if (!docDate || docDate > conversionDate) return 0;
  if (!IN_BOOKS.includes(String(doc.Status ?? ""))) return 0;

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

/** A credit note's credit still unallocated and unrefunded at the conversion date. */
export function creditRemainingAt(cn: XeroRecord, conversionDate: string): number {
  const cnDate = toIsoDate(cn.DateString ?? cn.Date);
  if (!cnDate || cnDate > conversionDate) return 0;
  if (!IN_BOOKS.includes(String(cn.Status ?? ""))) return 0;
  let used = 0;
  for (const a of arr(cn.Allocations)) {
    const d = toIsoDate(a.DateString ?? a.Date) ?? cnDate;
    if (d <= conversionDate) used += toAmount(a.Amount);
  }
  for (const p of arr(cn.Payments)) {
    const d = toIsoDate(p.Date);
    if (d && d <= conversionDate) used += toAmount(p.Amount);
  }
  return round2(toAmount(cn.Total) - used);
}

function mapLines(doc: XeroRecord): DocumentLine[] {
  const inclusive = String(doc.LineAmountTypes ?? "") === "Inclusive";
  return arr(doc.LineItems).map((l) => {
    const quantity = toAmount(l.Quantity) || 1;
    const taxAmount = round2(toAmount(l.TaxAmount));
    const lineAmount = toAmount(l.LineAmount);
    const amount = round2(inclusive ? lineAmount - taxAmount : lineAmount);
    return {
      description: String(l.Description ?? "").trim() || String(l.ItemCode ?? "") || "—",
      quantity,
      unitPrice: round2(amount / quantity),
      amount,
      taxAmount,
      accountCode: str(l.AccountCode),
      taxType: str(l.TaxType),
    };
  });
}

function mapDocument(
  doc: XeroRecord,
  kind: BundleDocument["kind"],
  idField: string,
  numberField: string,
  outstanding: number,
  conversionDate: string,
  baseCurrency: string,
  attachmentPathsById: Map<string, string[]>,
  warnings: string[],
): BundleDocument {
  const id = String(doc[idField]);
  const contact = obj(doc.Contact);
  const currency = String(doc.CurrencyCode ?? baseCurrency);
  const number = String(doc[numberField] ?? "") || id.slice(0, 8);
  if (currency !== baseCurrency) {
    warnings.push(`${number} is in ${currency}; it is imported at its ${currency} amount, not converted.`);
  }
  const paid = toIsoDate(doc.FullyPaidOnDate);
  return {
    kind,
    sourceId: id,
    number,
    reference: str(doc.Reference),
    contactSourceId: str(contact.ContactID),
    contactName: String(contact.Name ?? ""),
    date: toIsoDate(doc.DateString ?? doc.Date) ?? conversionDate,
    dueDate: toIsoDate(doc.DueDateString ?? doc.DueDate),
    currency,
    subtotal: round2(toAmount(doc.SubTotal)),
    tax: round2(toAmount(doc.TotalTax)),
    total: round2(toAmount(doc.Total)),
    outstanding: Math.max(0, outstanding),
    paidDate: outstanding <= 0.005 && paid && paid <= conversionDate ? paid : null,
    lines: mapLines(doc),
    attachments: attachmentPathsById.get(id) ?? [],
  };
}

export function buildDocuments(input: {
  invoices: XeroRecord[];
  creditNotes: XeroRecord[];
  conversionDate: string;
  baseCurrency: string;
  attachmentPathsById: Map<string, string[]>;
  warnings: string[];
}): BundleDocument[] {
  const { conversionDate, baseCurrency, attachmentPathsById, warnings } = input;
  const out: BundleDocument[] = [];
  let later = 0;
  let supplierCredit = 0;

  const inScope = (doc: XeroRecord) => {
    if (!IN_BOOKS.includes(String(doc.Status ?? ""))) return false;
    const date = toIsoDate(doc.DateString ?? doc.Date);
    if (!date || date > conversionDate) {
      later++;
      return false;
    }
    return true;
  };

  for (const doc of input.invoices) {
    if (doc.Type !== "ACCREC" && doc.Type !== "ACCPAY") continue;
    if (!inScope(doc)) continue;
    out.push(mapDocument(doc, doc.Type === "ACCREC" ? "invoice" : "bill", "InvoiceID", "InvoiceNumber",
      outstandingAt(doc, conversionDate), conversionDate, baseCurrency, attachmentPathsById, warnings));
  }
  for (const cn of input.creditNotes) {
    if (!inScope(cn)) continue;
    const remaining = creditRemainingAt(cn, conversionDate);
    if (cn.Type === "ACCPAYCREDIT") {
      if (remaining > 0.005) supplierCredit += remaining;
      continue;
    }
    if (cn.Type !== "ACCRECCREDIT") continue;
    out.push(mapDocument(cn, "credit_note", "CreditNoteID", "CreditNoteNumber",
      remaining, conversionDate, baseCurrency, attachmentPathsById, warnings));
  }

  if (later > 0) {
    warnings.push(`${later} document(s) dated after the conversion date are left out: they are not in the opening balances, so enter them in GOA.`);
  }
  if (supplierCredit > 0) {
    warnings.push(`Supplier credit notes with ${supplierCredit.toFixed(2)} unallocated are not imported; Accounts Payable will differ from open bills by that amount.`);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function buildImportBundle(input: {
  conversionDate: string;
  organisation: XeroRecord;
  accounts: XeroRecord[];
  contacts: XeroRecord[];
  invoices: XeroRecord[];
  creditNotes: XeroRecord[];
  trialBalanceReport: XeroRecord;
  attachmentPathsById?: Map<string, string[]>;
  now?: Date;
}): ImportBundle {
  const warnings: string[] = [];
  const org = input.organisation;
  const baseCurrency = String(org.BaseCurrency ?? "SGD");
  const accounts = mapAccounts(input.accounts);
  const trialBalance = parseTrialBalance(input.trialBalanceReport, warnings);
  const documents = buildDocuments({
    invoices: input.invoices,
    creditNotes: input.creditNotes,
    conversionDate: input.conversionDate,
    baseCurrency,
    attachmentPathsById: input.attachmentPathsById ?? new Map(),
    warnings,
  });

  // What is still owing must add up to the receivable and payable on the trial
  // balance, or the import would leave GOA's sub-ledger out of step with its ledger.
  const balanceOf = (systemAccount: string) => {
    const acc = accounts.find((a) => a.systemAccount === systemAccount);
    const line = acc ? trialBalance.find((l) => l.accountSourceId === acc.sourceId) : undefined;
    return line ? round2(line.debit - line.credit) : 0;
  };
  const owing = (kind: BundleDocument["kind"]) =>
    round2(documents.filter((d) => d.kind === kind).reduce((s, d) => s + d.outstanding, 0));
  const ar = balanceOf("DEBTORS");
  const ap = -balanceOf("CREDITORS");
  const openAr = round2(owing("invoice") - owing("credit_note"));
  const openAp = owing("bill");
  if (Math.abs(ar - openAr) > 0.01) warnings.push(`Open invoices less unallocated credit notes total ${openAr.toFixed(2)} but Accounts Receivable is ${ar.toFixed(2)} on the trial balance.`);
  if (Math.abs(ap - openAp) > 0.01) warnings.push(`Open bills total ${openAp.toFixed(2)} but Accounts Payable is ${ap.toFixed(2)} on the trial balance.`);

  return {
    format: "books-import",
    version: 2,
    source: "xero",
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
    documents,
    warnings,
  };
}
