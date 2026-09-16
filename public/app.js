const GROUP_ORDER = ["Sales", "Purchases", "Payments", "Accounting", "Reports", "Contacts", "Settings"];

const state = {
  tenants: [],
  tenant: "",
  isConnected: false,
  lastSyncStatus: null,
  syncPollTimer: null,
  views: [],
  view: null,
  records: [],
  attachments: {},
  status: "ALL",
  search: "",
  sort: null,
  visibleRows: [],
};

const mainEl = document.getElementById("main");
const drawerEl = document.getElementById("drawer");
const backdropEl = document.getElementById("drawer-backdrop");

// ---------- helpers ----------
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const getPath = (obj, path) => path.split(".").reduce((o, key) => (o == null ? undefined : o[key]), obj);

const apiUrl = (path) => `/api/tenants/${encodeURIComponent(state.tenant)}/${path}`;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function parseDate(value) {
  if (typeof value !== "string") return null;
  const msMatch = /^\/Date\((-?\d+)/.exec(value);
  if (msMatch) return new Date(Number(msMatch[1]));
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return new Date(`${value.slice(0, 10)}T00:00:00`);
  return null;
}

function formatDate(value) {
  const date = parseDate(value);
  return date ? date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
}

function formatMoney(value) {
  const num = typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof num === "number" ? num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : esc(value);
}

function formatAny(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && parseDate(value) && /Date|^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDate(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const INVOICE_STATUS = { DRAFT: "Draft", SUBMITTED: "Awaiting approval", AUTHORISED: "Awaiting payment", PAID: "Paid", VOIDED: "Voided", DELETED: "Deleted" };

function getStatusLabel(status) {
  const isInvoiceView = state.view && ["sales-invoices", "bills"].includes(state.view.id);
  if (isInvoiceView && INVOICE_STATUS[status]) return INVOICE_STATUS[status];
  return status ? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ") : "";
}

const renderBadge = (status) => (status ? `<span class="badge ${esc(status.toLowerCase())}">${esc(getStatusLabel(status))}</span>` : "");

const fileUrl = (relDir, file) =>
  `/files/${encodeURIComponent(state.tenant)}/attachments/${relDir.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(file)}`;

const CLIP_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;

// ---------- columns ----------
const textCol = (label, path) => ({ label, path, render: (r) => esc(formatAny(getPath(r, path))) });
const dateCol = (label, path) => ({ label, path, render: (r) => esc(formatDate(getPath(r, path))) });
const moneyCol = (label, path) => ({ label, path, align: "right", render: (r) => formatMoney(getPath(r, path)) });
const statusCol = (path = "Status") => ({ label: "Status", path, render: (r) => renderBadge(getPath(r, path)) });

const invoiceColumns = (party) => [
  textCol("Number", "InvoiceNumber"),
  textCol("Ref", "Reference"),
  textCol(party, "Contact.Name"),
  dateCol("Date", "DateString"),
  dateCol("Due date", "DueDateString"),
  moneyCol("Paid", "AmountPaid"),
  moneyCol("Due", "AmountDue"),
  moneyCol("Total", "Total"),
  textCol("Currency", "CurrencyCode"),
  statusCol(),
];

const COLUMNS = {
  "sales-invoices": invoiceColumns("To"),
  bills: invoiceColumns("From"),
  quotes: [textCol("Number", "QuoteNumber"), textCol("Ref", "Reference"), textCol("To", "Contact.Name"), dateCol("Date", "DateString"), dateCol("Expiry", "ExpiryDateString"), moneyCol("Total", "Total"), statusCol()],
  "credit-notes": [textCol("Number", "CreditNoteNumber"), textCol("Type", "Type"), textCol("Contact", "Contact.Name"), dateCol("Date", "DateString"), moneyCol("Remaining", "RemainingCredit"), moneyCol("Total", "Total"), statusCol()],
  "purchase-orders": [textCol("Number", "PurchaseOrderNumber"), textCol("Ref", "Reference"), textCol("Supplier", "Contact.Name"), dateCol("Date", "DateString"), dateCol("Delivery", "DeliveryDateString"), moneyCol("Total", "Total"), statusCol()],
  payments: [dateCol("Date", "Date"), textCol("Invoice", "Invoice.InvoiceNumber"), textCol("Contact", "Invoice.Contact.Name"), textCol("Account", "Account.Code"), textCol("Type", "PaymentType"), moneyCol("Amount", "Amount"), statusCol()],
  "bank-transactions": [dateCol("Date", "DateString"), textCol("Type", "Type"), textCol("Contact", "Contact.Name"), textCol("Reference", "Reference"), textCol("Bank account", "BankAccount.Name"), moneyCol("Total", "Total"), textCol("Reconciled", "IsReconciled"), statusCol()],
  "manual-journals": [dateCol("Date", "DateString"), textCol("Narration", "Narration"), statusCol()],
  accounts: [textCol("Code", "Code"), textCol("Name", "Name"), textCol("Type", "Type"), textCol("Tax rate", "TaxType"), textCol("Class", "Class"), statusCol()],
  contacts: [textCol("Name", "Name"), textCol("Email", "EmailAddress"), textCol("Customer", "IsCustomer"), textCol("Supplier", "IsSupplier"), textCol("Tax number", "TaxNumber"), statusCol("ContactStatus")],
  users: [textCol("First name", "FirstName"), textCol("Last name", "LastName"), textCol("Email", "EmailAddress"), textCol("Role", "OrganisationRole")],
  "tax-rates": [textCol("Name", "Name"), textCol("Tax type", "TaxType"), textCol("Effective rate", "EffectiveRate"), statusCol()],
};

function getGenericColumns(records) {
  const keys = [];
  for (const record of records.slice(0, 20)) {
    for (const [key, value] of Object.entries(record)) {
      if (keys.includes(key) || value === null || typeof value === "object" || key.endsWith("ID") || key.endsWith("UTC")) continue;
      keys.push(key);
    }
  }
  return keys.slice(0, 8).map((key) => (key === "Status" ? statusCol() : textCol(key, key)));
}

function compareValues(a, b) {
  const dateA = parseDate(a);
  const dateB = parseDate(b);
  if (dateA && dateB) return dateA - dateB;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
}

// ---------- navigation ----------
function renderNav() {
  const nav = document.getElementById("nav");
  if (state.views.length === 0) {
    nav.innerHTML = "";
    return;
  }
  nav.innerHTML = GROUP_ORDER.map((group) => {
    const items = state.views.filter((v) => v.group === group);
    const isActive = state.view?.group === group;
    return `
      <div class="nav-group">
        <button class="nav-trigger ${isActive ? "active" : ""}">${esc(group)}</button>
        <div class="nav-menu">
          ${items
            .map((v) => `<a href="#/${v.id}" class="${v.count === 0 ? "empty" : ""}"><span>${esc(v.label)}</span><span class="count">${v.count}</span></a>`)
            .join("")}
        </div>
      </div>`;
  }).join("");
}

async function handleRoute() {
  closeDrawer();
  const route = location.hash.replace(/^#\//, "") || "home";
  document.activeElement?.blur();

  if (route === "sync" || !state.tenant) {
    state.view = null;
    renderNav();
    if (route !== "sync") {
      location.hash = "#/sync";
      return;
    }
    return renderSyncPage();
  }

  state.view = state.views.find((v) => v.id === route) ?? null;
  renderNav();
  if (!state.view) return renderHome();

  mainEl.innerHTML = `<div class="empty-state">Đang tải...</div>`;
  const data = await fetchJson(apiUrl(`views/${state.view.id}`));
  state.records = data.records;
  state.attachments = data.attachments;
  state.status = "ALL";
  state.search = "";
  state.sort = null;

  if (state.view.kind === "report") renderReportPage();
  else renderListPage();
}

// ---------- home ----------
async function renderHome() {
  const [sales, bills] = await Promise.all([fetchJson(apiUrl("views/sales-invoices")), fetchJson(apiUrl("views/bills"))]);
  const summarize = (records) => {
    const open = records.filter((r) => r.Status === "AUTHORISED" || r.Status === "SUBMITTED");
    return { count: open.length, due: open.reduce((sum, r) => sum + (r.AmountDue ?? 0), 0), currency: records[0]?.CurrencyCode ?? "" };
  };
  const owed = summarize(sales.records);
  const toPay = summarize(bills.records);
  const attachmentCount = Object.keys(sales.attachments).length + Object.keys(bills.attachments).length;

  mainEl.innerHTML = `
    <div class="page-head">
      <div><div class="crumb">Dashboard</div><h1>${esc(state.tenant)}</h1></div>
      <div class="actions">
        <a class="btn" href="${apiUrl("report")}">Xem offline (.html)</a>
        <a class="btn" href="${apiUrl("excel")}">Excel (.xlsx)</a>
        <a class="btn primary" href="${apiUrl("download")}">Tải toàn bộ dữ liệu (CSV + file đính kèm)</a>
      </div>
    </div>
    <div class="summary">
      <div class="card"><div class="muted">Invoices owed to you</div><div class="big">${formatMoney(owed.due)} <small class="muted">${esc(owed.currency)}</small></div>
        <a href="#/sales-invoices">${owed.count} awaiting payment</a></div>
      <div class="card"><div class="muted">Bills you need to pay</div><div class="big">${formatMoney(toPay.due)} <small class="muted">${esc(toPay.currency)}</small></div>
        <a href="#/bills">${toPay.count} awaiting payment</a></div>
      <div class="card"><div class="muted">Hóa đơn/bill có file đính kèm đã tải</div><div class="big">${attachmentCount}</div>
        <a href="#/sync">Đồng bộ để tải thêm file đính kèm</a></div>
    </div>
    <div class="groups">
      ${GROUP_ORDER.map(
        (group) => `
        <div class="card"><h3>${esc(group)}</h3>
          ${state.views
            .filter((v) => v.group === group)
            .map((v) => `<a href="#/${v.id}" class="${v.count === 0 ? "muted" : ""}"><span>${esc(v.label)}</span><span class="count">${v.count}</span></a>`)
            .join("")}
        </div>`,
      ).join("")}
    </div>`;
}

// ---------- list ----------
function renderListPage() {
  const view = state.view;
  mainEl.innerHTML = `
    <div class="page-head">
      <div><div class="crumb">${esc(view.group)}</div><h1>${esc(view.label)}</h1></div>
      <button class="btn primary" id="download-btn" ${state.records.length === 0 ? "disabled" : ""}>Tải CSV + file đính kèm (.zip)</button>
    </div>
    <div class="card">
      <div id="tabs"></div>
      <div class="toolbar">
        <input class="search" id="search" type="search" placeholder="Tìm theo số, tên, mô tả..." />
        <span class="muted" id="row-count"></span>
      </div>
      <div class="table-wrap" id="table-area"></div>
    </div>`;

  document.getElementById("download-btn").addEventListener("click", () => {
    location.href = apiUrl(`views/${view.id}/download`);
  });
  document.getElementById("search").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderTable();
  });
  renderTable();
}

function renderTabs() {
  const statuses = [...new Set(state.records.map((r) => r.Status).filter(Boolean))];
  const tabsEl = document.getElementById("tabs");
  if (statuses.length < 2) {
    tabsEl.innerHTML = "";
    return;
  }
  const countOf = (status) => state.records.filter((r) => status === "ALL" || r.Status === status).length;
  tabsEl.innerHTML = `<div class="tabs">${["ALL", ...statuses]
    .map(
      (s) =>
        `<button class="tab ${state.status === s ? "active" : ""}" data-status="${esc(s)}">${esc(s === "ALL" ? "All" : getStatusLabel(s))} (${countOf(s)})</button>`,
    )
    .join("")}</div>`;
  tabsEl.querySelectorAll(".tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.status = btn.dataset.status;
      renderTable();
    }),
  );
}

