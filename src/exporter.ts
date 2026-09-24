import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_BASE, createXeroClient, DailyLimitError, type XeroClient } from "./xero";

type XeroRecord = Record<string, unknown>;
type Pagination = "none" | "page" | "offset";

interface EndpointSpec {
  path: string;
  responseKey?: string;
  pagination?: Pagination;
  query?: Record<string, string>;
  attachmentIdField?: string;
  attachmentLabelField?: string;
}

export interface ExportOptions {
  shouldDownloadAttachments: boolean;
  shouldRefresh: boolean;
  log: (message: string) => void;
}

interface ExportContext extends ExportOptions {
  client: XeroClient;
}

const ENDPOINTS: EndpointSpec[] = [
  { path: "Organisation", responseKey: "Organisations" },
  { path: "Accounts", attachmentIdField: "AccountID", attachmentLabelField: "Code" },
  { path: "TaxRates" },
  { path: "TrackingCategories", query: { includeArchived: "true" } },
  { path: "Currencies" },
  { path: "BrandingThemes" },
  { path: "Users" },
  { path: "ContactGroups" },
  { path: "Contacts", pagination: "page", query: { includeArchived: "true" }, attachmentIdField: "ContactID", attachmentLabelField: "Name" },
  { path: "Items" },
  { path: "Invoices", pagination: "page", attachmentIdField: "InvoiceID", attachmentLabelField: "InvoiceNumber" },
  { path: "CreditNotes", pagination: "page", attachmentIdField: "CreditNoteID", attachmentLabelField: "CreditNoteNumber" },
  { path: "Quotes", pagination: "page", attachmentIdField: "QuoteID", attachmentLabelField: "QuoteNumber" },
  { path: "PurchaseOrders", pagination: "page", attachmentIdField: "PurchaseOrderID", attachmentLabelField: "PurchaseOrderNumber" },
  { path: "RepeatingInvoices" },
  { path: "Payments", pagination: "page" },
  { path: "Prepayments", pagination: "page" },
  { path: "Overpayments", pagination: "page" },
  { path: "BatchPayments" },
  { path: "BankTransactions", pagination: "page", attachmentIdField: "BankTransactionID", attachmentLabelField: "Reference" },
  { path: "BankTransfers" },
  { path: "ManualJournals", pagination: "page", attachmentIdField: "ManualJournalID" },
  { path: "LinkedTransactions", pagination: "page" },
  { path: "Budgets" },
  { path: "Journals", pagination: "offset" },
  { path: "Reports/TrialBalance", responseKey: "Reports" },
  { path: "Reports/BalanceSheet", responseKey: "Reports" },
];

const toSafeName = (name: string) => name.replace(/[<>:"/\\|?*]+/g, "_").trim();

const ATTACHMENT_CONCURRENCY = 4;

// Runs `work` over the list a few items at a time; the client's rate limiter does the pacing.
async function forEachConcurrently<T>(items: T[], limit: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) await work(items[index], index);
  });
  await Promise.all(runners);
}

async function getRecords(ctx: ExportContext, tenantId: string, spec: EndpointSpec, params: Record<string, string>) {
  const query = new URLSearchParams({ ...spec.query, ...params });
  const res = await ctx.client.request(`${API_BASE}/${spec.path}?${query}`, tenantId);
  const body = (await res.json()) as Record<string, unknown>;
  return (body[spec.responseKey ?? spec.path] as XeroRecord[] | undefined) ?? [];
}

async function fetchEndpoint(ctx: ExportContext, tenantId: string, spec: EndpointSpec): Promise<XeroRecord[]> {
  const all: XeroRecord[] = [];

  if (spec.pagination === "page") {
    for (let page = 1; ; page++) {
      const items = await getRecords(ctx, tenantId, spec, { page: String(page), pageSize: "1000" });
      if (items.length === 0) break;
      all.push(...items);
      ctx.log(`  page ${page}: +${items.length} (total ${all.length})`);
    }
    return all;
  }

  if (spec.pagination === "offset") {
    let offset = 0;
    for (;;) {
      const items = await getRecords(ctx, tenantId, spec, { offset: String(offset) });
      if (items.length === 0) break;
      all.push(...items);
      offset = Number(items[items.length - 1].JournalNumber);
      if (all.length % 1000 < items.length) ctx.log(`  ${all.length} journals`);
    }
    return all;
  }

  return getRecords(ctx, tenantId, spec, {});
}

