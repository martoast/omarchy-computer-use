// A loopback forward proxy that refuses ad / analytics / session-replay hosts and passes everything else straight
// through. It replaces the --host-resolver-rules flag, which Chromium announces with a bar across every window
// ("You are using an unsupported command-line flag", 2026-09-27) — the proxy reaches the browser through its proxy
// ENVIRONMENT, like the US exit, so the argv stays flag-free. HTTPS is tunnelled (CONNECT): TLS stays end to end,
// the store sees the same client and the same egress IP. One proxy per process, started on first use; its server is
// unref'd so it never keeps a process alive.
import http from "node:http";
import net from "node:net";

/** PURE. Is `host` one of `blocked` or a subdomain of one? */
export function hostBlocked(host, blocked) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  return blocked.some((b) => h === b || h.endsWith(`.${b}`));
}

let shared = null;

/** Start (once per process) and return { url } of the blocking proxy for `blockedHosts`. */
export function blockingProxy(blockedHosts) {
  if (shared) return shared;
  const server = http.createServer((req, res) => {
    // Every socket and stream gets an error handler: an unhandled ECONNRESET from a browser that went away crashed
    // the whole run process at teardown (live Michael Kors, 2026-09-27) — in the engine it would take down the engine.
    req.on("error", () => {});
    res.on("error", () => {});
    // Plain-HTTP requests arrive with an absolute URL.
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    if (hostBlocked(target.hostname, blockedHosts)) { res.writeHead(403).end(); return; }
    const upstream = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers: req.headers }, (up) => {
      up.on("error", () => { try { res.destroy(); } catch {} });
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => { try { res.writeHead(502).end(); } catch {} });
    // Open connections never keep the process alive (the CLI hung after its run with Chromium's keep-alives open).
    upstream.on("socket", (sock) => sock.unref());
    req.socket?.unref?.();
    req.pipe(upstream);
  });
  server.on("connect", (req, client, head) => {
    const [host, portText] = String(req.url || "").split(":");
    const port = Number(portText) || 443;
    if (!host || hostBlocked(host, blockedHosts)) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    client.unref?.();
    const upstream = net.connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.unref();
    const drop = () => { upstream.destroy(); client.destroy(); };
    upstream.on("error", drop);
    client.on("error", drop);
  });
  server.on("clientError", (_e, socket) => { try { socket.destroy(); } catch {} });
  server.on("connection", (socket) => { socket.on("error", () => {}); socket.unref(); });
  server.on("error", () => {});
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  server.unref();
  shared = { ready, server };
  return shared;
}
