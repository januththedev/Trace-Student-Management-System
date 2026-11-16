import { createServer } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";

// Optional transport workaround for hosts with broken Google IPv6 routing.
// This forwards real encrypted font requests; application/API responses are untouched.
async function start() {
  const proxy = createServer((_request, response) => { response.writeHead(405).end(); });
  proxy.on("connect", (request, socket, head) => {
    const destination = new URL(`https://${request.url}`);
    if (!["fonts.googleapis.com", "fonts.gstatic.com"].includes(destination.hostname) || destination.port && destination.port !== "443") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
    }
    const upstream = connect({ host: destination.hostname, port: 443, family: 4 }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("No font proxy address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const command = "pnpm dev tests/e2e/.artifacts/app --port 3100";
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { stdio: "inherit", windowsHide: true, env: { ...process.env, HTTPS_PROXY: endpoint, HTTP_PROXY: endpoint, NO_PROXY: "localhost,127.0.0.1,::1" } })
    : spawn("pnpm", ["dev", "tests/e2e/.artifacts/app", "--port", "3100"], { stdio: "inherit", env: { ...process.env, HTTPS_PROXY: endpoint, HTTP_PROXY: endpoint, NO_PROXY: "localhost,127.0.0.1,::1" } });
  child.on("exit", (code) => { proxy.close(); process.exitCode = code ?? 1; });
  child.on("error", (error) => { console.error(error); proxy.close(); process.exitCode = 1; });
}
start().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