function renderTable() {
  renderTabs();
  const view = state.view;
  const columns = COLUMNS[view.id] ?? getGenericColumns(state.records);

  let rows = state.records.filter((r) => state.status === "ALL" || r.Status === state.status);
  if (state.search) {
    const query = state.search.toLowerCase();
    rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(query));
  }
  if (state.sort) {
    const { path, dir } = state.sort;
    rows = [...rows].sort((a, b) => compareValues(getPath(a, path), getPath(b, path)) * dir);
  }
  state.visibleRows = rows;
  document.getElementById("row-count").textContent = `${rows.length} bản ghi`;

  const area = document.getElementById("table-area");
  if (rows.length === 0) {
    area.innerHTML = `<div class="empty-state">${state.records.length === 0 ? "Không có dữ liệu cho mục này." : "Không tìm thấy bản ghi phù hợp."}</div>`;
    return;
  }

  const sortMark = (path) => (state.sort?.path === path ? (state.sort.dir === 1 ? " ▲" : " ▼") : "");
  area.innerHTML = `
    <table class="data">
      <thead><tr>
        <th class="clip"></th>
        ${columns.map((c) => `<th class="${c.align === "right" ? "right" : ""}" data-path="${esc(c.path)}">${esc(c.label)}${sortMark(c.path)}</th>`).join("")}
      </tr></thead>
      <tbody>
        ${rows
          .map((record, i) => {
            const id = view.idField ? record[view.idField] : undefined;
            const clip = state.attachments[id]
              ? `<span title="${state.attachments[id].files.length} file đính kèm">${CLIP_ICON}</span>`
              : record.HasAttachments
                ? `<span class="missing" title="Có file đính kèm trên Xero nhưng chưa tải về">${CLIP_ICON}</span>`
                : "";
            return `<tr data-index="${i}"><td class="clip ${state.attachments[id] ? "" : "missing"}">${clip}</td>${columns
              .map((c) => `<td class="${c.align === "right" ? "right" : ""}">${c.render(record)}</td>`)
              .join("")}</tr>`;
          })
          .join("")}
      </tbody>
    </table>`;

  area.querySelectorAll("th[data-path]").forEach((th) =>
    th.addEventListener("click", () => {
      const path = th.dataset.path;
      state.sort = state.sort?.path === path ? { path, dir: -state.sort.dir } : { path, dir: 1 };
      renderTable();
    }),
  );
  area.querySelectorAll("tbody tr").forEach((tr) =>
    tr.addEventListener("click", () => openDetail(state.visibleRows[Number(tr.dataset.index)])),
  );
}

