import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import {
  buildExportBundle,
  DATA_DIR,
  getRecordAttachments,
  indexAttachments,
  listDirs,
  loadRecords,
  type AttachmentFolder,
} from "./dataStore";
import { runExport } from "./exporter";
import { buildHtmlReport } from "./htmlReport";
import { VIEWS, type ViewSpec } from "./views";
import { exchangeCodeForTokens, getAuthorizeUrl, getConnectionStatus, getEnv } from "./xero";
import { createZip } from "./zip";

const redirectUri = new URL(getEnv("XERO_REDIRECT_URI"));
const PORT = Number(redirectUri.port || 80);
const PUBLIC_DIR = resolve("public");
const MAX_LOG_LINES = 2000;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface SyncJob {
  status: "idle" | "running" | "done" | "failed";
  startedAt?: number;
  finishedAt?: number;
  shouldDownloadAttachments?: boolean;
  shouldRefresh?: boolean;
  logs: string[];
}

let syncJob: SyncJob = { status: "idle", logs: [] };
const pendingAuthStates = new Set<string>();

// ---------- data helpers ----------
function resolveInside(base: string, ...parts: string[]): string | undefined {
  const target = resolve(base, ...parts);
  return target.startsWith(base + sep) ? target : undefined;
}

function buildZip(tenantDir: string, views: ViewSpec[]): Buffer {
  const bundle = buildExportBundle(tenantDir, views);
  return createZip([
    ...bundle.files.map((file) => ({ name: file.path, data: Buffer.from(file.csv, "utf8") })),
    ...bundle.attachments.map((attachment) => ({ name: attachment.path, data: readFileSync(attachment.diskPath) })),
  ]);
}

// ---------- responses ----------
function sendJson(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": MIME_TYPES[".json"] });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, path: string | undefined) {
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream" });
  res.end(readFileSync(path));
}

function sendZip(res: ServerResponse, fileName: string, zip: Buffer) {
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  res.end(zip);
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { Location: location }).end();
}

// ---------- sync job ----------
function startSync(shouldDownloadAttachments: boolean, shouldRefresh: boolean): boolean {
  if (syncJob.status === "running") return false;
  syncJob = { status: "running", startedAt: Date.now(), shouldDownloadAttachments, shouldRefresh, logs: [] };
  const job = syncJob;

  const log = (message: string) => {
    job.logs.push(`${new Date().toLocaleTimeString("en-GB")}  ${message}`);
    if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    console.log(message);
  };

  runExport({ shouldDownloadAttachments, shouldRefresh, log })
    .then(() => {
      job.status = "done";
    })
    .catch((err: unknown) => {
      job.status = "failed";
      log(`LỖI: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });
  return true;
}

// ---------- routes ----------
async function handleAuthCallback(url: URL, res: ServerResponse) {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code || !pendingAuthStates.delete(state)) {
    res.writeHead(400, { "Content-Type": MIME_TYPES[".html"] });
    res.end(`<p>Kết nối Xero thất bại: ${error ?? "callback không hợp lệ"}.</p><p><a href="/#/sync">Quay lại</a></p>`);
    return;
  }

  await exchangeCodeForTokens(code);
  redirect(res, "/#/sync");
}

function handleTenantApi(res: ServerResponse, parts: string[]) {
  if (parts.length === 2) return sendJson(res, listDirs(DATA_DIR));

  const tenant = parts[2];
  const tenantDir = resolveInside(DATA_DIR, tenant);
  if (!tenantDir || !existsSync(tenantDir)) return sendJson(res, { error: "Not found" }, 404);

  if (parts[3] === "download" && parts.length === 4) {
    return sendZip(res, `${tenant} - All data.zip`, buildZip(tenantDir, VIEWS));
  }

  if (parts[3] === "report" && parts.length === 4) {
    const html = buildHtmlReport(tenant, buildExportBundle(tenantDir, VIEWS));
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[".html"],
      "Content-Disposition": `attachment; filename="report.html"; filename*=UTF-8''${encodeURIComponent(`${tenant} - Xero data.html`)}`,
    });
    return res.end(html);
  }

  if (parts[3] !== "views") return sendJson(res, { error: "Not found" }, 404);

  if (parts.length === 4) {
    return sendJson(
      res,
      VIEWS.map((view) => ({
        id: view.id,
        label: view.label,
        group: view.group,
        idField: view.idField,
        kind: view.kind ?? "list",
        count: loadRecords(tenantDir, view).length,
      })),
    );
  }

  const view = VIEWS.find((v) => v.id === parts[4]);
  if (!view) return sendJson(res, { error: "View not found" }, 404);

  if (parts.length === 5) {
    const records = loadRecords(tenantDir, view);
    const index = indexAttachments(tenantDir);
    const attachments: Record<string, AttachmentFolder> = {};
    for (const record of records) {
      const folder = getRecordAttachments(record, view, index);
      if (folder && view.idField) attachments[String(record[view.idField])] = folder;
    }
    return sendJson(res, { records, attachments });
  }

  if (parts[5] === "download") {
    return sendZip(res, `${tenant} - ${view.label}.zip`, buildZip(tenantDir, [view]));
  }

  sendJson(res, { error: "Not found" }, 404);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (url.pathname === redirectUri.pathname) return handleAuthCallback(url, res);

  if (url.pathname === "/auth/connect") {
    const state = randomBytes(16).toString("hex");
    pendingAuthStates.add(state);
    return redirect(res, getAuthorizeUrl(state));
  }

  if (url.pathname === "/api/status") {
    return sendJson(res, { ...getConnectionStatus(), syncStatus: syncJob.status });
  }

  if (url.pathname === "/api/sync") {
    if (req.method === "POST") {
      if (!getConnectionStatus().isConnected) return sendJson(res, { error: "Chưa kết nối Xero." }, 400);
      const isStarted = startSync(url.searchParams.get("attachments") === "1", url.searchParams.get("refresh") === "1");
      return sendJson(res, syncJob, isStarted ? 202 : 409);
    }
    return sendJson(res, syncJob);
  }

  if (parts[0] === "api" && parts[1] === "tenants") return handleTenantApi(res, parts);

  if (parts[0] === "files" && parts[2] === "attachments") {
    const tenantDir = resolveInside(DATA_DIR, parts[1]);
    return sendFile(res, tenantDir && resolveInside(tenantDir, ...parts.slice(2)));
  }

  sendFile(res, resolveInside(PUBLIC_DIR, ...(parts.length > 0 ? parts : ["index.html"])));
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": MIME_TYPES[".txt"] });
    res.end(err instanceof Error ? err.message : String(err));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Xero data viewer: http://localhost:${PORT}`);
});
