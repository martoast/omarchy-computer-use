#!/usr/bin/env node
// The persistent virtual pointer client (headless_pointer_client.mjs) with a scripted helper process:
// lazy start on the first action, the exact stdin lines, one answer per command in order, the
// missing-binary / not-ready / exited fallbacks (available() false, one log line, no throw on start),
// and the build script's path/freshness logic. Pure: no compositor, no binary.
import { EventEmitter } from "node:events";
import { createHeadlessPointer, defaultHelperBinary } from "./headless_pointer_client.mjs";
import { helperPaths, isFresh, buildHelper } from "./headless_pointer_build.mjs";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  <<< " + String(detail).slice(0, 300)}`); cond ? pass++ : fail++; };
const tick = () => new Promise((r) => setImmediate(r));

function fakeHelper({ readyLine = "ready 1920 1080\n", answer = () => "ok\n" } = {}) {
  const spawned = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { writes: [], write(s) { this.writes.push(s); const line = s.trim(); if (line === "quit") return; setImmediate(() => child.stdout.emit("data", answer(line))); }, end(s) { this.writes.push(`END:${s}`); } };
  child.kill = () => { child.killed = true; };
  const spawnImpl = (bin, args, opts) => { spawned.push({ bin, args, env: opts.env }); setImmediate(() => child.stdout.emit("data", readyLine)); return child; };
  return { child, spawned, spawnImpl };
}

// CHALLENGE HAND-OFF: a real-time hold is a press and a release as two separate calls (the button stays down between).
{
  const h = fakeHelper();
  const p = createHeadlessPointer({ binary: "/x/headless_pointer", env: {}, spawnImpl: h.spawnImpl, exists: () => true });
  await p.move(10, 20);
  await p.press("left");
  const afterPress = h.child.stdin.writes.slice();
  await p.release("left");
  check("press re-asserts the position and presses; release is its own command later", JSON.stringify(afterPress) === JSON.stringify(["move 10 20\n", "move 10 20\n", "button left press\n"]) && h.child.stdin.writes.at(-1) === "button left release\n", JSON.stringify(h.child.stdin.writes));
  await p.press("thumb"); await p.release("thumb");
  check("an unknown button name falls back to left", h.child.stdin.writes.slice(-2).join("") === "button left press\nbutton left release\n", JSON.stringify(h.child.stdin.writes.slice(-2)));
  p.close();
}

