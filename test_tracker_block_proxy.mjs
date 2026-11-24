// tracker_block_proxy.mjs: blocked hosts (and their subdomains) are refused; others are tunnelled.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { hostBlocked, blockingProxy } from "./tracker_block_proxy.mjs";

assert.equal(hostBlocked("www.google-analytics.com", ["google-analytics.com"]), true);
assert.equal(hostBlocked("google-analytics.com", ["google-analytics.com"]), true);
assert.equal(hostBlocked("notgoogle-analytics.com", ["google-analytics.com"]), false);
assert.equal(hostBlocked("www.youngla.com", ["google-analytics.com"]), false);

// A local target server stands in for a store.
const target = net.createServer((s) => s.end("hello")).listen(0, "127.0.0.1");
await new Promise((r) => target.once("listening", r));
const { ready } = blockingProxy(["blocked.test"]);
const proxyUrl = new URL(await ready);
const connect = (host, port) => new Promise((resolve) => {
  const req = http.request({ host: proxyUrl.hostname, port: proxyUrl.port, method: "CONNECT", path: `${host}:${port}` });
  req.on("connect", (res, socket, head) => { let body = head?.length ? String(head) : ""; socket.on("data", (d) => (body += d)); socket.on("end", () => resolve({ status: res.statusCode, body })); });
  req.on("response", (res) => resolve({ status: res.statusCode, body: "" }));
  req.end();
});
assert.equal((await connect("ads.blocked.test", 443)).status, 403);
const ok = await connect("127.0.0.1", target.address().port);
assert.equal(ok.status, 200); assert.equal(ok.body, "hello");
target.close();

// Resets never crash the process (live: an unhandled ECONNRESET took down a whole run at teardown).
const reset = net.createServer((sock) => sock.resetAndDestroy ? sock.resetAndDestroy() : sock.destroy()).listen(0, "127.0.0.1");
await new Promise((r) => reset.once("listening", r));
await new Promise((resolve) => {
  const req = http.request({ host: proxyUrl.hostname, port: proxyUrl.port, method: "CONNECT", path: `127.0.0.1:${reset.address().port}` });
  req.on("connect", (_res, socket) => { socket.on("error", () => {}); socket.write("x"); socket.on("close", resolve); setTimeout(resolve, 500); });
  req.on("error", resolve);
  req.end();
});
await new Promise((resolve) => {
  const req = http.request({ host: proxyUrl.hostname, port: proxyUrl.port, method: "GET", path: `http://127.0.0.1:${reset.address().port}/` }, (res) => { res.resume(); res.on("end", resolve); });
  req.on("error", resolve);
  req.end();
  setTimeout(resolve, 800);
});
await new Promise((r) => setTimeout(r, 200));
reset.close();
console.log("PASS — tracker blocking proxy");
process.exit(0);
