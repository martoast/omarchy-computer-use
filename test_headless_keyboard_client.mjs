#!/usr/bin/env node
// The persistent virtual keyboard client (headless_keyboard_client.mjs) with a scripted helper:
// lazy start on the first action, the exact stdin lines (text as base64, key with +-joined mods),
// one answer per command in order, empty text a no-op, and the missing-binary / not-ready / exited /
// err fallbacks. Pure: no compositor, no binary.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHeadlessKeyboard, defaultHelperBinary } from "./headless_keyboard_client.mjs";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  <<< " + String(detail).slice(0, 300)}`); cond ? pass++ : fail++; };
const tick = () => new Promise((r) => setImmediate(r));
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

function fakeHelper({ readyLine = "ready\n", answer = () => "ok\n" } = {}) {
  const spawned = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { writes: [], write(s) { this.writes.push(s); const line = s.trim(); if (line === "quit") return; setImmediate(() => child.stdout.emit("data", answer(line))); }, end(s) { this.writes.push(`END:${s}`); } };
  child.kill = () => { child.killed = true; };
  const spawnImpl = (bin, args, opts) => { spawned.push({ bin, args, env: opts.env }); setImmediate(() => child.stdout.emit("data", readyLine)); return child; };
  return { child, spawned, spawnImpl };
}

