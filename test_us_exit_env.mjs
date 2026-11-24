import assert from "node:assert/strict";
import { chromiumEnvFor, chromiumArgv } from "./headless_instance.mjs";

const base = { PATH: "/usr/bin", https_proxy: "http://inherited:1", ALL_PROXY: "socks5://x:2" };
const off = chromiumEnvFor({ base, runtimeDir: "/run/x", waylandDisplay: "wayland-9" });
for (const key of ["http_proxy", "https_proxy", "all_proxy", "ALL_PROXY"]) assert.equal(off[key], undefined, `${key} never inherited`);
assert.equal(off.WAYLAND_DISPLAY, "wayland-9");

const on = chromiumEnvFor({ base, runtimeDir: "/run/x", waylandDisplay: "wayland-9", usExitProxy: "http://127.0.0.1:18845" });
assert.equal(on.https_proxy, "http://127.0.0.1:18845");
assert.equal(on.all_proxy, "http://127.0.0.1:18845");
assert.match(on.no_proxy, /127\.0\.0\.1/);

for (const bad of ["http://10.0.0.5:8080", "http://user:pw@127.0.0.1:1", "ftp://127.0.0.1:1", "not a url"]) {
  assert.throws(() => chromiumEnvFor({ runtimeDir: "/r", waylandDisplay: "w", usExitProxy: bad }), /usExitProxy/, bad);
}
// The argv never carries a proxy flag either way.
assert.equal(chromiumArgv({ profileDir: "/p", cacheDir: "/c", initialUrl: "https://s.test/" }).some((a) => /proxy/i.test(a)), false);
console.log("PASS — per-store US exit stays in one browser's environment, never in argv");
