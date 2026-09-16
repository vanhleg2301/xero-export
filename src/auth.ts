import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { getConfig } from "./config";
import { exchangeCodeForTokens, getAuthorizeUrl } from "./xero";

const redirectUri = getConfig().redirectUri;
const { port, pathname: callbackPath } = new URL(redirectUri);
const state = randomBytes(16).toString("hex");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  if (url.pathname !== callbackPath) {
    res.writeHead(404).end();
    return;
  }
  try {
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state || !code) throw new Error(url.searchParams.get("error") ?? "Callback không hợp lệ.");
    const connections = await exchangeCodeForTokens(code);
    console.log(`Đã kết nối: ${connections.map((c) => c.tenantName).join(", ")}`);
    res.end("Xong. Quay lai terminal.");
  } catch (err) {
    console.error(err);
    res.writeHead(500).end(String(err));
  } finally {
    server.close();
  }
});

server.listen(Number(port), () => {
  console.log(`Mở link sau trong trình duyệt để đăng nhập Xero:\n\n${getAuthorizeUrl(state)}\n`);
});
