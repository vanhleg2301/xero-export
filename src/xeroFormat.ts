import { buildTables, rowsToMatrix, type XeroRecord } from "./csvTables";
import type { ViewSpec } from "./views";

export type Matrix = string[][];

export interface Lookups {
  taxRateNames: Map<string, string>;
  contactsById: Map<string, XeroRecord>;
  accountsById: Map<string, XeroRecord>;
}

export interface CsvFile {
  name: string;
  matrix: Matrix;
}

export interface AttachedRecord {
  view: ViewSpec;
  record: XeroRecord;
  paths: string[];
}

type AttachmentPathsOf = (record: XeroRecord) => string[];
type LineGetter = (record: XeroRecord, line: XeroRecord) => string;
type Column = [header: string, get: LineGetter];
type Formatter = (view: ViewSpec, records: XeroRecord[], lookups: Lookups, pathsOf: AttachmentPathsOf) => Matrix;

const col = (header: string, get: LineGetter): Column => [header, get];

const asString = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const asObject = (value: unknown): XeroRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as XeroRecord) : {};
const asArray = (value: unknown): XeroRecord[] => (Array.isArray(value) ? (value as XeroRecord[]) : []);
const toYesNo = (value: unknown) => (value === true ? "Yes" : value === false ? "No" : "");
const toAmount = (value: unknown) => (typeof value === "number" ? value.toFixed(2) : "");

export function formatXeroDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const msMatch = /^\/Date\((-?\d+)/.exec(value);
  const iso = msMatch ? new Date(Number(msMatch[1])).toISOString() : value;
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return parts ? `${parts[3]}/${parts[2]}/${parts[1]}` : "";
}

// ---------- labels as shown in the Xero UI ----------
const INVOICE_STATUS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Awaiting Approval",
  AUTHORISED: "Awaiting Payment",
  PAID: "Paid",
  VOIDED: "Voided",
  DELETED: "Deleted",
};

const TYPE_LABELS: Record<string, string> = {
  ACCREC: "Sales invoice",
  ACCPAY: "Bill",
  ACCRECCREDIT: "Sales credit note",
  ACCPAYCREDIT: "Bill credit note",
  SPEND: "Spend Money",
  RECEIVE: "Receive Money",
  "SPEND-TRANSFER": "Bank Transfer (Spend)",
  "RECEIVE-TRANSFER": "Bank Transfer (Receive)",
  "SPEND-PREPAYMENT": "Prepayment (Spend)",
  "RECEIVE-PREPAYMENT": "Prepayment (Receive)",
  "SPEND-OVERPAYMENT": "Overpayment (Spend)",
  "RECEIVE-OVERPAYMENT": "Overpayment (Receive)",
  ACCRECPAYMENT: "Receivable payment",
  ACCPAYPAYMENT: "Payable payment",
  ARCREDITPAYMENT: "Receivable credit refund",
  APCREDITPAYMENT: "Payable credit refund",
  AROVERPAYMENTPAYMENT: "Receivable overpayment refund",
  APOVERPAYMENTPAYMENT: "Payable overpayment refund",
  ARPREPAYMENTPAYMENT: "Receivable prepayment refund",
  APPREPAYMENTPAYMENT: "Payable prepayment refund",
};