// ---------- detail drawer ----------
function getRecordTitle(record) {
  const keys = ["InvoiceNumber", "QuoteNumber", "CreditNoteNumber", "PurchaseOrderNumber", "Name", "Reference", "Narration", "Code"];
  const key = keys.find((k) => record[k]);
  return key ? record[key] : state.view.label;
}

function renderMeta(pairs) {
  const items = pairs.filter(([, value]) => value !== "" && value !== undefined && value !== null);
  return `<dl class="meta">${items.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

function renderInvoiceDetail(record) {
  const partyLabel = state.view.id === "bills" || state.view.id === "purchase-orders" ? "From" : "To";
  const meta = renderMeta([
    [partyLabel, esc(record.Contact?.Name)],
    ["Date", esc(formatDate(record.DateString ?? record.Date))],
    ["Due date", esc(formatDate(record.DueDateString ?? record.DueDate))],
    ["Number", esc(record.InvoiceNumber ?? record.QuoteNumber ?? record.CreditNoteNumber ?? record.PurchaseOrderNumber)],
    ["Reference", esc(record.Reference)],
    ["Currency", esc(record.CurrencyCode)],
    ["Amounts are", esc(record.LineAmountTypes)],
    ["Status", renderBadge(record.Status)],
  ]);

  const lines = `
    <table class="lines">
      <thead><tr><th>Description</th><th class="right">Qty</th><th class="right">Unit price</th><th>Account</th><th>Tax rate</th><th class="right">Tax</th><th class="right">Amount</th></tr></thead>
      <tbody>
        ${(record.LineItems ?? [])
          .map(
            (l) => `<tr>
              <td>${esc(l.Description)}${l.ItemCode ? `<div class="muted">${esc(l.ItemCode)}</div>` : ""}</td>
              <td class="right">${esc(l.Quantity)}</td>
              <td class="right">${formatMoney(l.UnitAmount)}</td>
              <td>${esc(l.AccountCode)}</td>
              <td>${esc(l.TaxType)}</td>
              <td class="right">${formatMoney(l.TaxAmount)}</td>
              <td class="right">${formatMoney(l.LineAmount)}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  const totals = `
    <div class="totals">
      <div><span>Subtotal</span><span>${formatMoney(record.SubTotal)}</span></div>
      <div><span>Total tax</span><span>${formatMoney(record.TotalTax)}</span></div>
      <div class="grand"><span>Total</span><span>${formatMoney(record.Total)}</span></div>
      ${record.AmountPaid ? `<div><span>Less payments</span><span>${formatMoney(-record.AmountPaid)}</span></div>` : ""}
      ${record.AmountCredited ? `<div><span>Less credits</span><span>${formatMoney(-record.AmountCredited)}</span></div>` : ""}
      ${record.AmountDue !== undefined ? `<div class="grand"><span>Amount due</span><span>${formatMoney(record.AmountDue)}</span></div>` : ""}
    </div>`;

  const payments = record.Payments?.length
    ? `<h3>Payments</h3>${renderSubTable(record.Payments)}`
    : "";

  return meta + lines + totals + payments;
}

function renderSubTable(items) {
  const keys = [...new Set(items.flatMap((item) => Object.keys(item).filter((k) => typeof item[k] !== "object" || item[k] === null)))];
  return `<div class="table-wrap"><table class="lines">
    <thead><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join("")}</tr></thead>
    <tbody>${items.map((item) => `<tr>${keys.map((k) => `<td>${esc(formatAny(item[k]))}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

function renderGenericDetail(record) {
  const pairs = [];
  const subTables = [];
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (value.every((v) => v && typeof v === "object")) subTables.push(`<h3>${esc(key)}</h3>${renderSubTable(value)}`);
      else pairs.push([key, esc(value.join(", "))]);
    } else if (value && typeof value === "object") {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subValue === null || typeof subValue !== "object") pairs.push([`${key}.${subKey}`, esc(formatAny(subValue))]);
      }
    } else {
      pairs.push([key, key === "Status" ? renderBadge(value) : esc(formatAny(value))]);
    }
  }
  return renderMeta(pairs) + subTables.join("");
}

