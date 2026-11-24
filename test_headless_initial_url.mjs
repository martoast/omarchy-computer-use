import assert from "node:assert/strict";
import { normalizeHeadlessInitialUrl, spawnHeadlessInstance } from "./headless_instance.mjs";

assert.equal(normalizeHeadlessInitialUrl(), "about:blank");
assert.equal(normalizeHeadlessInitialUrl("about:blank"), "about:blank");
assert.equal(normalizeHeadlessInitialUrl("https://shop.test/search?q=running%20shoes#tile"), "https://shop.test/search?q=running%20shoes");
assert.equal(normalizeHeadlessInitialUrl("http://127.0.0.1:8080/path"), "http://127.0.0.1:8080/path");
for (const value of ["file:///tmp/x", "javascript:alert(1)", "https://user:pw@shop.test/", "not a url", 7]) {
  assert.throws(() => normalizeHeadlessInitialUrl(value), /initialUrl/);
}
await assert.rejects(()=>spawnHeadlessInstance({initialUrl:"https://shop.test/",allowInsecureLocalhost:true}),/test-only/);
await assert.rejects(()=>spawnHeadlessInstance({initialUrl:"https://shop.test/",enableDevtools:true}),/unknown spawn option.*enableDevtools/); // rev 20: not an option at all
console.log("PASS — headless initial URL validation");
