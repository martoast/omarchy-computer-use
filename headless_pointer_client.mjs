// Client for the persistent virtual pointer helper (headless_pointer.c) of a headless
// instance. One helper process per MCP server process, started lazily on the first
// pointer action and kept for the server's life: the seat keeps its pointer capability
// and the surface its pointer focus, so motion/button/axis reach the page (measured
// 2026-09-03: one-shot wlrctl clicks never do — see headless_pointer.c). Every action
// is one stdin line answered by one stdout line ("ok" | "err …"); commands are
// serialised. When the binary is missing or fails to start, `available()` is false and
// the caller keeps its previous path (wlrctl) — stated once through `log`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUTTONS = Object.freeze(["left", "right", "middle"]);

export function defaultHelperBinary(env = process.env) {
  if (typeof env.HEADLESS_POINTER_BIN === "string" && env.HEADLESS_POINTER_BIN) return env.HEADLESS_POINTER_BIN;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "build", "headless_pointer");
}

export function createHeadlessPointer({ binary = defaultHelperBinary(), env = process.env, spawnImpl = spawn, exists = existsSync, log = null } = {}) {
  if (typeof binary !== "string" || !binary) throw new TypeError("binary is required");
  let child = null, ready = null, closed = false, failed = false, buffer = "";
  let lastX = 0, lastY = 0, positioned = false; // the last commanded position, re-asserted before a press
  const waiters = []; // one resolver per outstanding line
  const say = (line) => { try { log?.(line); } catch { /* diagnostics never break input */ } };
  const onLine = (line) => { const w = waiters.shift(); if (w) w(line); };
  const start = () => {
    if (ready) return ready;
    ready = (async () => {
      if (!exists(binary)) { failed = true; say(`headless_pointer: helper binary missing at ${binary}; pointer actions use the one-shot path`); return false; }
      try {
        child = spawnImpl(binary, [], { env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) { failed = true; say(`headless_pointer: spawn failed (${error?.code || "error"}); pointer actions use the one-shot path`); return false; }
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); onLine(line); }
      });
      child.stderr?.on("data", () => {});
      child.once("exit", () => { closed = true; while (waiters.length) waiters.shift()("err exited"); });
      child.once("error", () => { failed = true; closed = true; while (waiters.length) waiters.shift()("err spawn"); });
      const first = await new Promise((resolve) => { waiters.push(resolve); });
      if (!/^ready \d+ \d+$/.test(first)) { failed = true; say(`headless_pointer: helper did not report ready (${first.slice(0, 40)}); pointer actions use the one-shot path`); try { child.kill(); } catch { /* gone */ } return false; }
      return true;
    })();
    return ready;
  };
  const send = async (line) => {
    if (!(await start()) || closed || failed) throw Object.assign(new Error("headless_pointer_unavailable"), { code: "headless_pointer_unavailable" });
    const answer = new Promise((resolve) => { waiters.push(resolve); });
    child.stdin.write(`${line}\n`);
    const reply = await answer;
    if (reply !== "ok") throw Object.assign(new Error(reply || "err"), { code: "headless_pointer_error" });
  };
  return Object.freeze({
    available: () => start(),
    async move(x, y) {
      if (!Number.isInteger(x) || !Number.isInteger(y)) throw new RangeError("move needs integers");
      const mx = Math.max(0, x), my = Math.max(0, y);
      await send(`move ${mx} ${my}`);
      lastX = mx; lastY = my; positioned = true;
    },
    // A click a store's mousedown wrapper honours, not a bare synthetic press: a fresh motion
    // frame at the target immediately before the press (a press after an idle pointer is what
    // such wrappers drop), then press and release as SEPARATE commands so the helper's own
    // display round trip lets the compositor process the press before the release. Both the
    // motion and the hold are in the stdin protocol; the hold is a measured ordering, no sleep.
    async click(button = "left", clicks = 1) {
      const name = BUTTONS.includes(button) ? button : "left";
      if (!Number.isInteger(clicks) || clicks < 1 || clicks > 3) throw new RangeError("clicks must be 1..3");
      for (let i = 0; i < clicks; i++) {
        if (positioned) await send(`move ${lastX} ${lastY}`);
        await send(`button ${name} press`);
        await send(`button ${name} release`);
      }
    },
    // A REAL-TIME hold (the input relay's pointer.down / pointer.up — a shopper passing a store's "Press & Hold"
    // human check): press and release are separate calls, so the button stays down for as long as the person holds.
    async press(button = "left") {
      const name = BUTTONS.includes(button) ? button : "left";
      if (positioned) await send(`move ${lastX} ${lastY}`);
      await send(`button ${name} press`);
    },
    async release(button = "left") { await send(`button ${BUTTONS.includes(button) ? button : "left"} release`); },
    async scroll(dy) { if (!Number.isInteger(dy) || dy === 0) throw new RangeError("scroll needs a non-zero integer"); await send(`scroll ${dy}`); },
    close() { if (child && !closed) { closed = true; try { child.stdin.end("quit\n"); } catch { /* gone */ } try { child.kill(); } catch { /* gone */ } } },
    get running() { return child !== null && !closed && !failed; },
  });
}
