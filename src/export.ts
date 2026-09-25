import { runExport } from "./exporter";

runExport({
  shouldDownloadAttachments: process.argv.includes("--attachments"),
  shouldRefresh: process.argv.includes("--refresh"),
  shouldWaitForQuota: !process.argv.includes("--no-wait"),
  log: (message) => console.log(message),
}).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
