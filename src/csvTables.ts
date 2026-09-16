export type XeroRecord = Record<string, unknown>;
export type Row = Record<string, string>;
export type Tables = Map<string, Row[]>;

interface ReportCell {
  Value?: string;
}

interface ReportRow {
  RowType: string;
  Title?: string;
  Cells?: ReportCell[];
  Rows?: ReportRow[];
}

const XERO_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

const isPlainObject = (value: unknown): value is XeroRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const match = XERO_DATE.exec(value);
    if (!match) return value;
    const iso = new Date(Number(match[1])).toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function getIdEntry(record: XeroRecord): [string, string] | undefined {
  const key = Object.keys(record).find((k) => k.endsWith("ID") && typeof record[k] === "string");
  return key ? [key, record[key] as string] : undefined;
}

function addRow(tables: Tables, table: string, row: Row) {
  const rows = tables.get(table) ?? [];
  rows.push(row);
  tables.set(table, rows);
}

// Nested objects become dotted columns; arrays of objects become child tables linked by the parent's ID.
function flattenRecord(record: XeroRecord, table: string, tables: Tables, parent?: [string, string]) {
  const row: Row = parent ? { [parent[0]]: parent[1] } : {};
  const ownId = getIdEntry(record);

  const walk = (obj: XeroRecord, prefix: string) => {
    for (const [key, value] of Object.entries(obj)) {
      const column = prefix + key;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        if (value.every(isPlainObject) && ownId) {
          for (const child of value) flattenRecord(child, `${table}_${column.replace(/\./g, "_")}`, tables, ownId);
        } else {
          row[column] = value.map(formatValue).join("; ");
        }
      } else if (isPlainObject(value)) {
        walk(value, `${column}.`);
      } else {
        row[column] = formatValue(value);
      }
    }
  };

  walk(record, "");
  addRow(tables, table, row);
}

function flattenReport(report: XeroRecord, table: string, tables: Tables) {
  const walk = (rows: ReportRow[], section: string) => {
    for (const row of rows) {
      if (row.RowType === "Section") {
        walk(row.Rows ?? [], row.Title ?? section);
        continue;
      }
      const cells = (row.Cells ?? []).map((c) => c.Value ?? "");
      addRow(tables, table, {
        RowType: row.RowType,
        Section: section,
        ...Object.fromEntries(cells.map((value, i) => [`Col${i + 1}`, value])),
      });
    }
  };
  walk((report.Rows as ReportRow[] | undefined) ?? [], "");
}

export function buildTables(table: string, records: XeroRecord[], isReport: boolean): Tables {
  const tables: Tables = new Map([[table, []]]);
  for (const record of records) {
    if (isReport) flattenReport(record, table, tables);
    else flattenRecord(record, table, tables);
  }
  return tables;
}

export function rowsToMatrix(rows: Row[]): string[][] {
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ""))];
}

export function matrixToCsv(matrix: string[][]): string {
  const escape = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return "﻿" + matrix.map((row) => row.map(escape).join(",")).join("\r\n");
}

export function toCsv(rows: Row[]): string {
  return matrixToCsv(rowsToMatrix(rows));
}
