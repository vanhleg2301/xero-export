import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImportBundle, outstandingAt, parseTrialBalance, toIsoDate } from "./goaBundle";

const cell = (Value: string, account?: string) => (account ? { Value, Attributes: [{ Id: "account", Value: account }] } : { Value });
const row = (label: string, account: string, d: string, c: string, yd = "", yc = "") => ({
  RowType: "Row",
  Cells: [cell(label, account), cell(d), cell(c), cell(yd), cell(yc)],
});
const report = (rows: unknown[]) => ({
  Rows: [
    { RowType: "Header", Cells: ["Account", "Debit", "Credit", "YTD Debit", "YTD Credit"].map((v) => ({ Value: v })) },
    { RowType: "Section", Title: "", Rows: rows },
    { RowType: "Section", Rows: [{ RowType: "SummaryRow", Cells: [{ Value: "Total" }] }] },
  ],
});

test("reads Xero's two date formats", () => {
  assert.equal(toIsoDate("/Date(1767225600000+0000)/"), "2026-01-01");
  assert.equal(toIsoDate("2025-12-31T00:00:00"), "2025-12-31");
  assert.equal(toIsoDate(""), null);
});

test("trial balance: one net line per account, code split from the name", () => {
  const warnings: string[] = [];
  const lines = parseTrialBalance(report([
    row("Bank (090)", "a1", "1,500.00", ""),
    row("Sales (200)", "a2", "", "1500.00"),
    row("Empty (999)", "a3", "", ""),
  ]), warnings);
  assert.deepEqual(warnings, []);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { accountSourceId: "a1", code: "090", name: "Bank", debit: 1500, credit: 0 });
  assert.deepEqual(lines[1], { accountSourceId: "a2", code: "200", name: "Sales", debit: 0, credit: 1500 });
});

test("trial balance: takes the YTD balances, not the month's movement, even when both balance", () => {
  const warnings: string[] = [];
  const lines = parseTrialBalance(report([
    row("Expenses (429)", "a1", "1295", "", "4261.99", ""),
    row("Accounts Payable (800)", "a2", "", "1295", "", "4261.99"),
  ]), warnings);
  assert.deepEqual(warnings, []);
  assert.equal(lines[0].debit, 4261.99);
  assert.equal(lines[1].credit, 4261.99);
});

test("trial balance: falls back to Debit/Credit when the YTD pair does not balance", () => {
  const warnings: string[] = [];
  const lines = parseTrialBalance(report([
    row("Bank (090)", "a1", "500", "", "100", ""),
    row("Sales (200)", "a2", "", "500", "", "40"),
  ]), warnings);
  assert.deepEqual(warnings, []);
  assert.equal(lines[0].debit, 500);
});

test("trial balance: warns when nothing balances", () => {
  const warnings: string[] = [];
  parseTrialBalance(report([row("Bank (090)", "a1", "100", ""), row("Sales (200)", "a2", "", "40")]), warnings);
  assert.equal(warnings.length, 1);
});

test("outstanding at the conversion date ignores later payments", () => {
  const doc = {
    Status: "PAID", DateString: "2025-11-01T00:00:00", Total: 1090,
    Payments: [
      { Date: "/Date(1764547200000+0000)/", Amount: 400 }, // 2025-12-01
      { Date: "/Date(1768262400000+0000)/", Amount: 690 }, // 2026-01-13
    ],
  };
  assert.equal(outstandingAt(doc, "2025-12-31"), 690);
  assert.equal(outstandingAt(doc, "2026-01-31"), 0);
  assert.equal(outstandingAt({ ...doc, DateString: "2026-02-01T00:00:00" }, "2025-12-31"), 0);
  assert.equal(outstandingAt({ ...doc, Status: "VOIDED" }, "2025-12-31"), 0);
});

const demo = (over: Record<string, unknown> = {}) => buildImportBundle({
  conversionDate: "2025-12-31",
  organisation: { Name: "Demo", BaseCurrency: "SGD", FinancialYearEndDay: 31, FinancialYearEndMonth: 12 },
  accounts: [
    { AccountID: "ar", Code: "610", Name: "Accounts Receivable", Type: "CURRENT", SystemAccount: "DEBTORS", Status: "ACTIVE" },
    { AccountID: "s", Code: "200", Name: "Sales", Type: "REVENUE", Status: "ACTIVE" },
  ],
  contacts: [{ ContactID: "c1", Name: "Acme", IsCustomer: true }],
  invoices: [{
    Type: "ACCREC", InvoiceID: "i1", InvoiceNumber: "INV-1", Status: "AUTHORISED", DateString: "2025-12-01T00:00:00",
    LineAmountTypes: "Inclusive", SubTotal: 917.43, TotalTax: 82.57, Total: 1000, Contact: { ContactID: "c1", Name: "Acme" },
    LineItems: [{ Description: "Fee", Quantity: 1, LineAmount: 1000, TaxAmount: 82.57, AccountCode: "200", TaxType: "OUTPUT" }],
  }],
  creditNotes: [],
  trialBalanceReport: report([row("Accounts Receivable (610)", "ar", "1200", ""), row("Sales (200)", "s", "", "1200")]),
  attachmentPathsById: new Map([["i1", ["attachments/Invoices/INV-1 - Acme - scan.pdf"]]]),
  ...over,
});

test("bundle carries documents with net lines and their attachments", () => {
  const bundle = demo();
  assert.equal(bundle.documents.length, 1);
  const [doc] = bundle.documents;
  assert.equal(doc.outstanding, 1000);
  assert.deepEqual(doc.lines[0], { description: "Fee", quantity: 1, unitPrice: 917.43, amount: 917.43, taxAmount: 82.57, accountCode: "200", taxType: "OUTPUT" });
  assert.deepEqual(doc.attachments, ["attachments/Invoices/INV-1 - Acme - scan.pdf"]);
  assert.equal(bundle.contacts[0].name, "Acme");
});

test("bundle warns when what is owing does not add up to receivables", () => {
  assert.ok(demo().warnings.some((w) => w.includes("Accounts Receivable is 1200.00")));
});

test("credit notes reduce receivables; later documents are left out with a warning", () => {
  const bundle = demo({
    creditNotes: [
      { Type: "ACCRECCREDIT", CreditNoteID: "cn1", CreditNoteNumber: "CN-1", Status: "AUTHORISED", DateString: "2025-12-10T00:00:00", Total: 300,
        Allocations: [{ Amount: 100, Date: "2025-12-15T00:00:00" }], Contact: { ContactID: "c1", Name: "Acme" } },
      { Type: "ACCRECCREDIT", CreditNoteID: "cn2", CreditNoteNumber: "CN-2", Status: "AUTHORISED", DateString: "2026-01-10T00:00:00", Total: 50 },
    ],
    trialBalanceReport: report([row("Accounts Receivable (610)", "ar", "800", ""), row("Sales (200)", "s", "", "800")]),
  });
  const cn = bundle.documents.find((d) => d.kind === "credit_note");
  assert.equal(cn?.outstanding, 200);
  assert.ok(!bundle.warnings.some((w) => w.includes("Accounts Receivable")));
  assert.ok(bundle.warnings.some((w) => w.includes("1 document(s) dated after")));
});
