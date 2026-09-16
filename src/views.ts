import type { XeroRecord } from "./csvTables";

export interface ViewSpec {
  id: string;
  label: string;
  group: string;
  dataset: string;
  idField?: string;
  kind?: "list" | "report";
  filter?: (record: XeroRecord) => boolean;
}

export const VIEWS: ViewSpec[] = [
  { id: "sales-invoices", label: "Invoices", group: "Sales", dataset: "Invoices", idField: "InvoiceID", filter: (r) => r.Type === "ACCREC" },
  { id: "quotes", label: "Quotes", group: "Sales", dataset: "Quotes", idField: "QuoteID" },
  { id: "credit-notes", label: "Credit notes", group: "Sales", dataset: "CreditNotes", idField: "CreditNoteID" },
  { id: "repeating-invoices", label: "Repeating invoices", group: "Sales", dataset: "RepeatingInvoices", idField: "RepeatingInvoiceID" },
  { id: "bills", label: "Bills", group: "Purchases", dataset: "Invoices", idField: "InvoiceID", filter: (r) => r.Type === "ACCPAY" },
  { id: "purchase-orders", label: "Purchase orders", group: "Purchases", dataset: "PurchaseOrders", idField: "PurchaseOrderID" },
  { id: "payments", label: "Payments", group: "Payments", dataset: "Payments", idField: "PaymentID" },
  { id: "batch-payments", label: "Batch payments", group: "Payments", dataset: "BatchPayments", idField: "BatchPaymentID" },
  { id: "prepayments", label: "Prepayments", group: "Payments", dataset: "Prepayments", idField: "PrepaymentID" },
  { id: "overpayments", label: "Overpayments", group: "Payments", dataset: "Overpayments", idField: "OverpaymentID" },
  { id: "bank-transactions", label: "Bank transactions", group: "Accounting", dataset: "BankTransactions", idField: "BankTransactionID" },
  { id: "bank-transfers", label: "Bank transfers", group: "Accounting", dataset: "BankTransfers", idField: "BankTransferID" },
  { id: "manual-journals", label: "Manual journals", group: "Accounting", dataset: "ManualJournals", idField: "ManualJournalID" },
  { id: "linked-transactions", label: "Linked transactions", group: "Accounting", dataset: "LinkedTransactions", idField: "LinkedTransactionID" },
  { id: "accounts", label: "Chart of accounts", group: "Accounting", dataset: "Accounts", idField: "AccountID" },
  { id: "tax-rates", label: "Tax rates", group: "Accounting", dataset: "TaxRates" },
  { id: "tracking-categories", label: "Tracking categories", group: "Accounting", dataset: "TrackingCategories", idField: "TrackingCategoryID" },
  { id: "budgets", label: "Budgets", group: "Accounting", dataset: "Budgets", idField: "BudgetID" },
  { id: "currencies", label: "Currencies", group: "Accounting", dataset: "Currencies" },
  { id: "balance-sheet", label: "Balance sheet", group: "Reports", dataset: "Reports_BalanceSheet", kind: "report" },
  { id: "trial-balance", label: "Trial balance", group: "Reports", dataset: "Reports_TrialBalance", kind: "report" },
  { id: "contacts", label: "All contacts", group: "Contacts", dataset: "Contacts", idField: "ContactID" },
  { id: "contact-groups", label: "Contact groups", group: "Contacts", dataset: "ContactGroups", idField: "ContactGroupID" },
  { id: "items", label: "Products and services", group: "Contacts", dataset: "Items", idField: "ItemID" },
  { id: "organisation", label: "Organisation", group: "Settings", dataset: "Organisation", idField: "OrganisationID" },
  { id: "users", label: "Users", group: "Settings", dataset: "Users", idField: "UserID" },
  { id: "branding-themes", label: "Branding themes", group: "Settings", dataset: "BrandingThemes", idField: "BrandingThemeID" },
];