function renderAttachments(record) {
  const id = state.view.idField ? record[state.view.idField] : undefined;
  const folder = state.attachments[id];
  if (!folder) {
    return record.HasAttachments
      ? `<h3>File đính kèm</h3><div class="notice">Bản ghi này có file đính kèm trên Xero nhưng chưa tải về. <a href="#/sync">Đồng bộ kèm file đính kèm</a>.</div>`
      : "";
  }
  return `<h3>File đính kèm (${folder.files.length})</h3><div class="attachments">${folder.files
    .map((file) => {
      const url = fileUrl(folder.relDir, file);
      const ext = file.split(".").pop().toLowerCase();
      const preview = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)
        ? `<img src="${url}" alt="${esc(file)}" />`
        : ext === "pdf"
          ? `<iframe src="${url}" title="${esc(file)}"></iframe>`
          : "";
      return `<div class="attachment">
        <div class="attachment-head"><span>${esc(file)}</span>
          <span class="links"><a href="${url}" target="_blank" rel="noopener">Mở</a><a href="${url}" download="${esc(file)}">Tải về</a></span>
        </div>${preview}</div>`;
    })
    .join("")}</div>`;
}

function openDetail(record) {
  document.getElementById("drawer-crumb").textContent = `${state.view.group} › ${state.view.label}`;
  document.getElementById("drawer-title").textContent = getRecordTitle(record);
  const body = Array.isArray(record.LineItems) ? renderInvoiceDetail(record) : renderGenericDetail(record);
  document.getElementById("drawer-body").innerHTML = `
    ${body}
    ${renderAttachments(record)}
    <details class="raw"><summary>Dữ liệu gốc (JSON)</summary><pre>${esc(JSON.stringify(record, null, 2))}</pre></details>`;
  drawerEl.hidden = false;
  backdropEl.hidden = false;
}

