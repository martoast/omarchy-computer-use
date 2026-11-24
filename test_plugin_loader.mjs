// The plugin loader (plugin_loader.mjs): where the list comes from, and that a broken plugin never takes the core down.
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { pluginSpecs, loadPlugins } from "./plugin_loader.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cu-plugins-"));
try {
  // env wins (even empty); otherwise the config file; a missing file is no plugins; bad JSON is reported
  assert.deepEqual(pluginSpecs({ env: { COMPUTER_USE_PLUGINS: "/a.mjs:/b.mjs" } }).specs, ["/a.mjs", "/b.mjs"]);
  assert.deepEqual(pluginSpecs({ env: { COMPUTER_USE_PLUGINS: "" }, readFile: () => '{"plugins":["/x.mjs"]}' }).specs, [], "an empty env list means none, not the file's");
  assert.deepEqual(pluginSpecs({ env: { XDG_CONFIG_HOME: tmp }, readFile: () => '{"plugins":["/x.mjs", 3, ""]}' }).specs, ["/x.mjs"]);
  assert.deepEqual(pluginSpecs({ env: { XDG_CONFIG_HOME: tmp }, readFile: () => { throw new Error("ENOENT"); } }), { source: "none", specs: [] });
  assert.ok(pluginSpecs({ env: { XDG_CONFIG_HOME: tmp }, readFile: () => "{nope" }).error);

  // a good plugin registers; a failing import, a module without register, and a register that throws are skipped and reported
  const good = path.join(tmp, "good.mjs"); fs.writeFileSync(good, "export const name = 'good'; export function register(ctx) { ctx.seen.push('good'); }");
  const none = path.join(tmp, "none.mjs"); fs.writeFileSync(none, "export const x = 1;");
  const boom = path.join(tmp, "boom.mjs"); fs.writeFileSync(boom, "export function register() { throw new Error('boom'); }");
  const ctx = { seen: [] }; const logs = []; const statusFile = path.join(tmp, "status.json");
  const res = await loadPlugins(ctx, { log: (m) => logs.push(m), statusFile, specsResult: { source: "test", specs: [good, "/missing/x.mjs", none, boom] } });
  assert.deepEqual(ctx.seen, ["good"]);
  assert.deepEqual(res.map((r) => r.ok), [true, false, false, false]);
  assert.equal(res[0].name, "good");
  assert.match(res[2].error, /no register/); assert.match(res[3].error, /boom/);
  assert.equal(logs.length, 3, "each skip is logged");
  assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).plugins.length, 4, "the status file lists every plugin for doctor");
  console.log("PASS — plugin loader: env over config, broken plugins skipped and reported");
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
