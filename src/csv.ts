import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildExportBundle, DATA_DIR, listDirs } from "./dataStore";
import { VIEWS } from "./views";

const OUTPUT_DIR = "export";

if (!existsSync(DATA_DIR)) throw new Error("Chưa có thư mục data/ — đồng bộ dữ liệu trước.");

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
  console.log(`  ${bundle.attachments.length} file đính kèm → ${outDir}`);
}