async function downloadAttachments(ctx: ExportContext, tenantId: string, tenantDir: string, spec: EndpointSpec, records: XeroRecord[]) {
  const idField = spec.attachmentIdField;
  if (!idField) return;

  const withAttachments = records.filter((r) => r.HasAttachments === true);
  if (withAttachments.length === 0) return;

  let done = 0;
  let failed = 0;

  await forEachConcurrently(withAttachments, ATTACHMENT_CONCURRENCY, async (record) => {
    const id = String(record[idField]);
    const label = spec.attachmentLabelField ? String(record[spec.attachmentLabelField] ?? "") : "";
    const folderName = label ? `${toSafeName(label)}_${id.slice(0, 8)}` : id;
    const group = spec.path === "Invoices" && record.Type === "ACCPAY" ? "Bills" : spec.path;
    const dir = join(tenantDir, "attachments", group, folderName);
    const doneMarker = join(dir, ".done");
    if (existsSync(doneMarker)) {
      done++;
      return;
    }

    try {
      const res = await ctx.client.request(`${API_BASE}/${spec.path}/${id}/Attachments`, tenantId);
      const { Attachments = [] } = (await res.json()) as {
        Attachments?: { AttachmentID?: string; FileName: string; Url: string; MimeType: string }[];
      };

      mkdirSync(dir, { recursive: true });
      const results = await Promise.all(
        Attachments.map(async (attachment) => {
          // Fetching by AttachmentID avoids file names Xero cannot resolve back (+, #, duplicates).
          const url = attachment.AttachmentID
            ? `${API_BASE}/${spec.path}/${id}/Attachments/${attachment.AttachmentID}`
            : attachment.Url;
          try {
            const fileRes = await ctx.client.request(url, tenantId, attachment.MimeType);
            writeFileSync(join(dir, toSafeName(attachment.FileName)), Buffer.from(await fileRes.arrayBuffer()));
            return true;
          } catch (err) {
            ctx.log(`  Could not download "${attachment.FileName}" on ${label || id}: ${(err as Error).message.slice(0, 120)}`);
            return false;
          }
        }),
      );

      // Only mark the record finished when every file arrived, so a later run retries the rest.
      if (results.every(Boolean)) {
        writeFileSync(doneMarker, "");
        done++;
        ctx.log(`  Attachments ${group}: ${done}/${withAttachments.length} — ${label || id} (${Attachments.length} file(s))`);
      } else {
        failed++;
      }
    } catch (err) {
      if (err instanceof DailyLimitError) throw err;
      failed++;
      ctx.log(`  Could not read attachments on ${label || id}: ${(err as Error).message.slice(0, 120)}`);
    }
  });

  if (failed > 0) {
    ctx.log(`  ${failed} record(s) with attachments left for the next run.`);
  }
}

async function exportTenant(ctx: ExportContext, tenantId: string, tenantName: string) {
  const tenantDir = join("data", toSafeName(tenantName));
  mkdirSync(tenantDir, { recursive: true });
  const failures: string[] = [];

  for (const [i, spec] of ENDPOINTS.entries()) {
    const file = join(tenantDir, `${toSafeName(spec.path)}.json`);
    const step = `[${i + 1}/${ENDPOINTS.length}] ${spec.path}`;
    let records: XeroRecord[];

    if (existsSync(file) && !ctx.shouldRefresh) {
      if (!ctx.shouldDownloadAttachments || !spec.attachmentIdField) continue;
      records = JSON.parse(readFileSync(file, "utf8")) as XeroRecord[];
    } else {
      ctx.log(step);
      try {
        records = await fetchEndpoint(ctx, tenantId, spec);
      } catch (err) {
        if (err instanceof DailyLimitError) throw err;
        const message = (err as Error).message;
        ctx.log(`  Skipped ${spec.path}: ${message}`);
        failures.push(`${spec.path}: ${message}`);
        continue;
      }
      writeFileSync(file, JSON.stringify(records, null, 2));
      ctx.log(`  Saved ${records.length} records`);
    }

    if (ctx.shouldDownloadAttachments) await downloadAttachments(ctx, tenantId, tenantDir, spec, records);
  }

  const errorsFile = join(tenantDir, "_errors.txt");
  rmSync(errorsFile, { force: true });
  if (failures.length > 0) {
    writeFileSync(errorsFile, failures.join("\n"));
    ctx.log(`${failures.length} endpoint(s) failed, usually a missing scope or permission.`);
  }
}

export async function runExport(options: ExportOptions) {
  const ctx: ExportContext = { ...options, client: createXeroClient(options.log) };
  for (const { tenantId, tenantName } of ctx.client.connections) {
    options.log(`=== ${tenantName} ===`);
    await exportTenant(ctx, tenantId, tenantName);
  }
  options.log("Sync finished.");
}
