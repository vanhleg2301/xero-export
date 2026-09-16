import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { matrixToCsv, type XeroRecord } from "./csvTables";
import type { ViewSpec } from "./views";
import { buildAttachmentIndex, buildViewCsvFiles, formatXeroDate, getRecordLabel, type AttachedRecord, type Lookups } from "./xeroFormat";

export const DATA_DIR = resolve("data");

export interface AttachmentFolder {
  relDir: string;
  files: string[];
}

export interface ExportFile {
  path: string;
  csv: string;
}

export interface ExportAttachment {
  path: string;
  diskPath: string;
}

export interface ExportBundle {
  files: ExportFile[];
  attachments: ExportAttachment[];
}

export const toSafeFileName = (name: string) =>
  name.replace(/[<>:"/\|?*\x00-\x1f]+/g, "_").replace(/\s+/g, " ").trim();

export function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function loadDataset(tenantDir: string, dataset: string): XeroRecord[] {
  const file = join(tenantDir, `${dataset}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as XeroRecord[]) : [];
}

export function loadRecords(tenantDir: string, view: ViewSpec): XeroRecord[] {
  const records = loadDataset(tenantDir, view.dataset);
  return view.filter ? records.filter(view.filter) : records;
}

export function loadLookups(tenantDir: string): Lookups {
  const mapBy = (records: XeroRecord[], key: string) => new Map(records.map((r) => [String(r[key]), r]));
  return {
    taxRateNames: new Map(loadDataset(tenantDir, "TaxRates").map((r) => [String(r.TaxType), String(r.Name)])),
    contactsById: mapBy(loadDataset(tenantDir, "Contacts"), "ContactID"),
    accountsById: mapBy(loadDataset(tenantDir, "Accounts"), "AccountID"),
  };
}

// Attachment folders are named "<label>_<first 8 chars of ID>" (or the full ID) by exporter.ts.
export function indexAttachments(tenantDir: string): Map<string, AttachmentFolder> {
  const root = join(tenantDir, "attachments");
  const index = new Map<string, AttachmentFolder>();
  for (const group of listDirs(root)) {
    for (const folder of listDirs(join(root, group))) {
      const idPrefix = (/_([0-9a-f]{8})$/i.exec(folder)?.[1] ?? folder.slice(0, 8)).toLowerCase();
      const files = readdirSync(join(root, group, folder)).filter((f) => f !== ".done");
      if (files.length > 0) index.set(idPrefix, { relDir: `${group}/${folder}`, files });
    }
  }
  return index;
}

export function getRecordAttachments(record: XeroRecord, view: ViewSpec, index: Map<string, AttachmentFolder>) {
  const id = view.idField ? record[view.idField] : undefined;
  return typeof id === "string" ? index.get(id.slice(0, 8).toLowerCase()) : undefined;
}

function getUniquePath(dir: string, fileName: string, usedPaths: Set<string>): string {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let path = `${dir}/${fileName}`;
  for (let n = 2; usedPaths.has(path.toLowerCase()); n++) path = `${dir}/${base} (${n})${ext}`;
  usedPaths.add(path.toLowerCase());
  return path;
}

// CSVs sit at the root next to attachments/, so the paths inside them are relative to the CSV itself.
export function buildExportBundle(tenantDir: string, views: ViewSpec[]): ExportBundle {
  const index = indexAttachments(tenantDir);
  const lookups = loadLookups(tenantDir);
  const usedPaths = new Set<string>();
  const files: ExportFile[] = [];
  const attachments: ExportAttachment[] = [];
  const attachedRecords: AttachedRecord[] = [];

  for (const view of views) {
    const records = loadRecords(tenantDir, view);
    const pathsByRecord = new Map<XeroRecord, string[]>();

    if (view.kind !== "report") {
      for (const record of records) {
        const folder = getRecordAttachments(record, view, index);
        if (!folder) continue;
        const { number, party } = getRecordLabel(record, lookups);
        const identifier = number || formatXeroDate(record.DateString ?? record.Date).replace(/\//g, "-");
        const label = toSafeFileName([identifier, party].filter(Boolean).join(" - ")).slice(0, 120);
        const paths = folder.files.map((file) => {
          const path = getUniquePath(`attachments/${toSafeFileName(view.label)}`, label ? `${label} - ${file}` : file, usedPaths);
          attachments.push({ path, diskPath: join(tenantDir, "attachments", folder.relDir, file) });
          return path;
        });
        pathsByRecord.set(record, paths);
        attachedRecords.push({ view, record, paths });
      }
    }

    for (const file of buildViewCsvFiles(view, records, lookups, (r) => pathsByRecord.get(r) ?? [])) {
      files.push({ path: `${toSafeFileName(file.name)}.csv`, csv: matrixToCsv(file.matrix) });
    }
  }

  if (attachedRecords.length > 0) {
    files.unshift({ path: "Attachments.csv", csv: matrixToCsv(buildAttachmentIndex(attachedRecords, lookups)) });
  }

  return { files, attachments };
}
