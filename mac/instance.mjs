// One REAL Chrome for the "ax" backend on macOS: the installed Google Chrome (not Chrome for Testing), its own
// persistent profile directory (cookies and history carry over between runs, like a person's browser), GPU on,
// a normal window, and NO DevTools port. It is the macOS counterpart of the Linux headless-sway Chromium driven
// over AT-SPI: the browser is a browser; the accessibility API reads and drives it. Launched in the background
// (`open -g`) so it does not take the person's focus. Never uses the person's own Chrome profile.
//
//   const h = await spawnMacInstance({ url, profileKey: "bench" });   // -> { pid, profileDir, bin }
//   macInstanceEnv(h)                                                // -> env for the core: COMPUTER_USE_BACKEND=ax …
//   await teardownMacInstance(h)
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = process.env.COMPUTER_USE_CHROME_APP || "/Applications/Google Chrome.app";
export const profileRoot = () => process.env.COMPUTER_USE_PROFILE_ROOT || path.join(os.homedir(), "computer-use-mac", "profiles");

function pidFor(profileDir) {
  try {
    const out = execFileSync("pgrep", ["-f", "--", `--user-data-dir=${profileDir}( |$)`], { encoding: "utf8" }).trim().split("\n").map(Number).filter(Boolean);
    // the browser process is the one whose command line has no --type= (renderers and helpers do)
    for (const p of out) {
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(p)], { encoding: "utf8" });
      if (!/--type=/.test(cmd)) return p;
    }
  } catch {}
  return null;
}

export async function spawnMacInstance({ url = "about:blank", profileKey = process.env.COMPUTER_USE_PROFILE || "bench", width = 1280, height = 900, timeoutMs = 20000 } = {}) {
  if (!fs.existsSync(APP)) throw new Error(`Google Chrome not found at ${APP} (set COMPUTER_USE_CHROME_APP)`);
  const profileDir = path.join(profileRoot(), profileKey);
  fs.mkdirSync(profileDir, { recursive: true });
  if (pidFor(profileDir)) throw new Error(`profile already in use: ${profileKey}`);
  const args = [
    `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen",
    "--force-renderer-accessibility", `--window-size=${width},${height}`, "--window-position=40,40", "--lang=en-US",
    "--hide-crash-restore-bubble",
    // a site asking for location or notifications gets a quiet no (the prompt is a window that takes focus)
    "--deny-permission-prompts",
    // a window behind the person's own windows must keep rendering and running timers at full speed
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    "--new-window", url,
  ];
  // -n: a new instance (its own profile), -g: in the background (no focus taken), -j: launched hidden is NOT used:
  // a hidden app has no on-screen window, and Chrome then stops building frames
  spawn("open", ["-n", "-g", "-a", APP, "--args", ...args], { stdio: "ignore", detached: true }).unref();
  const t0 = Date.now();
  let pid = null;
  while (!(pid = pidFor(profileDir))) {
    if (Date.now() - t0 > timeoutMs) throw new Error("Chrome did not start in time");
    await sleep(150);
  }
  return { pid, profileDir, profileKey, bin: APP };
}

export function macInstanceEnv(h) {
  return { COMPUTER_USE_BACKEND: "ax", COMPUTER_USE_AX_PID: String(h.pid) };
}

export async function teardownMacInstance(h) {
  if (!h?.pid) return;
  // SIGTERM lets Chrome write its cookies and history: the profile is meant to carry over
  try { process.kill(h.pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 50; i++) { try { process.kill(h.pid, 0); } catch { return; } await sleep(100); }
  try { process.kill(h.pid, "SIGKILL"); } catch {}
}
