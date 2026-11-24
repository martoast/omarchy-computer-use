// PLUGINS — how other projects add their own tools to this server without forking it.
//
// A plugin is an ES module exporting `register(ctx)` (sync or async). It gets the server and a small set of core
// helpers (see index.js `pluginContext`) and registers tools with `ctx.server.registerTool(...)` exactly as the core
// does. The core's safety rails (the payment / irreversible-action guard) apply to whatever the plugin's tools do
// through the core helpers.
//
// Where the list comes from:
//   1. COMPUTER_USE_PLUGINS — module paths separated by ":" (or ","), e.g. for a project's own launcher or tests;
//      when set (even to ""), it is the whole list.
//   2. otherwise ~/.config/omarchy-computer-use/plugins.json — { "plugins": ["/abs/path/plugin.mjs", ...] }
//      (the installer creates it empty).
// A plugin that fails to load or to register is logged to stderr and skipped: it never takes the core down. Every
// outcome is written to the status file (~/.cache/omarchy-computer-use/plugins-status.json) for `doctor`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function configDir(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "omarchy-computer-use");
}
export function cacheDir(env = process.env) {
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "omarchy-computer-use");
}

/** PURE-ish. The plugin module paths to load: the env list when COMPUTER_USE_PLUGINS is set, else the config file's. */
export function pluginSpecs({ env = process.env, readFile = (p) => readFileSync(p, "utf8") } = {}) {
  if (env.COMPUTER_USE_PLUGINS !== undefined) {
    return { source: "env", specs: String(env.COMPUTER_USE_PLUGINS).split(/[:,]/).map((s) => s.trim()).filter(Boolean) };
  }
  const file = path.join(configDir(env), "plugins.json");
  let raw;
  try { raw = readFile(file); } catch { return { source: "none", specs: [] }; }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.plugins;
    return { source: file, specs: (Array.isArray(list) ? list : []).filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) };
  } catch (e) {
    return { source: file, specs: [], error: `plugins.json is not valid JSON: ${e.message}` };
  }
}

/** I/O. Imports and registers each plugin; never throws. Returns [{ spec, ok, error?, name? }] and writes the status file. */
export async function loadPlugins(ctx, { env = process.env, log = (m) => console.error(m), importModule = (s) => import(s), statusFile = path.join(cacheDir(env), "plugins-status.json"), specsResult = pluginSpecs({ env }) } = {}) {
  const results = [];
  if (specsResult.error) log(`[plugins] ${specsResult.error}`);
  for (const spec of specsResult.specs) {
    const target = path.isAbsolute(spec) ? pathToFileURL(spec).href : spec;
    try {
      const mod = await importModule(target);
      const register = mod?.register || mod?.default?.register || (typeof mod?.default === "function" ? mod.default : null);
      if (typeof register !== "function") throw new Error("the module exports no register(ctx) function");
      await register(ctx);
      results.push({ spec, ok: true, name: mod?.name || mod?.default?.name || path.basename(spec) });
    } catch (e) {
      const error = String(e?.message || e).slice(0, 300);
      log(`[plugins] skipped ${spec}: ${error}`);
      results.push({ spec, ok: false, error });
    }
  }
  try {
    mkdirSync(path.dirname(statusFile), { recursive: true });
    writeFileSync(statusFile, JSON.stringify({ at: new Date().toISOString(), source: specsResult.source, ...(specsResult.error ? { error: specsResult.error } : {}), plugins: results }, null, 2));
  } catch { /* status is a convenience for doctor, never a reason to fail */ }
  return results;
}
