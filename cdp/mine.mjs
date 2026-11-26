// The person's OWN Chrome (COMPUTER_USE_BROWSER=mine): their profile, their sign-ins, so nothing has to log in again.
// It attaches to the Chrome they already run, over the remote-debugging switch Chrome 144+ offers for exactly this
// (chrome://inspect/#remote-debugging; Chrome asks "Allow" for each session and shows the "controlled by automated
// test software" bar while one is open). No relaunch, no copy of the profile, no DevTools flag on their command line
// (Chrome 136+ refuses --remote-debugging-port on the default profile anyway). Linux and macOS.
//
// Rules this mode keeps (cdp/browser.mjs enforces them with `mine: true`):
//   - it works only in a window it opened itself, and in tabs that window's pages open; it never reads, attaches to or
//     closes one of the person's tabs
//   - leaving closes its own window only; the person's Chrome keeps running
//   - never for benchmarks or bulk runs: a site's bot defence would land on the person's real accounts
//
//   const ep = findMyChrome()   // -> { wsUrl, port, userDataDir, browser } or throws with what to do
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// where each Chrome keeps its profile; DevToolsActivePort appears there once remote debugging is switched on
export function chromeUserDataDirs() {
  if (process.env.COMPUTER_USE_MY_CHROME_DIR) return [process.env.COMPUTER_USE_MY_CHROME_DIR];
  const h = os.homedir();
  if (process.platform === "darwin") {
    const s = path.join(h, "Library/Application Support");
    return ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "BraveSoftware/Brave-Browser"].map((d) => path.join(s, d));
  }
  const c = process.env.XDG_CONFIG_HOME || path.join(h, ".config");
  return ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "BraveSoftware/Brave-Browser"].map((d) => path.join(c, d));
}

export function findMyChrome() {
  const dirs = chromeUserDataDirs();
  const found = [];
  for (const dir of dirs) {
    let txt;
    try { txt = fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8"); } catch { continue; }
    const [port, wsPath] = txt.split("\n").map((s) => s.trim());
    if (!/^\d+$/.test(port || "") || !/^\/devtools\/browser\//.test(wsPath || "")) continue;
    let mtime = 0; try { mtime = fs.statSync(path.join(dir, "DevToolsActivePort")).mtimeMs; } catch {}
    found.push({ port: Number(port), wsUrl: `ws://127.0.0.1:${port}${wsPath}`, userDataDir: dir, mtime });
  }
  if (!found.length) {
    const have = dirs.filter((d) => fs.existsSync(d));
    throw new Error(have.length
      ? `your Chrome is not open to this tool yet: in Chrome, open chrome://inspect/#remote-debugging and switch remote debugging on (once), keep Chrome running, then try again (looked in ${have.join(", ")})`
      : `no Chrome profile found (looked in ${dirs.join(", ")}); set COMPUTER_USE_MY_CHROME_DIR to your browser's profile folder`);
  }
  // a Chrome that quit leaves its file behind: the newest file is the running one (the connection checks it)
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0];
}
