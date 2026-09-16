import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ExportBundle } from "./dataStore";
import { buildXlsx, type SheetImage, type SheetLink, type SheetSpec } from "./xlsx";

const PREVIEW_COLUMN = "Preview";
const FILE_COLUMN = "File";
const IMAGE_EXTENSIONS: Record<string, "png" | "jpeg"> = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg" };

function getAttachmentColumn(columns: string[]): number {
  const byFiles = columns.indexOf("AttachmentFiles");
  return byFiles >= 0 ? byFiles : columns.indexOf("FilePath");
}

// Excel shows images only if they are embedded; PDFs get a clickable link to the attachments folder instead.
export function buildExcelReport(bundle: ExportBundle): Buffer {
  const sheets: SheetSpec[] = bundle.files.map((file) => {
    if (file.kind === "report") {
      const width = Math.max(...file.matrix.map((row) => row.length), 1);
      return {
        name: file.name,
        columns: Array.from({ length: width }, (_, i) => (i === 0 ? file.name : " ".repeat(i))),
        rows: file.matrix,
      };
    }

    const [header = [], ...rows] = file.matrix;
    const keep = header.map((column) => column !== "Open");
    const columns = header.filter((_, i) => keep[i]);
    const body = rows.map((row) => row.filter((_, i) => keep[i]));
    const attachmentColumn = getAttachmentColumn(columns);
    if (attachmentColumn < 0) return { name: file.name, columns, rows: body };

    const links: SheetLink[] = [];
    const images: SheetImage[] = [];
    const fileColumn = columns.length;
    const previewColumn = columns.length + 1;

    body.forEach((row, rowIndex) => {
      const paths = (row[attachmentColumn] ?? "").split("; ").filter(Boolean);
      const first = paths[0];
      row[fileColumn] = first ? (first.split("/").pop() ?? "") + (paths.length > 1 ? ` (+${paths.length - 1})` : "") : "";
      row[previewColumn] = "";
      if (!first) return;

      links.push({ row: rowIndex, column: fileColumn, target: first });
      const extension = IMAGE_EXTENSIONS[extname(first).toLowerCase()];
      const attachment = bundle.attachments.find((a) => a.path === first);
      if (extension && attachment) {
        images.push({ row: rowIndex, column: previewColumn, data: readFileSync(attachment.diskPath), extension });
      }
    });

    return {
      name: file.name,
      columns: [...columns, FILE_COLUMN, PREVIEW_COLUMN],
      rows: body,
      links,
      images,
    };
  });

  return buildXlsx(sheets);
}
