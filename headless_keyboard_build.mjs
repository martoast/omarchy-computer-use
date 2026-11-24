#!/usr/bin/env node
// Build the persistent virtual keyboard helper for headless instances (native/headless_keyboard.c):
// wayland-scanner generates the virtual-keyboard-unstable-v1 client code from the vendored protocol
// XML, cc links it against libwayland-client and libxkbcommon (xkbcommon builds the keymap the helper
// uploads), and the binary lands in build/. Idempotent: a binary newer than its three inputs is kept.
// Exit 0 with the binary path on stdout; a missing toolchain is reported by name (never a traceback).
// Called by the engine preflight, the local demo launcher and index.js's lazy start; safe to run by hand.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HELPER_NAME = "headless_keyboard";
export function helperPaths(root = path.dirname(fileURLToPath(import.meta.url))) {
  const build = path.join(root, "build");
  return Object.freeze({
    root, build,
    source: path.join(root, "native", "headless_keyboard.c"),
    protocol: path.join(root, "protocols", "virtual-keyboard-unstable-v1.xml"),
    header: path.join(build, "virtual-keyboard-unstable-v1-client-protocol.h"),
    code: path.join(build, "virtual-keyboard-unstable-v1-protocol.c"),
    binary: path.join(build, HELPER_NAME),
  });
}
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : -1);
export function isFresh(paths = helperPaths()) {
  const b = mtime(paths.binary);
  return b >= 0 && b >= mtime(paths.source) && b >= mtime(paths.protocol) && b >= mtime(fileURLToPath(import.meta.url));
}
export function buildHelper({ paths = helperPaths(), exec = execFileSync, mkdir = mkdirSync, force = false } = {}) {
  if (!force && isFresh(paths)) return { built: false, binary: paths.binary };
  for (const [tool, args] of [["wayland-scanner", ["--version"]], ["cc", ["--version"]], ["pkg-config", ["--exists", "wayland-client", "xkbcommon"]]]) {
    try { exec(tool, args, { stdio: "ignore" }); } catch { throw Object.assign(new Error(`${tool} missing`), { code: "toolchain_missing", tool }); }
  }
  mkdir(paths.build, { recursive: true });
  exec("wayland-scanner", ["client-header", paths.protocol, paths.header], { stdio: "ignore" });
  exec("wayland-scanner", ["private-code", paths.protocol, paths.code], { stdio: "ignore" });
  const flags = exec("pkg-config", ["--cflags", "--libs", "wayland-client", "xkbcommon"]).toString().trim().split(/\s+/).filter(Boolean);
  exec("cc", ["-O2", "-Wall", `-I${paths.build}`, "-o", paths.binary, paths.source, paths.code, ...flags], { stdio: "ignore" });
  return { built: true, binary: paths.binary };
}

// run directly (also through a symlink, e.g. a project that links this file from its node_modules)
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  try { const r = buildHelper({ force: process.argv.includes("--force") }); process.stdout.write(`${r.binary}\n`); }
  catch (error) { process.stderr.write(`headless_keyboard_build: ${error.code === "toolchain_missing" ? `${error.tool} is not installed` : error.message}\n`); process.exit(69); }
}