const ACCOUNT_TYPES: Record<string, string> = {
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

const toTitleCase = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");

function getStatusLabel(viewId: string, status: unknown): string {
  const value = asString(status);
  if (!value) return "";
  if ((viewId === "sales-invoices" || viewId === "bills") && INVOICE_STATUS[value]) return INVOICE_STATUS[value];
  return toTitleCase(value);
}

const getTypeLabel = (type: unknown) => TYPE_LABELS[asString(type)] ?? asString(type);
const getTaxName = (lookups: Lookups, taxType: unknown) => lookups.taxRateNames.get(asString(taxType)) ?? asString(taxType);

function getContact(record: XeroRecord, lookups: Lookups): XeroRecord {
  const inline = asObject(record.Contact);
  return lookups.contactsById.get(asString(inline.ContactID)) ?? inline;
}

function getAccountName(lookups: Lookups, account: unknown): string {
  const ref = asObject(account);
  return asString(lookups.accountsById.get(asString(ref.AccountID))?.Name ?? ref.Name ?? ref.Code);
}

function getPhone(contact: XeroRecord, phoneType: string): string {
  const phone = asArray(contact.Phones).find((p) => p.PhoneType === phoneType) ?? {};
  return [phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].map(asString).filter(Boolean).join(" ");
}

// ---------- shared column groups ----------
function getAddressColumns(prefix: string, addressType: string, contactOf: (r: XeroRecord) => XeroRecord, hasAttention: boolean): Column[] {
  const addressOf = (r: XeroRecord) => asArray(contactOf(r).Addresses).find((a) => a.AddressType === addressType) ?? {};
  return [
    ...(hasAttention ? [col(`${prefix}AttentionTo`, (r) => asString(addressOf(r).AttentionTo))] : []),
    ...[1, 2, 3, 4].map((n) => col(`${prefix}AddressLine${n}`, (r) => asString(addressOf(r)[`AddressLine${n}`]))),
    col(`${prefix}City`, (r) => asString(addressOf(r).City)),
    col(`${prefix}Region`, (r) => asString(addressOf(r).Region)),
    col(`${prefix}PostalCode`, (r) => asString(addressOf(r).PostalCode)),
    col(`${prefix}Country`, (r) => asString(addressOf(r).Country)),
  ];
}

const getTrackingColumns = (): Column[] =>
  [1, 2].flatMap((n) => [
    col(`TrackingName${n}`, (_, line) => asString(asArray(line.Tracking)[n - 1]?.Name)),
    col(`TrackingOption${n}`, (_, line) => asString(asArray(line.Tracking)[n - 1]?.Option)),
  ]);

const getAttachmentColumns = (pathsOf: AttachmentPathsOf): Column[] => [
  col("AttachmentCount", (r) => String(pathsOf(r).length)),
  col("AttachmentFiles", (r) => pathsOf(r).join("; ")),
];

function buildLineMatrix(records: XeroRecord[], columns: Column[], getLines: (r: XeroRecord) => XeroRecord[] = () => []): Matrix {
  const matrix: Matrix = [columns.map(([header]) => header)];
  for (const record of records) {
    const lines = getLines(record);
    for (const line of lines.length > 0 ? lines : [{}]) matrix.push(columns.map(([, get]) => get(record, line)));
  }
  return matrix;
}

// ---------- formatters (column layout follows Xero's CSV export files) ----------
interface DocumentConfig {
  numberField: string;
  dateHeader: string;
  dueField?: string;
  dueHeader?: string;
  extraColumns: Column[];
  hasDeliveryAddress?: boolean;
  hasType?: boolean;
  hasSent?: boolean;
}

const invoiceAmountColumns = [
  col("InvoiceAmountPaid", (r) => toAmount(r.AmountPaid)),
  col("InvoiceAmountDue", (r) => toAmount(r.AmountDue)),
];

const DOCUMENT_CONFIGS: Record<string, DocumentConfig> = {
  "sales-invoices": {
    numberField: "InvoiceNumber", dateHeader: "InvoiceDate", dueField: "DueDateString", dueHeader: "DueDate",
    extraColumns: invoiceAmountColumns, hasDeliveryAddress: true, hasType: true, hasSent: true,
  },
  bills: {
    numberField: "InvoiceNumber", dateHeader: "InvoiceDate", dueField: "DueDateString", dueHeader: "DueDate",
    extraColumns: invoiceAmountColumns, hasType: true,
  },
  "credit-notes": {
    numberField: "CreditNoteNumber", dateHeader: "CreditNoteDate",
    extraColumns: [col("RemainingCredit", (r) => toAmount(r.RemainingCredit))], hasType: true,
  },
  quotes: {
    numberField: "QuoteNumber", dateHeader: "QuoteDate", dueField: "ExpiryDateString", dueHeader: "ExpiryDate",
    extraColumns: [col("Title", (r) => asString(r.Title))],
  },
  "purchase-orders": {
    numberField: "PurchaseOrderNumber", dateHeader: "Date", dueField: "DeliveryDateString", dueHeader: "DeliveryDate",
    extraColumns: [col("DeliveryAddress", (r) => asString(r.DeliveryAddress)), col("AttentionTo", (r) => asString(r.AttentionTo))],
  },
};

const formatDocuments: Formatter = (view, records, lookups, pathsOf) => {
  const config = DOCUMENT_CONFIGS[view.id];
  const contactOf = (r: XeroRecord) => getContact(r, lookups);
  const columns: Column[] = [
    col("ContactName", (r) => asString(contactOf(r).Name)),
    col("EmailAddress", (r) => asString(contactOf(r).EmailAddress)),
    ...getAddressColumns("PO", "POBOX", contactOf, false),
    ...(config.hasDeliveryAddress ? getAddressColumns("SA", "STREET", contactOf, false) : []),
    col(config.numberField, (r) => asString(r[config.numberField])),
    col("Reference", (r) => asString(r.Reference)),
    col(config.dateHeader, (r) => formatXeroDate(r.DateString ?? r.Date)),
    ...(config.dueField && config.dueHeader ? [col(config.dueHeader, (r) => formatXeroDate(r[config.dueField as string]))] : []),
    col("Total", (r) => toAmount(r.Total)),
    col("TaxTotal", (r) => toAmount(r.TotalTax)),
    ...config.extraColumns,
    col("InventoryItemCode", (_, l) => asString(l.ItemCode)),
    col("Description", (_, l) => asString(l.Description)),
    col("Quantity", (_, l) => asString(l.Quantity)),
    col("UnitAmount", (_, l) => toAmount(l.UnitAmount)),
    col("Discount", (_, l) => asString(l.DiscountRate)),
    col("LineAmount", (_, l) => toAmount(l.LineAmount)),
    col("AccountCode", (_, l) => asString(l.AccountCode)),
    col("TaxType", (_, l) => getTaxName(lookups, l.TaxType)),
    col("TaxAmount", (_, l) => toAmount(l.TaxAmount)),
    ...getTrackingColumns(),
    col("Currency", (r) => asString(r.CurrencyCode)),
    ...(config.hasType ? [col("Type", (r) => getTypeLabel(r.Type))] : []),
    ...(config.hasSent ? [col("Sent", (r) => (r.SentToContact ? "Sent" : ""))] : []),
    col("Status", (r) => getStatusLabel(view.id, r.Status)),
    ...getAttachmentColumns(pathsOf),
  ];
  return buildLineMatrix(records, columns, (r) => asArray(r.LineItems));
};

const formatBankTransactions: Formatter = (view, records, lookups, pathsOf) =>
  buildLineMatrix(
    records,
    [
      col("Date", (r) => formatXeroDate(r.DateString ?? r.Date)),
      col("Type", (r) => getTypeLabel(r.Type)),
      col("ContactName", (r) => asString(getContact(r, lookups).Name)),
      col("Reference", (r) => asString(r.Reference)),
      col("BankAccount", (r) => getAccountName(lookups, r.BankAccount)),
      col("Description", (_, l) => asString(l.Description)),
      col("Quantity", (_, l) => asString(l.Quantity)),
      col("UnitAmount", (_, l) => toAmount(l.UnitAmount)),
      col("AccountCode", (_, l) => asString(l.AccountCode)),
      col("TaxType", (_, l) => getTaxName(lookups, l.TaxType)),
      col("TaxAmount", (_, l) => toAmount(l.TaxAmount)),
      col("LineAmount", (_, l) => toAmount(l.LineAmount)),
      ...getTrackingColumns(),
      col("Total", (r) => toAmount(r.Total)),
      col("Currency", (r) => asString(r.CurrencyCode)),
      col("Reconciled", (r) => toYesNo(r.IsReconciled)),
      col("Status", (r) => getStatusLabel(view.id, r.Status)),
      ...getAttachmentColumns(pathsOf),
    ],
    (r) => asArray(r.LineItems),
  );

const formatManualJournals: Formatter = (view, records, lookups, pathsOf) =>
  buildLineMatrix(
    records,
    [
      col("Narration", (r) => asString(r.Narration)),
      col("Date", (r) => formatXeroDate(r.DateString ?? r.Date)),
      col("Description", (_, l) => asString(l.Description)),
      col("AccountCode", (_, l) => asString(l.AccountCode)),
      col("TaxRate", (_, l) => getTaxName(lookups, l.TaxType)),
      col("Amount", (_, l) => toAmount(l.LineAmount)),
      ...getTrackingColumns(),
      col("Status", (r) => getStatusLabel(view.id, r.Status)),
      ...getAttachmentColumns(pathsOf),
    ],
    (r) => asArray(r.JournalLines),
  );

const formatPayments: Formatter = (view, records, lookups) =>
  buildLineMatrix(records, [
    col("Date", (r) => formatXeroDate(r.Date)),
    col("Reference", (r) => asString(r.Reference)),
    col("InvoiceNumber", (r) => asString(asObject(r.Invoice).InvoiceNumber)),
    col("ContactName", (r) => asString(asObject(asObject(r.Invoice).Contact).Name)),
    col("BankAccount", (r) => getAccountName(lookups, r.Account)),
    col("Amount", (r) => toAmount(r.Amount)),
    col("Currency", (r) => asString(asObject(r.Invoice).CurrencyCode)),
    col("PaymentType", (r) => getTypeLabel(r.PaymentType)),
    col("Status", (r) => getStatusLabel(view.id, r.Status)),
  ]);

const formatContacts: Formatter = (_view, records, _lookups, pathsOf) => {
  const self = (r: XeroRecord) => r;
  const firstPerson = (r: XeroRecord) => asArray(r.ContactPersons)[0] ?? {};
  return buildLineMatrix(records, [
    col("ContactName", (r) => asString(r.Name)),
    col("AccountNumber", (r) => asString(r.AccountNumber)),
    col("EmailAddress", (r) => asString(r.EmailAddress)),
    col("FirstName", (r) => asString(r.FirstName)),
    col("LastName", (r) => asString(r.LastName)),
    ...getAddressColumns("PO", "POBOX", self, true),
    ...getAddressColumns("SA", "STREET", self, true),
    col("PhoneNumber", (r) => getPhone(r, "DEFAULT")),
    col("FaxNumber", (r) => getPhone(r, "FAX")),
    col("MobileNumber", (r) => getPhone(r, "MOBILE")),
    col("DDINumber", (r) => getPhone(r, "DDI")),
    col("Website", (r) => asString(r.Website)),
    col("BankAccountDetails", (r) => asString(r.BankAccountDetails)),
    col("TaxNumber", (r) => asString(r.TaxNumber)),
    col("DefaultCurrency", (r) => asString(r.DefaultCurrency)),
    col("Person1FirstName", (r) => asString(firstPerson(r).FirstName)),
    col("Person1LastName", (r) => asString(firstPerson(r).LastName)),
    col("Person1Email", (r) => asString(firstPerson(r).EmailAddress)),
    col("IsCustomer", (r) => toYesNo(r.IsCustomer)),
    col("IsSupplier", (r) => toYesNo(r.IsSupplier)),
    col("AccountsReceivableOutstanding", (r) => toAmount(asObject(asObject(r.Balances).AccountsReceivable).Outstanding)),
    col("AccountsPayableOutstanding", (r) => toAmount(asObject(asObject(r.Balances).AccountsPayable).Outstanding)),
    col("Status", (r) => toTitleCase(asString(r.ContactStatus))),
    ...getAttachmentColumns(pathsOf),
  ]);
};

const formatAccounts: Formatter = (view, records, lookups, pathsOf) =>
  buildLineMatrix(records, [
    col("*Code", (r) => asString(r.Code)),
    col("*Name", (r) => asString(r.Name)),
    col("*Type", (r) => ACCOUNT_TYPES[asString(r.Type)] ?? asString(r.Type)),
    col("*Tax Code", (r) => getTaxName(lookups, r.TaxType)),
    col("Description", (r) => asString(r.Description)),
    col("Dashboard", (r) => toYesNo(r.AddToWatchlist)),
    col("Expense Claims", (r) => toYesNo(r.ShowInExpenseClaims)),
    col("Enable Payments", (r) => toYesNo(r.EnablePaymentsToAccount)),
    col("Bank Account Number", (r) => asString(r.BankAccountNumber)),
    col("Status", (r) => getStatusLabel(view.id, r.Status)),
    ...getAttachmentColumns(pathsOf),
  ]);

const formatItems: Formatter = (_view, records, lookups) => {
  const purchase = (r: XeroRecord) => asObject(r.PurchaseDetails);
  const sales = (r: XeroRecord) => asObject(r.SalesDetails);
  return buildLineMatrix(records, [
    col("*ItemCode", (r) => asString(r.Code)),
    col("ItemName", (r) => asString(r.Name)),
    col("PurchasesDescription", (r) => asString(r.PurchaseDescription)),
    col("PurchasesUnitPrice", (r) => toAmount(purchase(r).UnitPrice)),
    col("PurchasesAccount", (r) => asString(purchase(r).AccountCode ?? purchase(r).COGSAccountCode)),
    col("PurchasesTaxRate", (r) => getTaxName(lookups, purchase(r).TaxType)),
    col("SalesDescription", (r) => asString(r.Description)),
    col("SalesUnitPrice", (r) => toAmount(sales(r).UnitPrice)),
    col("SalesAccount", (r) => asString(sales(r).AccountCode)),
    col("SalesTaxRate", (r) => getTaxName(lookups, sales(r).TaxType)),
    col("InventoryAssetAccount", (r) => asString(r.InventoryAssetAccountCode)),
    col("QuantityOnHand", (r) => asString(r.QuantityOnHand)),
  ]);
};

const formatTaxRates: Formatter = (view, records) =>
  buildLineMatrix(records, [
    col("Tax Rate Name", (r) => asString(r.Name)),
    col("Tax Type", (r) => asString(r.TaxType)),
    col("Rate (%)", (r) => asString(r.EffectiveRate)),
    col("Components", (r) => asArray(r.TaxComponents).map((c) => `${asString(c.Name)} ${asString(c.Rate)}%`).join("; ")),
    col("Status", (r) => getStatusLabel(view.id, r.Status)),
  ]);

interface ReportRow {
  RowType?: string;
  Title?: string;
  Cells?: { Value?: string }[];
  Rows?: ReportRow[];
}

function buildReportMatrix(report: XeroRecord): Matrix {
  const matrix: Matrix = asArray(report.ReportTitles).map((title) => [asString(title)]);
  matrix.push([]);
  const walk = (rows: ReportRow[]) => {
    for (const row of rows) {
      if (row.RowType === "Section") {
        if (row.Title) matrix.push([row.Title]);
        walk(row.Rows ?? []);
      } else {
        matrix.push((row.Cells ?? []).map((cell) => asString(cell.Value)));
      }
    }
  };
  walk((report.Rows as ReportRow[] | undefined) ?? []);
  return matrix;
}

const FORMATTERS: Record<string, Formatter> = {
  "sales-invoices": formatDocuments,
  bills: formatDocuments,
  "credit-notes": formatDocuments,
  quotes: formatDocuments,
  "purchase-orders": formatDocuments,
  "bank-transactions": formatBankTransactions,
  "manual-journals": formatManualJournals,
  payments: formatPayments,
  contacts: formatContacts,
  accounts: formatAccounts,
  items: formatItems,
  "tax-rates": formatTaxRates,
};

function formatGeneric(view: ViewSpec, records: XeroRecord[], pathsOf: AttachmentPathsOf): CsvFile[] {
  const tables = buildTables(view.label, records, false);
  const mainRows = tables.get(view.label) ?? [];
  records.forEach((record, i) => {
    const paths = pathsOf(record);
    if (paths.length > 0) mainRows[i].AttachmentFiles = paths.join("; ");
  });
  return [...tables].filter(([, rows]) => rows.length > 0).map(([name, rows]) => ({ name, matrix: rowsToMatrix(rows) }));
}

export function buildViewCsvFiles(view: ViewSpec, records: XeroRecord[], lookups: Lookups, pathsOf: AttachmentPathsOf): CsvFile[] {
  if (records.length === 0) return [];
  if (view.kind === "report") return [{ name: view.label, matrix: records.flatMap(buildReportMatrix) }];
  const formatter = FORMATTERS[view.id];
  return formatter ? [{ name: view.label, matrix: formatter(view, records, lookups, pathsOf) }] : formatGeneric(view, records, pathsOf);
}

// ---------- attachments ----------
export function getRecordLabel(record: XeroRecord, lookups: Lookups): { number: string; party: string } {
  const number = asString(
    record.InvoiceNumber ?? record.CreditNoteNumber ?? record.QuoteNumber ?? record.PurchaseOrderNumber ?? record.Code ?? record.Reference ?? "",
  );
  const party = asString(getContact(record, lookups).Name ?? record.Name ?? record.Narration ?? "");
  return { number, party };
}

export function buildAttachmentIndex(items: AttachedRecord[], lookups: Lookups): Matrix {
  const matrix: Matrix = [["Type", "Number", "Contact", "Date", "Total", "Currency", "Status", "FileName", "FilePath", "Open"]];
  for (const { view, record, paths } of items) {
    const { number, party } = getRecordLabel(record, lookups);
    for (const path of paths) {
      matrix.push([
        getTypeLabel(record.Type) || view.label,
        number,
        party,
        formatXeroDate(record.DateString ?? record.Date),
        toAmount(record.Total),
        asString(record.CurrencyCode),
        getStatusLabel(view.id, record.Status ?? record.ContactStatus),
        path.split("/").pop() ?? path,
        path,
        `=HYPERLINK("${path.replace(/"/g, '""')}","Open")`,
      ]);
    }
  }
  return matrix;
}
