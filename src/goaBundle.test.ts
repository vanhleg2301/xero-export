import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGoaBundle, outstandingAt, parseTrialBalance, toIsoDate } from "./goaBundle";

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
  assert.deepEqual(lines[0], { accountXeroId: "a1", code: "090", name: "Bank", debit: 1500, credit: 0 });
  assert.deepEqual(lines[1], { accountXeroId: "a2", code: "200", name: "Sales", debit: 0, credit: 1500 });
});

test("trial balance: falls back to the YTD pair when only it balances", () => {
  const warnings: string[] = [];
  const lines = parseTrialBalance(report([
    row("Bank (090)", "a1", "100", "", "500", ""),
    row("Sales (200)", "a2", "", "40", "", "500"),
  ]), warnings);
  assert.deepEqual(warnings, []);
  assert.equal(lines[0].debit, 500);
  assert.equal(lines[1].credit, 500);
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

test("bundle warns when open invoices do not add up to receivables", () => {
  const bundle = buildGoaBundle({
    conversionDate: "2025-12-31",
    organisation: { Name: "Demo", BaseCurrency: "SGD", FinancialYearEndDay: 31, FinancialYearEndMonth: 12 },
    accounts: [
      { AccountID: "ar", Code: "610", Name: "Accounts Receivable", Type: "CURRENT", SystemAccount: "DEBTORS", Status: "ACTIVE" },
      { AccountID: "s", Code: "200", Name: "Sales", Type: "REVENUE", Status: "ACTIVE" },
    ],
    contacts: [{ ContactID: "c1", Name: "Acme", IsCustomer: true }],
    invoices: [{ Type: "ACCREC", InvoiceID: "i1", InvoiceNumber: "INV-1", Status: "AUTHORISED", DateString: "2025-12-01T00:00:00", Total: 1000, Contact: { ContactID: "c1", Name: "Acme" } }],
    trialBalanceReport: report([row("Accounts Receivable (610)", "ar", "1200", ""), row("Sales (200)", "s", "", "1200")]),
  });
  assert.equal(bundle.openInvoices.length, 1);
  assert.equal(bundle.openInvoices[0].outstanding, 1000);
  assert.ok(bundle.warnings.some((w) => w.includes("Accounts Receivable is 1200.00")));
  assert.equal(bundle.contacts[0].name, "Acme");
});
