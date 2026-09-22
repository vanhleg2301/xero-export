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
  accounts: [],
  accountEdit: null,
  accountFilter: "",
  entries: [],
  journalLines: [],
  plFrom: "",
  plTo: "",
  bsAsOf: "",
  bankAccount: "",
  bankData: null,
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
const BOOKS_PAGES = [
  { id: "journal", label: "Journal" },
  { id: "bank", label: "Bank" },
  { id: "trial-balance", label: "Trial balance" },
  { id: "profit-and-loss", label: "Profit & loss" },
  { id: "balance-sheet", label: "Balance sheet" },
  { id: "accounts", label: "Chart of accounts" },
  { id: "settings", label: "Settings" },
];

function getRoute() {
  const hash = location.hash.replace(/^#\//, "");
  if (hash === "sync") return { area: "sync", page: "sync" };
  if (hash.startsWith("books")) return { area: "books", page: hash.split("/")[1] || "journal" };
  return { area: "data", page: hash || "home" };
}

function renderNav() {
  const nav = document.getElementById("nav");
  const route = getRoute();
  document.getElementById("area-data").classList.toggle("active", route.area !== "books");
  document.getElementById("area-books").classList.toggle("active", route.area === "books");

  if (!state.tenant) {
    nav.innerHTML = "";
    return;
  }

  if (route.area === "books") {
    nav.innerHTML = BOOKS_PAGES.map(
      (page) =>
        `<a class="nav-plain ${route.page === page.id ? "active" : ""}" href="#/books/${page.id}">${esc(page.label)}</a>`,
    ).join("");
    return;
  }

  nav.innerHTML = `<a class="nav-plain ${route.page === "home" ? "active" : ""}" href="#/home">Dashboard</a>` + GROUP_ORDER.map((group) => {
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
  const route = getRoute();
  document.activeElement?.blur();

  if (route.area === "books" && state.tenant) {
    state.view = null;
    renderNav();
    if (route.page === "bank") return renderBankPage();
    if (route.page === "accounts") return renderAccountsPage();
    if (route.page === "trial-balance") return renderTrialBalancePage();
    if (route.page === "profit-and-loss") return renderProfitAndLossPage();
    if (route.page === "balance-sheet") return renderBalanceSheetPage();
    if (route.page === "settings") return renderBooksSettingsPage();
    return renderJournalPage();
  }

  if (route.area === "sync" || !state.tenant) {
    state.view = null;
    renderNav();
    if (route.area !== "sync") {
      location.hash = "#/sync";
      return;
    }
    return renderSyncPage();
  }

  state.view = state.views.find((v) => v.id === route.page) ?? null;
  renderNav();
  if (!state.view) return renderHome();

  mainEl.innerHTML = `<div class="empty-state">Loading...</div>`;
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
        <a class="btn" href="${apiUrl("report")}">Offline viewer (.html)</a>
        <a class="btn" href="${apiUrl("excel")}">Excel (.xlsx)</a>
        <a class="btn primary" href="${apiUrl("download")}">Download all data (CSV + attachments)</a>
      </div>
    </div>
    <div class="summary">
      <div class="card"><div class="muted">Invoices owed to you</div><div class="big">${formatMoney(owed.due)} <small class="muted">${esc(owed.currency)}</small></div>
        <a href="#/sales-invoices">${owed.count} awaiting payment</a></div>
      <div class="card"><div class="muted">Bills you need to pay</div><div class="big">${formatMoney(toPay.due)} <small class="muted">${esc(toPay.currency)}</small></div>
        <a href="#/bills">${toPay.count} awaiting payment</a></div>
      <div class="card"><div class="muted">Documents with downloaded attachments</div><div class="big">${attachmentCount}</div>
        <a href="#/sync">Sync to download more attachments</a></div>
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
      <button class="btn primary" id="download-btn" ${state.records.length === 0 ? "disabled" : ""}>Download CSV + attachments (.zip)</button>
    </div>
    <div class="card">
      <div id="tabs"></div>
      <div class="toolbar">
        <input class="search" id="search" type="search" placeholder="Search by number, name, description..." />
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
  document.getElementById("row-count").textContent = `${rows.length} records`;

  const area = document.getElementById("table-area");
  if (rows.length === 0) {
    area.innerHTML = `<div class="empty-state">${state.records.length === 0 ? "No data for this view." : "No matching records."}</div>`;
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
              ? `<span title="${state.attachments[id].files.length} attachment(s)">${CLIP_ICON}</span>`
              : record.HasAttachments
                ? `<span class="missing" title="Has attachments in Xero that have not been downloaded">${CLIP_ICON}</span>`
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
      ? `<h3>Attachments</h3><div class="notice">This record has attachments in Xero that have not been downloaded yet. <a href="#/sync">Sync with attachments</a>.</div>`
      : "";
  }
  return `<h3>Attachments (${folder.files.length})</h3><div class="attachments">${folder.files
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
          <span class="links"><a href="${url}" target="_blank" rel="noopener">Open</a><a href="${url}" download="${esc(file)}">Download</a></span>
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
    <details class="raw"><summary>Raw data (JSON)</summary><pre>${esc(JSON.stringify(record, null, 2))}</pre></details>`;
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
      <button class="btn primary" id="download-btn" ${report ? "" : "disabled"}>Download CSV (.zip)</button>
    </div>
    <div class="card">
      ${
        report
          ? `<div class="report-titles">${(report.ReportTitles ?? []).map((t) => `<div>${esc(t)}</div>`).join("")}</div>
            <div class="table-wrap"><table class="report">
              ${header ? `<thead><tr>${header.Cells.map((c, i) => `<th class="${i ? "right" : ""}">${esc(c.Value)}</th>`).join("")}</tr></thead>` : ""}
              <tbody>${renderReportRows(report.Rows ?? [])}</tbody>
            </table></div>`
          : `<div class="empty-state">No report yet.</div>`
      }
    </div>`;

  document.getElementById("download-btn").addEventListener("click", () => {
    location.href = apiUrl(`views/${view.id}/download`);
  });
}

// ---------- books: chart of accounts ----------
const ACCOUNT_CLASSES = ["asset", "liability", "equity", "revenue", "expense"];

async function renderAccountsPage() {
  const data = await fetchJson(apiUrl("books/accounts"));
  state.accounts = data.accounts;
  state.accountEdit = null;

  mainEl.innerHTML = `
    <div class="page-head">
      <div><div class="crumb">Books</div><h1>Chart of accounts</h1></div>
      <div class="actions">
        <button class="btn" id="seed-accounts">Import from Xero data</button>
        <button class="btn primary" id="new-account">New account</button>
      </div>
    </div>
    <p class="muted">The accounts your own ledger posts to. Imported from the Xero data you synced, then yours to edit — changes here never touch Xero.</p>
    <div class="card">
      <div class="toolbar">
        <input class="search" id="account-search" type="search" placeholder="Search code or name..." />
        <span class="muted" id="account-count"></span>
      </div>
      <div class="table-wrap" id="accounts-table"></div>
    </div>`;

  document.getElementById("seed-accounts").addEventListener("click", seedAccounts);
  document.getElementById("new-account").addEventListener("click", () => openAccountForm(null));
  document.getElementById("account-search").addEventListener("input", (event) => {
    state.accountFilter = event.target.value;
    renderAccountsTable();
  });
  renderAccountsTable();
}

async function seedAccounts() {
  const res = await fetch(apiUrl("books/accounts/seed"), { method: "POST" });
  const data = await res.json();
  state.accounts = data.accounts ?? state.accounts;
  renderAccountsTable();
  document.getElementById("account-count").textContent =
    data.added > 0 ? `${data.added} accounts imported` : "Nothing new to import";
}

function renderAccountsTable() {
  const needle = state.accountFilter.toLowerCase();
  const rows = state.accounts.filter(
    (a) => !needle || `${a.code} ${a.name} ${a.type}`.toLowerCase().includes(needle),
  );
  const area = document.getElementById("accounts-table");
  const countEl = document.getElementById("account-count");
  if (countEl) countEl.textContent = `${rows.length} accounts`;

  if (rows.length === 0) {
    area.innerHTML = `<div class="empty-state">${
      state.accounts.length === 0
        ? 'No accounts yet. Click "Import from Xero data" to start from the accounts you synced.'
        : "No account matches that search."
    }</div>`;
    return;
  }

  area.innerHTML = `
    <table class="data">
      <thead><tr><th>Code</th><th>Name</th><th>Class</th><th>Type</th><th>Tax rate</th><th>Status</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (a) => `<tr data-id="${esc(a.id)}">
              <td>${esc(a.code)}</td>
              <td>${esc(a.name)}${a.description ? `<div class="muted">${esc(a.description)}</div>` : ""}</td>
              <td>${esc(a.accountClass)}</td>
              <td>${esc(a.type)}</td>
              <td>${esc(a.taxRate)}</td>
              <td>${a.isActive ? '<span class="badge active">Active</span>' : '<span class="badge archived">Archived</span>'}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  area.querySelectorAll("tbody tr").forEach((tr) =>
    tr.addEventListener("click", () => openAccountForm(state.accounts.find((a) => a.id === tr.dataset.id))),
  );
}

function openAccountForm(account) {
  state.accountEdit = account ?? null;
  document.getElementById("drawer-crumb").textContent = "Books › Chart of accounts";
  document.getElementById("drawer-title").textContent = account ? `${account.code} ${account.name}` : "New account";
  document.getElementById("drawer-body").innerHTML = `
    <label class="field">Code<input id="acc-code" type="text" value="${esc(account?.code ?? "")}" /></label>
    <label class="field">Name<input id="acc-name" type="text" value="${esc(account?.name ?? "")}" /></label>
    <label class="field">Class
      <select id="acc-class">
        ${ACCOUNT_CLASSES.map(
          (c) => `<option value="${c}" ${account?.accountClass === c ? "selected" : ""}>${c}</option>`,
        ).join("")}
      </select>
    </label>
    <label class="field">Type<input id="acc-type" type="text" value="${esc(account?.type ?? "")}" placeholder="Current Asset, Expense, Bank..." /></label>
    <label class="field">Tax rate<input id="acc-tax" type="text" value="${esc(account?.taxRate ?? "")}" /></label>
    <label class="field">Description<input id="acc-desc" type="text" value="${esc(account?.description ?? "")}" /></label>
    <label class="check"><input id="acc-active" type="checkbox" ${account?.isActive !== false ? "checked" : ""} /><span>Active</span></label>
    <label class="check"><input id="acc-bank" type="checkbox" ${account?.isBankAccount ? "checked" : ""} /><span>Bank account<small>Statement lines can be imported against it.</small></span></label>
    <div class="actions"><button class="btn primary" id="acc-save">Save</button></div>
    <p class="muted" id="acc-error"></p>`;

  document.getElementById("acc-save").addEventListener("click", saveAccount);
  drawerEl.hidden = false;
  backdropEl.hidden = false;
}

async function saveAccount() {
  const payload = {
    id: state.accountEdit?.id,
    code: document.getElementById("acc-code").value,
    name: document.getElementById("acc-name").value,
    accountClass: document.getElementById("acc-class").value,
    type: document.getElementById("acc-type").value,
    taxRate: document.getElementById("acc-tax").value,
    description: document.getElementById("acc-desc").value,
    isActive: document.getElementById("acc-active").checked,
    isBankAccount: document.getElementById("acc-bank").checked,
  };
  const res = await fetch(apiUrl("books/accounts"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    document.getElementById("acc-error").textContent = data.error;
    return;
  }
  state.accounts = data.accounts;
  closeDrawer();
  renderAccountsTable();
}

// ---------- books: journal ----------
async function renderJournalPage() {
  const data = await fetchJson(apiUrl("books/journal"));
  state.entries = data.entries;

  mainEl.innerHTML = `
    <div class="page-head">
      <div><div class="crumb">Accounting</div><h1>Journal</h1></div>
      <div class="actions">
        <button class="btn" id="import-docs">Post Xero documents</button>
        <button class="btn primary" id="new-entry">New journal entry</button>
      </div>
    </div>
    <p class="muted">Every posted entry balances: total debits equal total credits. Posted entries are never edited — void one and it posts the mirror image.</p>
    <div class="card">
      <div class="toolbar"><span class="muted" id="journal-note">${state.entries.length} entries</span></div>
      <div class="table-wrap" id="journal-table"></div>
    </div>`;

  document.getElementById("import-docs").addEventListener("click", importDocuments);
  document.getElementById("new-entry").addEventListener("click", openEntryForm);
  renderJournalTable();
}

function renderJournalTable() {
  const area = document.getElementById("journal-table");
  if (state.entries.length === 0) {
    area.innerHTML = `<div class="empty-state">No entries yet. Click "Post Xero documents" to turn the invoices, bills and payments you synced into journal entries.</div>`;
    return;
  }

  const rows = [...state.entries].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  area.innerHTML = `
    <table class="data">
      <thead><tr><th>Date</th><th>Entry</th><th>Narration</th><th>Source</th><th class="right">Total</th><th>Status</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (entry) => `<tr data-id="${esc(entry.id)}">
              <td>${esc(formatDate(entry.date))}</td>
              <td>${esc(entry.number)}</td>
              <td>${esc(entry.narration)}</td>
              <td>${esc(entry.sourceType)}</td>
              <td class="right">${formatMoney(entry.total)}</td>
              <td>${entry.status === "posted" ? '<span class="badge paid">Posted</span>' : '<span class="badge voided">Voided</span>'}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  area.querySelectorAll("tbody tr").forEach((tr) =>
    tr.addEventListener("click", () => openEntryDetail(state.entries.find((e) => e.id === tr.dataset.id))),
  );
}

async function importDocuments() {
  const res = await fetch(apiUrl("books/journal/import"), { method: "POST" });
  const data = await res.json();
  const note = document.getElementById("journal-note");
  if (!res.ok) {
    note.textContent = data.error;
    return;
  }
  state.entries = data.entries;
  renderJournalTable();
  note.textContent =
    `${data.posted} posted, ${data.skipped} skipped` + (data.failures.length ? ` — ${data.failures.length} could not post: ${data.failures[0]}` : "");
}

function renderEntryLines(entry) {
  return `
    <table class="lines">
      <thead><tr><th>Account</th><th>Description</th><th class="right">Debit</th><th class="right">Credit</th></tr></thead>
      <tbody>
        ${entry.lines
          .map(
            (line) => `<tr>
              <td>${esc(line.accountCode)} ${esc(line.accountName)}</td>
              <td>${esc(line.description)}</td>
              <td class="right">${line.debit ? formatMoney(line.debit) : ""}</td>
              <td class="right">${line.credit ? formatMoney(line.credit) : ""}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="right">${formatMoney(entry.total)}</td><td class="right">${formatMoney(entry.total)}</td></tr></tfoot>
    </table>`;
}

function openEntryDetail(entry) {
  document.getElementById("drawer-crumb").textContent = `Accounting › Journal › ${entry.number}`;
  document.getElementById("drawer-title").textContent = entry.narration || entry.number;
  document.getElementById("drawer-body").innerHTML = `
    ${renderMeta([
      ["Date", esc(formatDate(entry.date))],
      ["Source", esc(entry.sourceType + (entry.sourceLabel ? ` · ${entry.sourceLabel}` : ""))],
      ["Status", entry.status === "posted" ? '<span class="badge paid">Posted</span>' : '<span class="badge voided">Voided</span>'],
    ])}
    ${renderEntryLines(entry)}
    ${entry.status === "posted" ? '<div class="actions"><button class="btn" id="void-entry">Void this entry</button></div>' : ""}
    <p class="muted" id="entry-note"></p>`;

  document.getElementById("void-entry")?.addEventListener("click", async () => {
    const res = await fetch(apiUrl(`books/journal/${entry.id}/void`), { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById("entry-note").textContent = data.error;
      return;
    }
    state.entries = data.entries;
    closeDrawer();
    renderJournalTable();
    document.getElementById("journal-note").textContent = `${entry.number} voided by ${data.reversal.number}`;
  });

  drawerEl.hidden = false;
  backdropEl.hidden = false;
}

async function openEntryForm() {
  if (state.accounts.length === 0) state.accounts = (await fetchJson(apiUrl("books/accounts"))).accounts;
  state.journalLines = [
    { accountCode: "", description: "", debit: "", credit: "" },
    { accountCode: "", description: "", debit: "", credit: "" },
  ];

  document.getElementById("drawer-crumb").textContent = "Accounting › Journal";
  document.getElementById("drawer-title").textContent = "New journal entry";
  document.getElementById("drawer-body").innerHTML = `
    <label class="field">Date<input id="je-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
    <label class="field">Narration<input id="je-narration" type="text" placeholder="What is this entry for?" /></label>
    <div id="je-lines"></div>
    <div class="actions">
      <button class="btn" id="je-add-line">Add line</button>
      <button class="btn primary" id="je-save">Post entry</button>
    </div>
    <p class="muted" id="je-note"></p>`;

  document.getElementById("je-add-line").addEventListener("click", () => {
    readEntryForm();
    state.journalLines.push({ accountCode: "", description: "", debit: "", credit: "" });
    renderEntryForm();
  });
  document.getElementById("je-save").addEventListener("click", saveEntry);

  renderEntryForm();
  drawerEl.hidden = false;
  backdropEl.hidden = false;
}

function renderEntryForm() {
  const options = state.accounts
    .filter((a) => a.isActive)
    .map((a) => `<option value="${esc(a.code)}">${esc(a.code)} — ${esc(a.name)}</option>`)
    .join("");

  document.getElementById("je-lines").innerHTML = `
    <table class="lines je-form">
      <thead><tr><th>Account</th><th>Description</th><th class="right">Debit</th><th class="right">Credit</th></tr></thead>
      <tbody>
        ${state.journalLines
          .map(
            (line, i) => `<tr>
              <td><select data-field="accountCode" data-i="${i}"><option value="">Select…</option>${options}</select></td>
              <td><input data-field="description" data-i="${i}" type="text" value="${esc(line.description)}" /></td>
              <td><input data-field="debit" data-i="${i}" type="number" step="0.01" value="${esc(line.debit)}" /></td>
              <td><input data-field="credit" data-i="${i}" type="number" step="0.01" value="${esc(line.credit)}" /></td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  document.querySelectorAll("#je-lines select").forEach((select) => {
    select.value = state.journalLines[Number(select.dataset.i)].accountCode;
  });
  updateEntryTotals();
  document.querySelectorAll("#je-lines input, #je-lines select").forEach((field) =>
    field.addEventListener("input", () => {
      readEntryForm();
      updateEntryTotals();
    }),
  );
}

function readEntryForm() {
  document.querySelectorAll("#je-lines [data-field]").forEach((field) => {
    state.journalLines[Number(field.dataset.i)][field.dataset.field] = field.value;
  });
}

function updateEntryTotals() {
  const sum = (key) => state.journalLines.reduce((total, line) => total + (Number(line[key]) || 0), 0);
  const debit = sum("debit");
  const credit = sum("credit");
  const note = document.getElementById("je-note");
  note.textContent = `Debits ${formatMoney(debit)} · Credits ${formatMoney(credit)}` +
    (Math.abs(debit - credit) < 0.005 && debit > 0 ? " · balanced" : " · out of balance");
  note.className = Math.abs(debit - credit) < 0.005 && debit > 0 ? "good" : "muted";
}

async function saveEntry() {
  readEntryForm();
  const payload = {
    date: document.getElementById("je-date").value,
    narration: document.getElementById("je-narration").value,
    lines: state.journalLines
      .filter((line) => line.accountCode && (Number(line.debit) || Number(line.credit)))
      .map((line) => ({
        accountCode: line.accountCode,
        description: line.description,
        debit: Number(line.debit) || 0,
        credit: Number(line.credit) || 0,
      })),
  };
  const res = await fetch(apiUrl("books/journal"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    document.getElementById("je-note").textContent = data.error;
    document.getElementById("je-note").className = "muted";
    return;
  }
  state.entries = data.entries;
  closeDrawer();
  renderJournalTable();
  document.getElementById("journal-note").textContent = `${data.entry.number} posted`;
}

// ---------- books: trial balance ----------
async function renderTrialBalancePage() {
  const data = await fetchJson(apiUrl("books/trial-balance"));

  mainEl.innerHTML = `
    <div class="page-head">
      <div><div class="crumb">Accounting</div><h1>Trial balance</h1></div>
      <div class="${data.isBalanced ? "balance-ok" : "balance-bad"}">
        ${data.isBalanced ? "In balance" : "Out of balance"}
      </div>
    </div>
    <p class="muted">Every posted journal line, summed per account. ${data.entryCount} entries included.</p>
    <div class="card">
      <div class="table-wrap">
        ${
          data.rows.length === 0
            ? '<div class="empty-state">Nothing posted yet.</div>'
            : `<table class="data">
                <thead><tr><th>Code</th><th>Account</th><th>Class</th><th class="right">Debit</th><th class="right">Credit</th></tr></thead>
                <tbody>
                  ${data.rows
                    .map(
                      (row) => `<tr>
                        <td>${esc(row.code)}</td>
                        <td>${esc(row.name)}</td>
                        <td>${esc(row.accountClass)}</td>
                        <td class="right">${row.debit ? formatMoney(row.debit) : ""}</td>
                        <td class="right">${row.credit ? formatMoney(row.credit) : ""}</td>
                      </tr>`,
                    )
                    .join("")}
                </tbody>
                <tfoot><tr><td colspan="3">Total</td><td class="right">${formatMoney(data.totalDebit)}</td><td class="right">${formatMoney(data.totalCredit)}</td></tr></tfoot>
              </table>`
        }
      </div>
    </div>`;
}

// ---------- books: bank reconciliation ----------
async function renderBankPage() {
  const params = new URLSearchParams();
  if (state.bankAccount) params.set("account", state.bankAccount);
  const data = await fetchJson(apiUrl(`books/bank?${params}`));
  state.bankData = data;
  state.bankAccount = data.selected;

  if (data.accounts.length === 0) {
    mainEl.innerHTML = `
      <div class="page-head"><div><div class="crumb">Accounting</div><h1>Bank</h1></div></div>
      <div class="card"><div class="empty-state">
        No bank account yet. Open <a href="#/books/accounts">Chart of accounts</a>, edit the account your bank statement belongs to, and tick "Bank account".
      </div></div>`;
    return;
  }

  const summary = data.summary;
  mainEl.innerHTML = `
    <div class="page-head">
      <div><div class="crumb">Accounting</div><h1>Bank</h1></div>
      <div class="actions">
        <label class="inline-field">Account
          <select id="bank-account">
            ${data.accounts.map((a) => `<option value="${esc(a.code)}" ${a.code === data.selected ? "selected" : ""}>${esc(a.code)} — ${esc(a.name)}</option>`).join("")}
          </select>
        </label>
        <button class="btn" id="add-line">Add line</button>
        <button class="btn primary" id="import-statement">Import statement (.csv)</button>
        <input type="file" id="statement-file" accept=".csv,text/csv" hidden />
      </div>
    </div>
    <div class="summary">
      <div class="card"><div class="muted">Statement balance</div><div class="big">${formatMoney(summary.statementBalance)}</div>
        <span class="muted">Sum of imported lines</span></div>
      <div class="card"><div class="muted">Ledger balance</div><div class="big">${formatMoney(summary.ledgerBalance)}</div>
        <span class="muted">What the journal says</span></div>
      <div class="card"><div class="muted">Left to reconcile</div><div class="big">${summary.unreconciledCount}</div>
        <span class="${Math.abs(summary.difference) < 0.005 ? "good" : "muted"}">Difference ${formatMoney(summary.difference)}</span></div>
    </div>
    <div class="card"><div class="table-wrap" id="bank-table"></div></div>
    <p class="muted" id="bank-note"></p>`;

  document.getElementById("bank-account").addEventListener("change", (event) => {
    state.bankAccount = event.target.value;
    renderBankPage();
  });
  document.getElementById("import-statement").addEventListener("click", () => document.getElementById("statement-file").click());
  document.getElementById("statement-file").addEventListener("change", importStatement);
  document.getElementById("add-line").addEventListener("click", openStatementLineForm);
  renderBankTable();
}

function renderBankTable() {
  const area = document.getElementById("bank-table");
  const lines = state.bankData.lines;
  if (lines.length === 0) {
    area.innerHTML = `<div class="empty-state">No statement lines yet. Import a CSV from your bank, or add a line by hand to try it out.</div>`;
    return;
  }

  area.innerHTML = `
    <table class="data">
      <thead><tr><th>Date</th><th>Description</th><th class="right">Money in</th><th class="right">Money out</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${lines
          .map(
            (line) => `<tr>
              <td>${esc(formatDate(line.date))}</td>
              <td>${esc(line.description)}${line.reference ? `<div class="muted">${esc(line.reference)}</div>` : ""}</td>
              <td class="right">${line.amount > 0 ? formatMoney(line.amount) : ""}</td>
              <td class="right">${line.amount < 0 ? formatMoney(-line.amount) : ""}</td>
              <td>${line.status === "reconciled" ? '<span class="badge paid">Reconciled</span>' : '<span class="badge draft">To do</span>'}</td>
              <td class="right">${
                line.status === "reconciled"
                  ? `<button class="btn small" data-unmatch="${esc(line.id)}">Undo</button>`
                  : `${line.suggestions
                      .slice(0, 1)
                      .map(
                        (s) => `<button class="btn small primary" data-match="${esc(line.id)}" data-entry="${esc(s.entryId)}">Match ${esc(s.number)}</button>`,
                      )
                      .join("")}
                     <button class="btn small" data-code="${esc(line.id)}">Code it</button>`
              }</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  area.querySelectorAll("[data-match]").forEach((button) =>
    button.addEventListener("click", () => postBankAction(`lines/${button.dataset.match}/match`, { journalEntryId: button.dataset.entry })),
  );
  area.querySelectorAll("[data-unmatch]").forEach((button) =>
    button.addEventListener("click", () => postBankAction(`lines/${button.dataset.unmatch}/unmatch`, {})),
  );
  area.querySelectorAll("[data-code]").forEach((button) =>
    button.addEventListener("click", () => openCodeLineForm(state.bankData.lines.find((l) => l.id === button.dataset.code))),
  );
}

async function postBankAction(path, body) {
  const res = await fetch(apiUrl(`books/bank/${path}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    document.getElementById("bank-note").textContent = data.error;
    return false;
  }
  await renderBankPage();
  return true;
}

async function importStatement(event) {
  const file = event.target.files[0];
  if (!file) return;
  const csv = await file.text();
  const res = await fetch(apiUrl("books/bank/import"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bankAccountCode: state.bankAccount, csv }),
  });
  const data = await res.json();
  if (!res.ok) {
    document.getElementById("bank-note").textContent = data.error;
    return;
  }
  await renderBankPage();
  document.getElementById("bank-note").textContent = `${data.added} lines imported, ${data.skipped} skipped`;
}

function openStatementLineForm() {
  document.getElementById("drawer-crumb").textContent = "Accounting › Bank";
  document.getElementById("drawer-title").textContent = "Add statement line";
  document.getElementById("drawer-body").innerHTML = `
    <label class="field">Date<input id="sl-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
    <label class="field">Description<input id="sl-desc" type="text" /></label>
    <label class="field">Reference<input id="sl-ref" type="text" /></label>
    <label class="field">Amount<input id="sl-amount" type="number" step="0.01" placeholder="Minus for money out" /></label>
    <div class="actions"><button class="btn primary" id="sl-save">Add line</button></div>
    <p class="muted" id="sl-note"></p>`;

  document.getElementById("sl-save").addEventListener("click", async () => {
    const res = await fetch(apiUrl("books/bank/lines"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bankAccountCode: state.bankAccount,
        date: document.getElementById("sl-date").value,
        description: document.getElementById("sl-desc").value,
        reference: document.getElementById("sl-ref").value,
        amount: Number(document.getElementById("sl-amount").value),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById("sl-note").textContent = data.error;
      return;
    }
    closeDrawer();
    renderBankPage();
  });

  drawerEl.hidden = false;
  backdropEl.hidden = false;
}

async function openCodeLineForm(line) {
  if (state.accounts.length === 0) state.accounts = (await fetchJson(apiUrl("books/accounts"))).accounts;
  const isMoneyIn = line.amount > 0;

  document.getElementById("drawer-crumb").textContent = "Accounting › Bank";
  document.getElementById("drawer-title").textContent = line.description || "Statement line";
  document.getElementById("drawer-body").innerHTML = `
    ${renderMeta([
      ["Date", esc(formatDate(line.date))],
      [isMoneyIn ? "Money in" : "Money out", formatMoney(Math.abs(line.amount))],
      ["Reference", esc(line.reference)],
    ])}
    ${
      line.suggestions.length > 0
        ? `<h3>Suggested matches</h3>
           <table class="lines"><tbody>${line.suggestions
             .map(
               (s) => `<tr>
                 <td>${esc(s.number)} · ${esc(formatDate(s.date))}<div class="muted">${esc(s.narration)}</div></td>
                 <td class="right">${formatMoney(s.amount)}</td>
                 <td class="right"><button class="btn small primary" data-match-entry="${esc(s.entryId)}">Match</button></td>
               </tr>`,
             )
             .join("")}</tbody></table>`
        : ""
    }
    <h3>Or code it to an account</h3>
    <p class="muted">Posts ${isMoneyIn ? "a debit to the bank and a credit to" : "a credit to the bank and a debit to"} the account you pick, then marks the line reconciled.</p>
    <label class="field">Account
      <select id="code-account">
        <option value="">Select…</option>
        ${state.accounts.filter((a) => a.isActive && a.code !== line.bankAccountCode).map((a) => `<option value="${esc(a.code)}">${esc(a.code)} — ${esc(a.name)}</option>`).join("")}
      </select>
    </label>
    <label class="field">Description<input id="code-desc" type="text" value="${esc(line.description)}" /></label>
    <div class="actions"><button class="btn primary" id="code-save">Post and reconcile</button></div>
    <p class="muted" id="code-note"></p>`;

  document.querySelectorAll("[data-match-entry]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (await postBankAction(`lines/${line.id}/match`, { journalEntryId: button.dataset.matchEntry })) closeDrawer();
    }),
  );

  document.getElementById("code-save").addEventListener("click", async () => {
    const res = await fetch(apiUrl(`books/bank/lines/${line.id}/create`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountCode: document.getElementById("code-account").value,
        description: document.getElementById("code-desc").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById("code-note").textContent = data.error;
      return;
    }
    closeDrawer();
    renderBankPage();
  });

  drawerEl.hidden = false;
  backdropEl.hidden = false;
}

// ---------- books: financial reports ----------
function renderReportSection(section, options = {}) {
  return `
    <tbody>
      <tr class="section-head"><td colspan="2">${esc(section.title)}</td></tr>
      ${
        section.lines.length === 0
          ? '<tr><td colspan="2" class="muted">Nothing posted</td></tr>'
          : section.lines
              .map(
                (line) => `<tr>
                  <td>${line.code ? `<span class="muted">${esc(line.code)}</span> ` : ""}${esc(line.name)}</td>
                  <td class="right">${formatMoney(line.amount)}</td>
                </tr>`,
              )
              .join("")
      }
      <tr class="section-total"><td>Total ${esc(section.title.toLowerCase())}</td><td class="right">${formatMoney(section.total)}</td></tr>
      ${options.spacer === false ? "" : '<tr class="spacer"><td colspan="2"></td></tr>'}
    </tbody>`;
}

async function renderProfitAndLossPage() {
  const params = new URLSearchParams();
  if (state.plFrom) params.set("from", state.plFrom);
  if (state.plTo) params.set("to", state.plTo);
  const data = await fetchJson(apiUrl(`books/profit-and-loss?${params}`));
  state.plFrom = data.from;
  state.plTo = data.to;

  mainEl.innerHTML = `
    <div class="page-head">
      <div><div class="crumb">Accounting</div><h1>Profit &amp; loss</h1></div>
      <div class="actions">
        <label class="inline-field">From <input type="date" id="pl-from" value="${esc(data.from)}" /></label>
        <label class="inline-field">To <input type="date" id="pl-to" value="${esc(data.to)}" /></label>
      </div>
    </div>
    <div class="card report-card">
      <table class="data report">
        ${renderReportSection(data.revenue)}
        ${renderReportSection(data.expenses)}
        <tbody>
          <tr class="grand-total"><td>Net ${data.netProfit >= 0 ? "profit" : "loss"}</td><td class="right">${formatMoney(data.netProfit)}</td></tr>
        </tbody>
      </table>
    </div>`;

  const reload = () => {
    state.plFrom = document.getElementById("pl-from").value;
    state.plTo = document.getElementById("pl-to").value;
    renderProfitAndLossPage();
  };
  document.getElementById("pl-from").addEventListener("change", reload);
  document.getElementById("pl-to").addEventListener("change", reload);
}

async function renderBalanceSheetPage() {
  const params = new URLSearchParams();
  if (state.bsAsOf) params.set("asOf", state.bsAsOf);
  const data = await fetchJson(apiUrl(`books/balance-sheet?${params}`));
  state.bsAsOf = data.asOf;

  mainEl.innerHTML = `
    <div class="page-head">
      <div><div class="crumb">Accounting</div><h1>Balance sheet</h1></div>
      <div class="actions">
        <label class="inline-field">As at <input type="date" id="bs-date" value="${esc(data.asOf)}" /></label>
        <div class="${data.isBalanced ? "balance-ok" : "balance-bad"}">${data.isBalanced ? "In balance" : "Out of balance"}</div>
      </div>
    </div>
    <div class="card report-card">
      <table class="data report">
        ${renderReportSection(data.assets)}
        ${renderReportSection(data.liabilities)}
        ${renderReportSection(data.equity)}
        <tbody>
          <tr class="grand-total"><td>Total liabilities and equity</td><td class="right">${formatMoney(data.totalLiabilitiesAndEquity)}</td></tr>
        </tbody>
      </table>
    </div>
    <p class="muted">Profit is not held on an account: earnings before this financial year show as retained earnings, and this year's result shows on its own line.</p>`;

  document.getElementById("bs-date").addEventListener("change", (event) => {
    state.bsAsOf = event.target.value;
    renderBalanceSheetPage();
  });
}

// ---------- books: settings ----------
async function renderBooksSettingsPage() {
  const { settings } = await fetchJson(apiUrl("books/settings"));
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  mainEl.innerHTML = `
    <div class="page-head"><div><div class="crumb">Accounting</div><h1>Settings</h1></div></div>
    <div class="sync-grid">
      <div class="card">
        <h3>Financial year</h3>
        <p class="muted">Sets where the balance sheet splits this year's earnings from retained earnings.</p>
        <label class="field">Year ends on
          <select id="fy-month">
            ${months.map((month, i) => `<option value="${i + 1}" ${settings.financialYearEndMonth === i + 1 ? "selected" : ""}>${month}</option>`).join("")}
          </select>
        </label>
        <label class="field">Day<input id="fy-day" type="number" min="1" max="31" value="${settings.financialYearEndDay}" /></label>
        <label class="field">Base currency<input id="base-currency" type="text" value="${esc(settings.baseCurrency)}" placeholder="SGD, MYR..." /></label>
      </div>
      <div class="card">
        <h3>Lock date</h3>
        <p class="muted">Nothing can be posted on or before this date — set it after you file a period so filed numbers cannot move. Leave empty for no lock.</p>
        <label class="field">Books locked up to<input id="lock-date" type="date" value="${esc(settings.lockDate)}" /></label>
        <div class="actions"><button class="btn primary" id="save-settings">Save settings</button></div>
        <p class="muted" id="settings-note"></p>
      </div>
    </div>`;

  document.getElementById("save-settings").addEventListener("click", async () => {
    const res = await fetch(apiUrl("books/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        financialYearEndMonth: Number(document.getElementById("fy-month").value),
        financialYearEndDay: Number(document.getElementById("fy-day").value),
        lockDate: document.getElementById("lock-date").value,
        baseCurrency: document.getElementById("base-currency").value,
      }),
    });
    const data = await res.json();
    document.getElementById("settings-note").textContent = res.ok ? "Saved." : data.error;
  });
}

// ---------- sync page ----------
function formatDateTime(ms) {
  return ms ? new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
}

function updateSyncBadge(syncStatus) {
  const dot = document.getElementById("sync-dot");
  dot.className = `dot ${syncStatus === "running" ? "running" : syncStatus === "failed" ? "error" : state.isConnected ? "ok" : ""}`;
  document.getElementById("sync-label").textContent = syncStatus === "running" ? "Syncing..." : "Connect & sync";
}

function renderDownloads() {
  const el = document.getElementById("downloads");
  if (!el) return;
  el.innerHTML = state.tenants.length
    ? state.tenants
        .map(
          (t) => `<div class="download-row"><strong>${esc(t)}</strong>
            <span class="actions">
              <a class="btn" href="/api/tenants/${encodeURIComponent(t)}/report">Offline viewer (.html)</a>
              <a class="btn" href="/api/tenants/${encodeURIComponent(t)}/excel">Excel (.xlsx)</a>
              <a class="btn primary" href="/api/tenants/${encodeURIComponent(t)}/download">CSV + attachments (.zip)</a>
            </span></div>`,
        )
        .join("")
    : `<p class="muted">No data yet. Connect to Xero, then click "Start sync".</p>`;
}

async function renderSyncPage() {
  const status = await fetchJson("/api/status");
  state.isConnected = status.isConnected;

  mainEl.innerHTML = `
    <div class="page-head"><div><div class="crumb">Xero</div><h1>Connect &amp; sync</h1></div></div>
    <div class="sync-grid">
      <div class="card">
        <h3>1. Connect to Xero</h3>
        ${
          status.hasCredentials
            ? ""
            : `<div class="notice">
                 <b>No Xero app configured.</b> Go to <a href="https://developer.xero.com/app/manage" target="_blank" rel="noopener">developer.xero.com</a>,
                 create a <b>Web app</b> with redirect URI <code>${esc(location.origin)}/callback</code>, then paste its Client ID and Client Secret here.
               </div>
               <label class="field">Client ID<input id="client-id" type="text" autocomplete="off" /></label>
               <label class="field">Client Secret<input id="client-secret" type="password" autocomplete="off" /></label>
               <div class="actions"><button class="btn primary" id="save-credentials">Save</button></div>
               <p class="muted" id="credentials-error"></p>`
        }
        <div class="status-line"><span class="dot ${status.isConnected ? "ok" : ""}"></span>${status.isConnected ? "Connected" : "Not connected"}</div>
        ${
          status.isConnected
            ? `<ul class="org-list">${status.connections.map((c) => `<li>${esc(c.tenantName)}</li>`).join("")}</ul>
               <p class="muted">This session stays valid until about ${esc(formatDateTime(status.refreshTokenExpiresAt))}, and is renewed on every sync.</p>`
            : `<p class="muted">Sign in to Xero and pick the organisation you want to pull data from.</p>`
        }
        ${
          status.hasCredentials
            ? `<div class="actions">
                 <a class="btn ${status.isConnected ? "" : "primary"}" href="/auth/connect">${status.isConnected ? "Reconnect / add organisation" : "Connect to Xero"}</a>
               </div>`
            : ""
        }
      </div>

      <div class="card">
        <h3>2. Sync data</h3>
        <label class="check"><input type="checkbox" id="opt-attachments" checked />
          <span>Download attachments<small>Invoices, bills, purchase orders, bank transactions and so on. Files already downloaded are skipped.</small></span></label>
        <label class="check"><input type="checkbox" id="opt-refresh" ${state.tenants.length ? "" : "disabled"} />
          <span>Refetch everything<small>Leave unchecked to fetch only what is missing and continue the previous run.</small></span></label>
        <div class="actions"><button class="btn primary" id="sync-btn" disabled>Start sync</button></div>
        <p class="muted" id="sync-status"></p>
      </div>

      <div class="card">
        <h3>3. Download your data</h3>
        <p class="muted">A .zip with CSVs in Xero export format (Invoices, Bills, Contacts and so on) plus the attachments folder. <code>Attachments.csv</code> lists which document each file belongs to, and file names carry the document number and contact name.</p>
        <p class="muted">The <b>.html</b> file is a single file holding every table and every attachment: open it in a browser and click a row to see the PDF or image inline, no unzipping needed. The <b>.xlsx</b> file puts each data type on its own sheet, shows images inline and links to PDFs (keep it next to the unzipped attachments folder).</p>
        <div id="downloads"></div>
      </div>
    </div>

    <div class="card padded">
      <h3>Sync log</h3>
      <pre class="log" id="sync-log">No sync has run yet.</pre>
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
    logEl.textContent = job.logs.length ? job.logs.join("\n") : "No sync has run yet.";
    if (isAtBottom) logEl.scrollTop = logEl.scrollHeight;

    document.getElementById("sync-btn").disabled = job.status === "running" || !state.isConnected;
    const statusText = {
      idle: "",
      running: `Syncing since ${formatDateTime(job.startedAt)}. You can browse other pages, it keeps running.`,
      done: `Finished at ${formatDateTime(job.finishedAt)}.`,
      failed: `Stopped at ${formatDateTime(job.finishedAt)} — check the log.`,
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
  mainEl.innerHTML = `<div class="empty-state">Error: ${esc(err.message)}</div>`;
});
