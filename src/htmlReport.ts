import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ExportBundle } from "./dataStore";

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

interface Sheet {
  name: string;
  kind: "table" | "report";
  columns: string[];
  rows: string[][];
  attachmentColumn: number;
}

// Inline JSON must never contain a literal "<" so it cannot close the script tag.
const toInlineJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const CLIENT_SCRIPT = String.raw`
const SHEETS = JSON.parse(document.getElementById("sheets").textContent);
const FILES = JSON.parse(document.getElementById("files").textContent);
const blobUrls = {};
let active = 0;
let query = "";
let visibleRows = [];

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function getBlobUrl(path) {
  if (blobUrls[path]) return blobUrls[path];
  const file = FILES[path];
  if (!file) return null;
  const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
  blobUrls[path] = URL.createObjectURL(new Blob([bytes], { type: file.type }));
  return blobUrls[path];
}

function renderTabs() {
  document.getElementById("tabs").innerHTML = SHEETS.map(
    (sheet, i) =>
      '<button class="tab ' + (i === active ? "active" : "") + '" data-index="' + i + '">' +
      esc(sheet.name) + (sheet.kind === "table" ? ' <span>' + sheet.rows.length + "</span>" : "") + "</button>",
  ).join("");
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      active = Number(tab.dataset.index);
      renderTabs();
      renderTable();
    }),
  );
}

function getRowFiles(sheet, row) {
  if (sheet.attachmentColumn < 0) return [];
  return (row[sheet.attachmentColumn] || "").split("; ").filter(Boolean);
}

function renderPreview(paths) {
  return paths
    .map((path) => {
      const file = FILES[path];
      const name = path.split("/").pop();
      if (!file) return '<div class="file"><div class="file-head"><b>' + esc(name) + "</b><span>Không có trong file này</span></div></div>";
      const url = getBlobUrl(path);
      const body = file.type.indexOf("image/") === 0
        ? '<img src="' + url + '" alt="' + esc(name) + '" />'
        : file.type === "application/pdf"
          ? '<iframe src="' + url + '" title="' + esc(name) + '"></iframe>'
          : "";
      return '<div class="file"><div class="file-head"><b>' + esc(name) + "</b>" +
        '<span><a href="' + url + '" target="_blank" rel="noopener">Mở tab mới</a> · <a href="' + url + '" download="' + esc(name) + '">Tải về</a></span></div>' +
        body + "</div>";
    })
    .join("");
}

function renderTable() {
  const sheet = SHEETS[active];
  const container = document.getElementById("table");
  const needle = query.toLowerCase();
  visibleRows = needle ? sheet.rows.filter((row) => row.join(" ").toLowerCase().indexOf(needle) >= 0) : sheet.rows;
  document.getElementById("count").textContent = sheet.kind === "table" ? visibleRows.length + " dòng" : "";

  if (visibleRows.length === 0) {
    container.innerHTML = '<div class="empty">Không có dữ liệu.</div>';
    return;
  }

  if (sheet.kind === "report") {
    container.innerHTML = '<table class="report"><tbody>' +
      visibleRows.map((row) => "<tr>" + row.map((cell) => "<td>" + esc(cell) + "</td>").join("") + "</tr>").join("") +
      "</tbody></table>";
    return;
  }

  container.innerHTML =
    '<table><thead><tr><th></th>' + sheet.columns.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>" +
    visibleRows
      .map((row, i) => {
        const fileCount = getRowFiles(sheet, row).length;
        return '<tr class="' + (fileCount ? "has-files" : "") + '" data-row="' + i + '"><td class="clip">' +
          (fileCount ? "&#128206;" : "") + "</td>" + row.map((cell) => "<td>" + esc(cell) + "</td>").join("") + "</tr>" +
          '<tr class="preview" hidden><td></td><td colspan="' + sheet.columns.length + '"></td></tr>';
      })
      .join("") +
    "</tbody></table>";

  container.querySelectorAll("tr.has-files").forEach((tr) =>
    tr.addEventListener("click", () => {
      const preview = tr.nextElementSibling;
      const isOpen = !preview.hidden;
      preview.hidden = isOpen;
      tr.classList.toggle("open", !isOpen);
      if (!isOpen && !preview.dataset.loaded) {
        preview.lastElementChild.innerHTML = renderPreview(getRowFiles(SHEETS[active], visibleRows[Number(tr.dataset.row)]));
        preview.dataset.loaded = "1";
      }
    }),
  );
}

document.getElementById("search").addEventListener("input", (event) => {
  query = event.target.value;
  renderTable();
});

renderTabs();
renderTable();
`;

