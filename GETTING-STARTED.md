# Exporting your own Xero data

This tool pulls a complete copy of a Xero organisation — invoices, bills, contacts, chart of
accounts, reports and every attachment — and saves it on your computer as CSV, Excel, or a
single HTML file you can open in a browser.

**It runs entirely on your machine.** The web page it opens is served from your own computer
(`localhost`), nothing is uploaded anywhere, and nobody else gets a copy unless you send them
one. You never type your Xero password into this tool: you sign in on Xero's own website, the
same way you always do, and approve the connection there.

The access it asks for is **read-only**. It cannot create, edit or delete anything in Xero.

## What you need

- A Windows PC.
- [Node.js](https://nodejs.org) — download the LTS version and install it (default options are fine).
- Permission in Xero to connect an app to your organisation. The Standard or Adviser role has
  it; a Read Only user does not. If you are unsure, the Connect step below will simply fail and
  tell you.

## Step 1 — Create a Xero app (once, about 3 minutes)

The app is just a registration that lets the tool ask Xero for permission. It belongs to you.

1. Go to <https://developer.xero.com/app/manage> and sign in with your normal Xero login.
2. Click **New app**.
3. Fill in:
   - **App name**: anything, for example `Data export`.
   - **Integration type**: **Web app**.
   - **Company or application URL**: your company website.
   - **Redirect URI**: `http://localhost:3000/callback` — this must be exact.
   - When asked whether the data will be used to train AI models, answer **No**.
4. Click **Create app**.
5. On the app's **Configuration** tab, copy the **Client ID**. Then click **Generate a secret**
   and copy the **Client Secret** immediately — Xero shows it only once.

Keep both values handy for the next step, and treat the secret like a password.

## Step 2 — Start the tool

1. Unzip the folder you were sent, somewhere like `Documents\xero-export`.
2. Double-click **`Xero Export.cmd`**.

   The first run downloads what it needs and takes a minute or two. A black console window
   stays open while the tool runs — closing it stops the tool. Your browser opens at
   <http://localhost:3000>.

## Step 3 — Connect to Xero

1. The page opens on **Connect & sync**.
2. Paste the **Client ID** and **Client Secret** from step 1 and click **Save**.
3. Click **Connect to Xero**. Xero's own login page appears.
4. Sign in, choose the organisation you want to export, and click **Allow access**.
5. You are returned to the tool, which now shows the organisation as connected.

To export more than one organisation, click **Reconnect / add organisation** and repeat for the
next one.

## Step 4 — Sync

1. Leave **Download attachments** ticked so invoice PDFs and receipts come across too.
2. Click **Start sync**.

The log shows progress. Xero limits how fast anyone can pull data — 60 requests a minute and
5,000 a day per organisation — so the tool paces itself. A small organisation takes a few
minutes; a large one with years of history can take hours, and may need a second run the next
day. Nothing is lost if you stop: run it again and it continues where it left off.

## Step 5 — Take your data

On **Connect & sync**, or on the Dashboard, you have three downloads:

| Format | Best for |
|---|---|
| **CSV + attachments (.zip)** | Working with the data in Excel or importing it elsewhere. Columns follow Xero's own export layout. |
| **Offline viewer (.html)** | One single file. Open it in a browser, click any row and the attached PDF or image appears inline. Nothing to unzip, easy to send to someone. |
| **Excel (.xlsx)** | One sheet per data type, with images embedded in the rows. |

Attachments are named after the document they belong to, for example
`attachments/Bills/INV-2608 - Speed Tyres - INV 2608.pdf`, and `Attachments.csv` lists every
file against its invoice number, contact, date and amount.

## Stopping and cleaning up

- Close the black console window to stop the tool.
- To cut its access off completely: in Xero go to **Settings → Connected apps** and disconnect
  the app. You can also delete the app itself at developer.xero.com.
- All downloaded data sits in the `data` folder next to `Xero Export.cmd`. Delete that folder
  and the copy is gone.

## What it cannot get

Xero's API does not expose everything:

- **Journals** (Xero's own general ledger entries) need a Xero Advanced plan plus approval from
  Xero. Without it that one endpoint returns an error and everything else still works.
- Raw bank statement lines and detailed reconciliation state.
- Invoice templates, and files in the Xero file library that are not attached to a document.
- Payroll, Projects and Fixed Assets are separate Xero modules and are not included.

## If something goes wrong

- **"Port 3000 is busy"** — the tool is already running. Look for the other console window, or
  open <http://localhost:3000> directly.
- **`invalid_scope` on the Xero login page** — the app was created with permissions this tool
  does not expect. Send a screenshot to whoever gave you this tool.
- **The sync stops partway** — usually the daily Xero limit. Run it again tomorrow; the data
  already downloaded is kept.

One more thing worth checking before you start: client accounting data usually falls under your
firm's data-handling rules. Make sure exporting a copy to a laptop is something you are allowed
to do.
