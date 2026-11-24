// Client for the persistent virtual keyboard helper (headless_keyboard.c) of a headless
// instance. One helper process per MCP server process, started lazily on the first key
// action and kept for the server's life: the seat keeps ONE virtual keyboard, so every
// keystroke lands on the same device the page is bound to (measured 2026-09-03: a fresh
// wtype device per character leaves a React input with only the last keystroke — see
// headless_keyboard.c). Every action is one stdin line answered by one stdout line
// ("ok" | "err …"); commands are serialised. Text rides as base64 so spaces, punctuation
// and non-ASCII travel on one line. When the binary is missing or fails to start (or the
// compositor lacks zwp_virtual_keyboard_manager_v1), `available()` is false and the caller
// keeps its previous path (wtype) — stated once through `log`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function defaultHelperBinary(env = process.env) {
  if (typeof env.HEADLESS_KEYBOARD_BIN === "string" && env.HEADLESS_KEYBOARD_BIN) return env.HEADLESS_KEYBOARD_BIN;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "build", "headless_keyboard");
}

/** PURE. Did a failed helper action certainly send NOTHING (lead review of 0abbbc8: a fallback after a key that may already have gone
 * out sends it twice — a double Return submits twice, a double Delete eats a character)? True only when nothing can have been
 * written: the helper was not up (headless_keyboard_unavailable), the call was refused before writing (RangeError), or the helper
 * itself refused the line BEFORE any key event (headless_keyboard.c answers "err key" / "err mods" / "err full" / "err syntax" /
 * "err base64" / "err text" / "err oom" before locating or pressing, and "err keymap" when the keymap upload failed before the
 * press). Anything else ("err display" after the press, "err exited" mid-line, an unknown reply) may have sent it: false. */
export function helperSentNothing(error) {
  if (error instanceof RangeError || error instanceof TypeError) return true;
  if (error?.code === "headless_keyboard_unavailable") return true;
  if (error?.code === "headless_keyboard_error") return /^err (?:key|mods|full|syntax|base64|text|oom|keymap)$/.test(String(error.message || ""));
  return false;
}

/** One keyboard action: through the helper when it is up; through wtype ONLY when the helper is not up or a failure proves it
 * sent nothing (helperSentNothing). A failure that may have sent is logged and NOT re-sent — the caller's own check judges what
 * landed. Returns "helper" | "wtype" | "not-resent". */
export async function sendWithFallback({ available, viaHelper, viaWtype, what = "key", log = (line) => console.error(line) }) {
  if (await available()) {
    try { await viaHelper(); return "helper"; }
    catch (error) {
      if (!helperSentNothing(error)) { log(`[headless] keyboard ${what} failed after it may have been sent (${error?.code || "error"}: ${String(error?.message || "").slice(0, 40)}); NOT re-sent`); return "not-resent"; }
      log(`[headless] keyboard ${what} fell back to wtype (${error?.code || error?.name || "error"})`);
    }
  }
  await viaWtype();
  return "wtype";
}

export function createHeadlessKeyboard({ binary = defaultHelperBinary(), env = process.env, spawnImpl = spawn, exists = existsSync, log = null } = {}) {
  if (typeof binary !== "string" || !binary) throw new TypeError("binary is required");
  let child = null, ready = null, closed = false, failed = false, buffer = "";
  const waiters = []; // one resolver per outstanding line
  const say = (line) => { try { log?.(line); } catch { /* diagnostics never break input */ } };
  const onLine = (line) => { const w = waiters.shift(); if (w) w(line); };
  const start = () => {
    if (ready) return ready;
    ready = (async () => {
      if (!exists(binary)) { failed = true; say(`headless_keyboard: helper binary missing at ${binary}; keys use the wtype path`); return false; }
      try {
        child = spawnImpl(binary, [], { env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) { failed = true; say(`headless_keyboard: spawn failed (${error?.code || "error"}); keys use the wtype path`); return false; }
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); onLine(line); }
      });
      child.stderr?.on("data", () => {});
      child.once("exit", () => { closed = true; while (waiters.length) waiters.shift()("err exited"); });
      child.once("error", () => { failed = true; closed = true; while (waiters.length) waiters.shift()("err spawn"); });
      const first = await new Promise((resolve) => { waiters.push(resolve); });
      if (first !== "ready") { failed = true; say(`headless_keyboard: helper did not report ready (${first.slice(0, 40)}); keys use the wtype path`); try { child.kill(); } catch { /* gone */ } return false; }
      return true;
    })();
    return ready;
  };
  const send = async (line) => {
    if (!(await start()) || closed || failed) throw Object.assign(new Error("headless_keyboard_unavailable"), { code: "headless_keyboard_unavailable" });
    const answer = new Promise((resolve) => { waiters.push(resolve); });
    child.stdin.write(`${line}\n`);
    const reply = await answer;
    if (reply !== "ok") throw Object.assign(new Error(reply || "err"), { code: "headless_keyboard_error" });
  };
  const MODS = new Set(["ctrl", "shift", "alt", "logo"]);
  return Object.freeze({
    available: () => start(),
    async type(text) {
      if (typeof text !== "string") throw new TypeError("type needs a string");
      if (text.length === 0) return; // nothing to type is not an error
      await send(`text ${Buffer.from(text, "utf8").toString("base64")}`);
    },
    async key(name, modifiers = []) {
      if (typeof name !== "string" || !name || /\s/.test(name)) throw new RangeError("key needs a name");
      const mods = [...new Set(modifiers)];
      if (mods.some((m) => !MODS.has(m))) throw new RangeError("unknown modifier");
      await send(mods.length ? `key ${name} ${mods.join("+")}` : `key ${name}`);
    },
    close() { if (child && !closed) { closed = true; try { child.stdin.end("quit\n"); } catch { /* gone */ } try { child.kill(); } catch { /* gone */ } } },
    get running() { return child !== null && !closed && !failed; },
  });
}