function closeDrawer() {
  drawerEl.hidden = true;
  backdropEl.hidden = true;
}

// ---------- report ----------
function renderReportRows(rows) {
  return rows
    .map((row) => {
      if (row.RowType === "Section") {
        const title = row.Title ? `<tr class="section"><td colspan="99">${esc(row.Title)}</td></tr>` : "";
        return title + renderReportRows(row.Rows ?? []);
      }
      if (row.RowType === "Header") return "";
      const cells = row.Cells ?? [];
      return `<tr class="${row.RowType === "SummaryRow" ? "summary" : ""}">${cells
        .map((cell, i) => (i === 0 ? `<td>${esc(cell.Value)}</td>` : `<td class="right">${formatMoney(cell.Value)}</td>`))
        .join("")}</tr>`;
    })
    .join("");
}

function renderReportPage() {
  const view = state.view;
  const report = state.records[0];
  const header = report?.Rows?.find((r) => r.RowType === "Header");

  mainEl.innerHTML = `
    <div class="page-head">
      <div><div class="crumb">${esc(view.group)}</div><h1>${esc(view.label)}</h1></div>
      <button class="btn primary" id="download-btn" ${report ? "" : "disabled"}>Tải CSV (.zip)</button>
    </div>
    <div class="card">
      ${
        report
          ? `<div class="report-titles">${(report.ReportTitles ?? []).map((t) => `<div>${esc(t)}</div>`).join("")}</div>
            <div class="table-wrap"><table class="report">
              ${header ? `<thead><tr>${header.Cells.map((c, i) => `<th class="${i ? "right" : ""}">${esc(c.Value)}</th>`).join("")}</tr></thead>` : ""}
              <tbody>${renderReportRows(report.Rows ?? [])}</tbody>
            </table></div>`
          : `<div class="empty-state">Chưa có báo cáo.</div>`
      }
    </div>`;

  document.getElementById("download-btn").addEventListener("click", () => {
    location.href = apiUrl(`views/${view.id}/download`);
  });
}