// happy path
{
  const h = fakeHelper();
  const logs = [];
  const k = createHeadlessKeyboard({ binary: "/x/headless_keyboard", env: { WAYLAND_DISPLAY: "wayland-headless-3" }, spawnImpl: h.spawnImpl, exists: () => true, log: (l) => logs.push(l) });
  check("nothing is spawned before the first action", h.spawned.length === 0 && k.running === false, "");
  await k.type("running shoes");
  check("the first action starts the helper with the instance env", h.spawned.length === 1 && h.spawned[0].bin === "/x/headless_keyboard" && h.spawned[0].env.WAYLAND_DISPLAY === "wayland-headless-3", JSON.stringify(h.spawned));
  await k.key("Return");
  await k.key("a", ["ctrl"]);
  await k.key("Tab", ["shift"]);
  await k.type(""); // no-op, sends nothing
  check("the exact command lines: text is base64, key carries +-joined mods, empty text sends nothing", JSON.stringify(h.child.stdin.writes) === JSON.stringify([
    `text ${b64("running shoes")}\n`, "key Return\n", "key a ctrl\n", "key Tab shift\n",
  ]), JSON.stringify(h.child.stdin.writes));
  check("running after the start; no fallback log", k.running === true && logs.length === 0, JSON.stringify(logs));
  let threw = null; try { await k.key("a", ["hyper"]); } catch (e) { threw = e; }
  check("an unknown modifier is refused before the helper", threw instanceof RangeError, String(threw));
  threw = null; try { await k.key("has space"); } catch (e) { threw = e; }
  check("a key name with whitespace is refused before the helper", threw instanceof RangeError, String(threw));
  threw = null; try { await k.type(42); } catch (e) { threw = e; }
  check("type needs a string", threw instanceof TypeError, String(threw));
  k.close();
  check("close sends quit and kills", h.child.stdin.writes.at(-1) === "END:quit\n" && h.child.killed === true && k.running === false, "");
}
// non-ASCII and spaces survive base64
{
  const h = fakeHelper();
  const k = createHeadlessKeyboard({ binary: "/x/hk", spawnImpl: h.spawnImpl, exists: () => true });
  await k.type("café — ñ");
  check("non-ASCII text is carried as base64 and decodes back", Buffer.from(h.child.stdin.writes[0].trim().slice(5), "base64").toString("utf8") === "café — ñ", h.child.stdin.writes[0]);
}
// the helper answers err
{
  const h = fakeHelper({ answer: (line) => (line.startsWith("key") ? "err key\n" : "ok\n") });
  const k = createHeadlessKeyboard({ binary: "/x/hk", spawnImpl: h.spawnImpl, exists: () => true });
  await k.type("hi");
  let threw = null; try { await k.key("Nope"); } catch (e) { threw = e; }
  check("an err answer is a coded error", threw?.code === "headless_keyboard_error" && /err key/.test(threw.message), String(threw));
  await k.type("more");
  check("the helper keeps serving after an err", h.child.stdin.writes.at(-1) === `text ${b64("more")}\n`, h.child.stdin.writes.at(-1));
}
// missing binary: available() false, one log, actions throw a coded error
{
  const h = fakeHelper();
  const logs = [];
  const k = createHeadlessKeyboard({ binary: "/nowhere/headless_keyboard", spawnImpl: h.spawnImpl, exists: () => false, log: (l) => logs.push(l) });
  check("available() is false without the binary", (await k.available()) === false && h.spawned.length === 0, "");
  let threw = null; try { await k.type("x"); } catch (e) { threw = e; }
  check("actions then throw headless_keyboard_unavailable", threw?.code === "headless_keyboard_unavailable", String(threw));
  await k.available();
  check("one fallback log line, not one per call", logs.length === 1 && /missing/.test(logs[0]), JSON.stringify(logs));
}
// the helper never reports ready (e.g. compositor without the manager)
{
  const h = fakeHelper({ readyLine: "headless_keyboard: seat or zwp_virtual_keyboard_manager_v1 missing\n" });
  const logs = [];
  const k = createHeadlessKeyboard({ binary: "/x/hk", spawnImpl: h.spawnImpl, exists: () => true, log: (l) => logs.push(l) });
  check("a helper that does not say ready is unavailable and killed", (await k.available()) === false && h.child.killed === true && logs.length === 1, JSON.stringify(logs));
}
// the helper exits mid-flight
{
  const h = fakeHelper({ answer: () => "" });
  const k = createHeadlessKeyboard({ binary: "/x/hk", spawnImpl: h.spawnImpl, exists: () => true });
  await k.available();
  const pending = k.type("x");
  await tick();
  h.child.emit("exit", 1);
  let threw = null; try { await pending; } catch (e) { threw = e; }
  check("an exit answers every outstanding command with an error and the client stops", threw?.code === "headless_keyboard_error" && k.running === false, String(threw));
}
// binary resolution
{
  check("HEADLESS_KEYBOARD_BIN overrides the repo build path", defaultHelperBinary({ HEADLESS_KEYBOARD_BIN: "/opt/hk" }) === "/opt/hk" && /\/build\/headless_keyboard$/.test(defaultHelperBinary({})), defaultHelperBinary({}));
}
// NO RE-SEND (lead review of 0abbbc8): a helper failure falls back to wtype only when it certainly sent nothing; one that may have
// sent its key is logged and NOT sent again (a double Return would submit twice, a double Delete eat a character)
{
  const { sendWithFallback, helperSentNothing } = await import("./headless_keyboard_client.mjs");
  const err = (message, code = "headless_keyboard_error") => Object.assign(new Error(message), { code });
  const run = async (opts) => { const n = { helper: 0, wtype: 0 }; const logs = []; const r = await sendWithFallback({ available: async () => opts.available ?? true, viaHelper: async () => { n.helper++; if (opts.throws) throw opts.throws; }, viaWtype: async () => { n.wtype++; }, what: "Return", log: (l) => logs.push(l) }); return { r, n, logs }; };
  let x = await run({ throws: err("err display") });
  assert.deepEqual([x.r, x.n.helper, x.n.wtype], ["not-resent", 1, 0], "written, then failed: exactly one key, no wtype");
  assert.match(x.logs[0], /may have been sent.*NOT re-sent/);
  x = await run({ throws: err("err exited") });
  assert.deepEqual([x.r, x.n.wtype], ["not-resent", 0], "the helper died mid-line: not re-sent");
  x = await run({ available: false });
  assert.deepEqual([x.r, x.n.helper, x.n.wtype], ["wtype", 0, 1], "helper unavailable before the attempt: the wtype fallback");
  x = await run({ throws: err("headless_keyboard_unavailable", "headless_keyboard_unavailable") });
  assert.deepEqual([x.r, x.n.wtype], ["wtype", 1], "not started / not ready: nothing written, wtype");
  x = await run({ throws: err("err key") });
  assert.deepEqual([x.r, x.n.wtype], ["wtype", 1], "the helper refused the key before pressing: wtype");
  x = await run({ throws: new RangeError("key needs a name") });
  assert.deepEqual([x.r, x.n.wtype], ["wtype", 1], "refused before writing: wtype");
  x = await run({});
  assert.deepEqual([x.r, x.n.helper, x.n.wtype], ["helper", 1, 0]);
  for (const m of ["err key", "err mods", "err full", "err syntax", "err keymap"]) assert.equal(helperSentNothing(err(m)), true, m);
  for (const m of ["err display", "err exited", "err spawn", "something else"]) assert.equal(helperSentNothing(err(m)), false, m);
  console.log("PASS — no re-send after a helper action that may have sent");
}

console.log(fail ? `FAIL — ${pass} passed, ${fail} failed` : `PASS — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

