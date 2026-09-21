# xero-export

A desktop tool that pulls your complete Xero accounting data, lets you browse it in a Xero-like web interface, and exports it as CSV, Excel, or a single self-contained HTML file with every attachment embedded.

Nothing runs on an external server: your data stays in the `data/` folder on your machine, and the web interface listens on `127.0.0.1` only.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer.
- An app on [Xero Developer](https://developer.xero.com/app/manage), type **Web app**, with redirect URI `http://localhost:3000/callback`.

## Running it

**Double-click `Xero Export.cmd`.** The first run installs dependencies, then opens http://localhost:3000 in your browser. Close the console window to stop the app.

No commands and no file editing needed. If you prefer a terminal, `npm install` followed by `npm run viewer` does the same thing.

Everything happens in the browser:

0. **First run**: the Connect & sync page asks for your **Client ID** and **Client Secret** (both on the Configuration tab of your Xero app). Save them and they are written to `.env` for you.
1. **Connect to Xero**: sign in and choose an organisation. To add more organisations, click **Reconnect / add organisation** and pick the next one.
2. **Start sync**: pulls the data. Optionally download attachments, or refetch everything from scratch.
3. **Download your data**, in three shapes:
   - `.zip`: CSVs in Xero export format plus the `attachments/` folder. Each view (Bills, Invoices, Contacts...) also has its own download button.
   - `.html`: one single file. Open it in a browser and click a row to see its PDF or image inline. Nothing to unzip, and you can send it to someone as-is.
   - `.xlsx`: one sheet per data type, images embedded in the rows, PDFs as clickable links (the links resolve only when the workbook sits next to the unzipped `attachments/` folder).

Port 3000 is required because it has to match the redirect URI registered with Xero.

`.env`, `tokens.json`, `data/` and `export/` are all in `.gitignore` and never reach the repository.

## Commands

| Command | What it does |
|---|---|
| `npm run viewer` | Starts the web interface on http://localhost:3000 (same as double-clicking `Xero Export.cmd`) |
| `npm run auth` | Signs in to Xero from the terminal |
| `npm run export` | Syncs data, fetching only what is missing |
| `npm run export -- --attachments` | Syncs and downloads attachments |
| `npm run export -- --refresh --attachments` | Refetches everything from Xero |
| `npm run csv` | Writes CSV, HTML, Excel and attachments into the `export/` folder |
| `npm run typecheck` | Runs the TypeScript checks |

## Project layout

```
src/
  server.ts      web server: OAuth, sync jobs, API, packaging downloads
  exporter.ts    calls the Xero API: paging, rate limits, attachments
  xero.ts        OAuth, token refresh, HTTP client
  config.ts      reads and writes .env so credentials can be set from the UI
  dataStore.ts   reads downloaded data and assembles the export bundle
  xeroFormat.ts  turns Xero JSON into CSV columns matching Xero's own exports
  htmlReport.ts  builds the self-contained .html file with embedded attachments
  excelReport.ts maps the export bundle onto worksheets
  xlsx.ts        writes .xlsx files (hand-rolled, no third-party library)
  views.ts       the list of views shown in the interface
  csvTables.ts   CSV helpers
  zip.ts         writes zip files using Node's built-in zlib
public/          the web interface (plain HTML/CSS/JS, no build step)
data/            downloaded JSON and attachments
export/          output of `npm run csv`
```

## What gets downloaded

Organisation, Accounts, TaxRates, TrackingCategories, Currencies, BrandingThemes, Users, Contacts, ContactGroups, Items, Invoices (both sales invoices and bills), CreditNotes, Quotes, PurchaseOrders, RepeatingInvoices, Payments, Prepayments, Overpayments, BatchPayments, BankTransactions, BankTransfers, ManualJournals, LinkedTransactions, Budgets, Trial Balance, Balance Sheet, and the attachments of every document that has them.

## Export format

CSVs follow Xero's own export files: one row per line item, dates as `dd/mm/yyyy`, tax codes resolved to tax rate names, statuses spelled as Xero spells them (`Awaiting Payment`).

Three ways to tell which document an attachment belongs to:

- The file name carries the document number and contact: `attachments/Bills/PTDK 5 - PEJABAT TANAH DAERAH KLUANG - PERMIT.jpeg`.
- `Attachments.csv` lists every file with its document number, contact, date, amount, status and a link to open it.
- The `AttachmentCount` and `AttachmentFiles` columns at the end of each row in the main CSV.

## Limits

- **Five organisations**: an uncertified Xero app is capped at 5 connections. Beyond that, ask Xero to raise the limit or put the app through certification.
- **Your own access**: you can only pull organisations your Xero user can open, and only what the granted scopes cover.
- **Journals**: new apps cannot request `accounting.journals.read`, so that endpoint returns 401. It needs the Advanced plan plus Xero's approval.
- **Rate limits**: 60 calls per minute and 5,000 per day *per organisation*. The tool paces itself and waits when throttled. If you hit the daily cap, run it again tomorrow — everything already downloaded is kept.
- **Not available through the API**: raw bank statement lines, detailed reconciliation state, invoice templates, files in the Xero file library that are not attached to a document, and Payroll/Projects/Assets (separate scopes, not implemented here).
- **Snapshot, not live data**: the numbers are whatever Xero returned at sync time.
- **Session**: the refresh token expires after 60 days of no use; reconnect from the UI when that happens.
- Xero's developer terms forbid using API data to train or fine-tune AI models.