// ---------- sync page ----------
function formatDateTime(ms) {
  return ms ? new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
}

function updateSyncBadge(syncStatus) {
  const dot = document.getElementById("sync-dot");
  dot.className = `dot ${syncStatus === "running" ? "running" : syncStatus === "failed" ? "error" : state.isConnected ? "ok" : ""}`;
  document.getElementById("sync-label").textContent = syncStatus === "running" ? "Đang đồng bộ..." : "Kết nối & đồng bộ";
}

function renderDownloads() {
  const el = document.getElementById("downloads");
  if (!el) return;
  el.innerHTML = state.tenants.length
    ? state.tenants
        .map(
          (t) => `<div class="download-row"><strong>${esc(t)}</strong>
            <span class="actions">
              <a class="btn" href="/api/tenants/${encodeURIComponent(t)}/report">Xem offline (.html)</a>
              <a class="btn" href="/api/tenants/${encodeURIComponent(t)}/excel">Excel (.xlsx)</a>
              <a class="btn primary" href="/api/tenants/${encodeURIComponent(t)}/download">CSV + đính kèm (.zip)</a>
            </span></div>`,
        )
        .join("")
    : `<p class="muted">Chưa có dữ liệu. Kết nối Xero rồi bấm "Bắt đầu đồng bộ".</p>`;
}