// happy path
{
  const h = fakeHelper();
  const logs = [];
  const p = createHeadlessPointer({ binary: "/x/headless_pointer", env: { WAYLAND_DISPLAY: "wayland-headless-3" }, spawnImpl: h.spawnImpl, exists: () => true, log: (l) => logs.push(l) });
  check("nothing is spawned before the first action", h.spawned.length === 0 && p.running === false, "");
  await p.move(890, 356);
  check("the first action starts the helper with the instance env", h.spawned.length === 1 && h.spawned[0].bin === "/x/headless_pointer" && h.spawned[0].env.WAYLAND_DISPLAY === "wayland-headless-3", JSON.stringify(h.spawned));
  await p.click("left", 1);
  await p.click("right", 2);
  await p.scroll(-3);
  // A click is a real gesture, not a bare synthetic press: a fresh motion at the target immediately
  // before the press, then press and release as SEPARATE commands so the helper's per-command round
  // trip lets the compositor process the press (a measured hold) before the release. Both halves are
  // in the stdin protocol; a 2x click repeats the whole gesture.
  check("the exact command lines, in order", JSON.stringify(h.child.stdin.writes) === JSON.stringify([
    "move 890 356\n",
    "move 890 356\n", "button left press\n", "button left release\n",
    "move 890 356\n", "button right press\n", "button right release\n",
    "move 890 356\n", "button right press\n", "button right release\n",
    "scroll -3\n",
  ]), JSON.stringify(h.child.stdin.writes));
  check("a click re-asserts motion at the target before the press, and press/release are distinct",
    h.child.stdin.writes.slice(1, 4).join("") === "move 890 356\nbutton left press\nbutton left release\n", JSON.stringify(h.child.stdin.writes.slice(1, 4)));
  check("running after the start; no fallback log", p.running === true && logs.length === 0, JSON.stringify(logs));
  let threw = null; try { await p.click("left", 4); } catch (e) { threw = e; }
  check("clicks are bounded 1..3", threw instanceof RangeError, String(threw));
  threw = null; try { await p.scroll(0); } catch (e) { threw = e; }
  check("a zero scroll is refused before the helper", threw instanceof RangeError, String(threw));
  await p.move(-5, 2000);
  check("negative coordinates are clamped to zero before the helper (the helper clamps the far side)", h.child.stdin.writes.at(-1) === "move 0 2000\n", h.child.stdin.writes.at(-1));
  p.close();
  check("close sends quit and kills", h.child.stdin.writes.at(-1) === "END:quit\n" && h.child.killed === true && p.running === false, "");
}
// the helper answers err
{
  const h = fakeHelper({ answer: (line) => (line.startsWith("scroll") ? "err scroll\n" : "ok\n") });
  const p = createHeadlessPointer({ binary: "/x/hp", spawnImpl: h.spawnImpl, exists: () => true });
  await p.move(1, 1);
  let threw = null; try { await p.scroll(2); } catch (e) { threw = e; }
  check("an err answer is a coded error", threw?.code === "headless_pointer_error" && /err scroll/.test(threw.message), String(threw));
  await p.move(2, 2);
  check("the helper keeps serving after an err", h.child.stdin.writes.at(-1) === "move 2 2\n", "");
}
// missing binary: available() false, one log, actions throw a coded error
{
  const h = fakeHelper();
  const logs = [];
  const p = createHeadlessPointer({ binary: "/nowhere/headless_pointer", spawnImpl: h.spawnImpl, exists: () => false, log: (l) => logs.push(l) });
  check("available() is false without the binary", (await p.available()) === false && h.spawned.length === 0, "");
  let threw = null; try { await p.move(1, 1); } catch (e) { threw = e; }
  check("actions then throw headless_pointer_unavailable", threw?.code === "headless_pointer_unavailable", String(threw));
  await p.available();
  check("one fallback log line, not one per call", logs.length === 1 && /missing/.test(logs[0]), JSON.stringify(logs));
}
// the helper never reports ready
{
  const h = fakeHelper({ readyLine: "headless_pointer: seat or zwlr_virtual_pointer_manager_v1 missing\n" });
  const logs = [];
  const p = createHeadlessPointer({ binary: "/x/hp", spawnImpl: h.spawnImpl, exists: () => true, log: (l) => logs.push(l) });
  check("a helper that does not say ready is unavailable and killed", (await p.available()) === false && h.child.killed === true && logs.length === 1, JSON.stringify(logs));
}
// the helper exits mid-flight
{
  const h = fakeHelper({ answer: () => "" });
  const p = createHeadlessPointer({ binary: "/x/hp", spawnImpl: h.spawnImpl, exists: () => true });
  await p.available();
  const pending = p.move(3, 3);
  await tick();
  h.child.emit("exit", 1);
  let threw = null; try { await pending; } catch (e) { threw = e; }
  check("an exit answers every outstanding command with an error and the client stops", threw?.code === "headless_pointer_error" && p.running === false, String(threw));
}
// binary resolution and the build script's freshness rule (pure parts)
{
  check("HEADLESS_POINTER_BIN overrides the repo build path", defaultHelperBinary({ HEADLESS_POINTER_BIN: "/opt/hp" }) === "/opt/hp" && /\/build\/headless_pointer$/.test(defaultHelperBinary({})), defaultHelperBinary({}));
  const paths = helperPaths("/repo");
  check("helper paths are rooted at the repo", paths.binary === "/repo/build/headless_pointer" && paths.protocol === "/repo/protocols/wlr-virtual-pointer-unstable-v1.xml" && paths.source === "/repo/native/headless_pointer.c", JSON.stringify(paths));
  check("a missing binary is not fresh", isFresh(helperPaths("/nonexistent-root")) === false, "");
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args].join(" ")); return Buffer.from(cmd === "pkg-config" && args[0] === "--cflags" ? "-lwayland-client -lm\n" : ""); };
  const r = buildHelper({ paths: helperPaths("/nonexistent-root"), exec, mkdir: () => {}, force: true });
  check("the build runs wayland-scanner twice then cc with the pkg-config flags", r.built === true && calls.some((c) => c.startsWith("wayland-scanner client-header")) && calls.some((c) => c.startsWith("wayland-scanner private-code")) && calls.some((c) => /^cc -O2 -Wall -I\/nonexistent-root\/build -o \/nonexistent-root\/build\/headless_pointer .*-lwayland-client -lm$/.test(c)), JSON.stringify(calls));
  let threw = null; try { buildHelper({ paths: helperPaths("/nonexistent-root"), exec: (cmd) => { if (cmd === "cc") throw new Error("nope"); return Buffer.from(""); }, mkdir: () => {}, force: true }); } catch (e) { threw = e; }
  check("a missing tool is named", threw?.code === "toolchain_missing" && threw.tool === "cc", String(threw));
}
console.log(fail ? `FAIL — ${pass} passed, ${fail} failed` : `PASS — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
