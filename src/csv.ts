import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildExportBundle, DATA_DIR, listDirs } from "./dataStore";
import { buildExcelReport } from "./excelReport";
import { buildHtmlReport } from "./htmlReport";
import { VIEWS } from "./views";

const OUTPUT_DIR = "export";

if (!existsSync(DATA_DIR)) throw new Error("No data/ folder yet — sync your data first.");

for (const tenant of listDirs(DATA_DIR)) {
  console.log(`=== ${tenant} ===`);
  const outDir = join(OUTPUT_DIR, tenant);
  rmSync(outDir, { recursive: true, force: true });

  const bundle = buildExportBundle(join(DATA_DIR, tenant), VIEWS);
  for (const file of bundle.files) {
    mkdirSync(dirname(join(outDir, file.path)), { recursive: true });
    writeFileSync(join(outDir, file.path), file.csv);
    console.log(`  ${file.path}`);
  }
  for (const attachment of bundle.attachments) {
    mkdirSync(dirname(join(outDir, attachment.path)), { recursive: true });
    copyFileSync(attachment.diskPath, join(outDir, attachment.path));
  }
  const reportPath = join(outDir, `${tenant} - Xero data.html`);
  writeFileSync(reportPath, buildHtmlReport(tenant, bundle));
  console.log(`  ${bundle.attachments.length} attachments`);
  console.log(`  ${reportPath}`);

  const excelPath = join(outDir, `${tenant} - Xero data.xlsx`);
  writeFileSync(excelPath, buildExcelReport(bundle));
  console.log(`  ${excelPath}`);
}