const STYLES = String.raw`
:root { --navy:#0b2a4a; --blue:#0078c8; --border:#dfe3e8; --muted:#62707d; --bg:#eef1f4; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:#1f2933; font:14px/1.45 "Segoe UI",system-ui,Arial,sans-serif; }
header { background:var(--navy); color:#fff; padding:14px 24px; }
header h1 { margin:0; font-size:19px; }
header p { margin:4px 0 0; color:#b9cde0; font-size:12px; }
.tabs { display:flex; flex-wrap:wrap; gap:4px; padding:10px 24px 0; background:#fff; border-bottom:1px solid var(--border); }
.tab { border:0; background:none; font:inherit; padding:9px 12px; border-bottom:3px solid transparent; color:var(--muted); cursor:pointer; white-space:nowrap; }
.tab.active { color:#1f2933; font-weight:600; border-bottom-color:var(--blue); }
.tab span { color:var(--muted); font-size:12px; }
.toolbar { display:flex; gap:12px; align-items:center; padding:12px 24px; }
#search { flex:0 1 340px; padding:8px 12px; border:1px solid var(--border); border-radius:6px; font:inherit; }
.muted { color:var(--muted); }
main { padding:0 24px 40px; }
.card { background:#fff; border:1px solid var(--border); border-radius:8px; overflow:auto; }
table { border-collapse:collapse; width:100%; }
th { position:sticky; top:0; background:#fafbfc; text-align:left; font-size:12px; color:var(--muted); padding:9px 12px; border-bottom:1px solid var(--border); white-space:nowrap; }
td { padding:9px 12px; border-bottom:1px solid #edf0f2; vertical-align:top; white-space:nowrap; }
tr.has-files { cursor:pointer; }
tr.has-files:hover { background:#f3f8fc; }
tr.open { background:#eaf4fd; }
td.clip { width:26px; }
.preview td { white-space:normal; background:#f7fafd; }
.file { margin:10px 0; border:1px solid var(--border); border-radius:6px; background:#fff; }
.file-head { display:flex; justify-content:space-between; gap:12px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--border); }
.file-head b { font-weight:600; word-break:break-all; }
.file img { display:block; max-width:100%; }
.file iframe { display:block; width:100%; height:70vh; border:0; }
.report td:first-child { white-space:normal; }
.report td:not(:first-child) { text-align:right; font-variant-numeric:tabular-nums; }
.empty { padding:40px; text-align:center; color:var(--muted); }
a { color:var(--blue); }
`;

export function buildHtmlReport(tenantName: string, bundle: ExportBundle): string {
  const sheets: Sheet[] = bundle.files.map((file) => {
    if (file.kind === "report") {
      return { name: file.name, kind: "report" as const, columns: [], rows: file.matrix, attachmentColumn: -1 };
    }
    // The "Open" column only carries an Excel formula, and Attachments.csv links files through FilePath.
    const [header = [], ...rows] = file.matrix;
    const keep = header.map((_, i) => header[i] !== "Open");
    const columns = header.filter((_, i) => keep[i]);
    const attachmentColumn = columns.indexOf("AttachmentFiles") >= 0 ? columns.indexOf("AttachmentFiles") : columns.indexOf("FilePath");
    return { name: file.name, kind: "table" as const, columns, rows: rows.map((row) => row.filter((_, i) => keep[i])), attachmentColumn };
  });

  const files = Object.fromEntries(
    bundle.attachments.map((attachment) => [
      attachment.path,
      {
        type: MIME_TYPES[extname(attachment.path).toLowerCase()] ?? "application/octet-stream",
        data: readFileSync(attachment.diskPath).toString("base64"),
      },
    ]),
  );

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(tenantName)} — Xero data</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(tenantName)}</h1>
  <p>Dữ liệu Xero, xuất lúc ${escapeHtml(new Date().toLocaleString("en-GB"))}. Bấm vào dòng có kẹp giấy để xem file đính kèm ngay tại chỗ.</p>
</header>
<div class="tabs" id="tabs"></div>
<div class="toolbar"><input id="search" type="search" placeholder="Tìm trong bảng..." /><span class="muted" id="count"></span></div>
<main><div class="card" id="table"></div></main>
<script type="application/json" id="sheets">${toInlineJson(sheets)}</script>
<script type="application/json" id="files">${toInlineJson(files)}</script>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}
