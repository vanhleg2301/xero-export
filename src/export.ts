import { runExport } from "./exporter";

runExport({
  shouldDownloadAttachments: process.argv.includes("--attachments"),
  shouldRefresh: process.argv.includes("--refresh"),
  log: (message) => console.log(message),
}).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
