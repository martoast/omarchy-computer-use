// One private browser instance for the CDP backend: its own profile directory, a DevTools port on 127.0.0.1, and
// (by default) no window in the way of the person using the machine. Linux and macOS.
//
//   const h = await spawnCdpInstance({ url, headless: true });   // -> { pid, port, httpUrl, userDataDir }
//   cdpInstanceEnv(h)                                            // -> env for the core: COMPUTER_USE_BACKEND=cdp …
//   await teardownCdpInstance(h)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (process.env.COMPUTER_USE_CHROME) return process.env.COMPUTER_USE_CHROME;
  const home = os.homedir();
  const c = [];
  if (process.platform === "darwin") {
    // Chrome for Testing installed by the installer (never the person's own browser profile), then the usual apps
    for (const base of [path.join(home, ".local/share/omarchy-computer-use/browsers/chrome"), path.join(home, "computer-use-mac/browsers/chrome")]) {
      try { for (const d of fs.readdirSync(base).sort().reverse()) c.push(path.join(base, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), path.join(base, d, "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")); } catch {}
    }
    c.push("/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    c.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/snap/bin/chromium");
  }
  const hit = c.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (!hit) throw new Error(`no Chromium/Chrome found (tried ${c.length} paths); set COMPUTER_USE_CHROME`);
  return hit;
}

export async function spawnCdpInstance({ url = "about:blank", headless = process.env.COMPUTER_USE_CDP_HEADLESS !== "0", width = 1280, height = 900, timeoutMs = 20000 } = {}) {
  const bin = findChrome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-chrome-"));
  const args = [
    `--user-data-dir=${userDataDir}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen", "--password-store=basic", "--use-mock-keychain",
    `--window-size=${width},${height}`, "--force-device-scale-factor=1", "--lang=en-US",
    // an unfocused or hidden window must keep rendering and running timers at full speed
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
  ];
  if (headless) args.push("--headless=new");
  args.push(url);
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
  let err = "";
  child.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const t0 = Date.now();
  while (!fs.existsSync(portFile)) {
    if (child.exitCode != null) throw new Error(`browser exited (${child.exitCode}) before opening its DevTools port: ${err.slice(0, 400)}`);
    if (Date.now() - t0 > timeoutMs) { try { process.kill(-child.pid); } catch {} throw new Error("browser did not open its DevTools port in time"); }
    await sleep(100);
  }
  let port;
  for (;;) { const s = fs.readFileSync(portFile, "utf8").split("\n")[0].trim(); if (s) { port = Number(s); break; } await sleep(50); }
  const h = { pid: child.pid, port, httpUrl: `http://127.0.0.1:${port}`, userDataDir, headless, bin, child };
  return h;
}

export function cdpInstanceEnv(h) {
  return { COMPUTER_USE_BACKEND: "cdp", COMPUTER_USE_CDP_URL: h.httpUrl };
}

export async function teardownCdpInstance(h) {
  if (!h) return;
  try { process.kill(-h.pid, "SIGTERM"); } catch { try { process.kill(h.pid, "SIGTERM"); } catch {} }
  for (let i = 0; i < 30; i++) { try { process.kill(h.pid, 0); } catch { break; } await sleep(100); }
  try { process.kill(-h.pid, "SIGKILL"); } catch {}
  try { fs.rmSync(h.userDataDir, { recursive: true, force: true }); } catch {}
}