async function renderSyncPage() {
  const status = await fetchJson("/api/status");
  state.isConnected = status.isConnected;

  mainEl.innerHTML = `
    <div class="page-head"><div><div class="crumb">Xero</div><h1>Kết nối &amp; đồng bộ</h1></div></div>
    <div class="sync-grid">
      <div class="card">
        <h3>1. Kết nối Xero</h3>
        ${
          status.hasCredentials
            ? ""
            : `<div class="notice">
                 <b>Chưa khai báo app Xero.</b> Vào <a href="https://developer.xero.com/app/manage" target="_blank" rel="noopener">developer.xero.com</a>,
                 tạo app loại <b>Web app</b> với redirect URI <code>${esc(location.origin)}/callback</code>, rồi dán Client ID và Client Secret vào đây.
               </div>
               <label class="field">Client ID<input id="client-id" type="text" autocomplete="off" /></label>
               <label class="field">Client Secret<input id="client-secret" type="password" autocomplete="off" /></label>
               <div class="actions"><button class="btn primary" id="save-credentials">Lưu</button></div>
               <p class="muted" id="credentials-error"></p>`
        }
        <div class="status-line"><span class="dot ${status.isConnected ? "ok" : ""}"></span>${status.isConnected ? "Đã kết nối" : "Chưa kết nối"}</div>
        ${
          status.isConnected
            ? `<ul class="org-list">${status.connections.map((c) => `<li>${esc(c.tenantName)}</li>`).join("")}</ul>
               <p class="muted">Phiên đăng nhập còn hiệu lực đến khoảng ${esc(formatDateTime(status.refreshTokenExpiresAt))} (tự gia hạn mỗi lần đồng bộ).</p>`
            : `<p class="muted">Đăng nhập Xero và chọn tổ chức muốn lấy dữ liệu.</p>`
        }
        ${
          status.hasCredentials
            ? `<div class="actions">
                 <a class="btn ${status.isConnected ? "" : "primary"}" href="/auth/connect">${status.isConnected ? "Kết nối lại / thêm tổ chức" : "Kết nối Xero"}</a>
               </div>`
            : ""
        }
      </div>

      <div class="card">
        <h3>2. Đồng bộ dữ liệu</h3>
        <label class="check"><input type="checkbox" id="opt-attachments" checked />
          <span>Tải file đính kèm<small>Hóa đơn, bill, PO, chứng từ ngân hàng... File đã tải sẽ được bỏ qua.</small></span></label>
        <label class="check"><input type="checkbox" id="opt-refresh" ${state.tenants.length ? "" : "disabled"} />
          <span>Lấy lại toàn bộ dữ liệu mới nhất<small>Không chọn: chỉ lấy những mục chưa có (tiếp tục lần trước).</small></span></label>
        <div class="actions"><button class="btn primary" id="sync-btn" disabled>Bắt đầu đồng bộ</button></div>
        <p class="muted" id="sync-status"></p>
      </div>

      <div class="card">
        <h3>3. Tải dữ liệu về máy</h3>
        <p class="muted">Một file .zip gồm CSV theo định dạng export của Xero (Invoices, Bills, Contacts...) và thư mục attachments. <code>Attachments.csv</code> liệt kê từng file thuộc chứng từ nào; tên file cũng có số chứng từ và tên đối tác.</p>
        <p class="muted">Bản <b>.html</b> là một file duy nhất chứa mọi bảng và toàn bộ file đính kèm: mở bằng trình duyệt, bấm vào dòng là hiện luôn PDF/ảnh, không cần giải nén. Bản <b>.xlsx</b> mỗi loại dữ liệu một sheet, ảnh hiện ngay trong dòng, PDF là link bấm mở (cần đặt cạnh thư mục attachments đã giải nén).</p>
        <div id="downloads"></div>
      </div>
    </div>

    <div class="card padded">
      <h3>Nhật ký đồng bộ</h3>
      <pre class="log" id="sync-log">Chưa có tác vụ nào.</pre>
    </div>`;

  renderDownloads();

  document.getElementById("save-credentials")?.addEventListener("click", async () => {
    const res = await fetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: document.getElementById("client-id").value,
        clientSecret: document.getElementById("client-secret").value,
      }),
    });
    if (!res.ok) {
      document.getElementById("credentials-error").textContent = (await res.json()).error;
      return;
    }
    await renderSyncPage();
  });

  document.getElementById("sync-btn").addEventListener("click", async () => {
    const params = new URLSearchParams({
      attachments: document.getElementById("opt-attachments").checked ? "1" : "0",
      refresh: document.getElementById("opt-refresh").checked ? "1" : "0",
    });
    const res = await fetch(`/api/sync?${params}`, { method: "POST" });
    if (res.status === 400) {
      document.getElementById("sync-status").textContent = (await res.json()).error;
      return;
    }
    await pollSync();
  });

  await pollSync();
}

async function pollSync() {
  clearTimeout(state.syncPollTimer);
  const job = await fetchJson("/api/sync");
  updateSyncBadge(job.status);

  const logEl = document.getElementById("sync-log");
  if (logEl) {
    const isAtBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
    logEl.textContent = job.logs.length ? job.logs.join("\n") : "Chưa có tác vụ nào.";
    if (isAtBottom) logEl.scrollTop = logEl.scrollHeight;

    document.getElementById("sync-btn").disabled = job.status === "running" || !state.isConnected;
    const statusText = {
      idle: "",
      running: `Đang đồng bộ từ ${formatDateTime(job.startedAt)}... Có thể chuyển trang, tác vụ vẫn chạy.`,
      done: `Hoàn tất lúc ${formatDateTime(job.finishedAt)}.`,
      failed: `Dừng lúc ${formatDateTime(job.finishedAt)} — xem nhật ký.`,
    };
    document.getElementById("sync-status").textContent = statusText[job.status];
  }

  if (state.lastSyncStatus === "running" && job.status !== "running") {
    await refreshTenants();
    renderDownloads();
  }
  state.lastSyncStatus = job.status;
  if (job.status === "running") state.syncPollTimer = setTimeout(pollSync, 1500);
}

// ---------- boot ----------
async function refreshTenants() {
  state.tenants = await fetchJson("/api/tenants");
  if (!state.tenants.includes(state.tenant)) state.tenant = state.tenants[0] ?? "";

  const select = document.getElementById("tenant-select");
  select.hidden = state.tenants.length < 2;
  select.innerHTML = state.tenants.map((t) => `<option ${t === state.tenant ? "selected" : ""}>${esc(t)}</option>`).join("");

  document.getElementById("org-name").textContent = state.tenant || "Xero Data Viewer";
  document.getElementById("org-initials").textContent = (state.tenant || "X")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  state.views = state.tenant ? await fetchJson(apiUrl("views")) : [];
  renderNav();
}

async function init() {
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  backdropEl.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());
  window.addEventListener("hashchange", handleRoute);
  document.getElementById("tenant-select").addEventListener("change", async (e) => {
    state.tenant = e.target.value;
    await refreshTenants();
    await handleRoute();
  });

  state.isConnected = (await fetchJson("/api/status")).isConnected;
  await refreshTenants();
  await handleRoute();
  if (location.hash !== "#/sync") await pollSync();
}

init().catch((err) => {
  mainEl.innerHTML = `<div class="empty-state">Lỗi: ${esc(err.message)}</div>`;
});
