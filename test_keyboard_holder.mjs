// node test_keyboard_holder.mjs — the instance's keyboard holder (headless_instance.mjs startKeyboardHolder/stopKeyboardHolder): up
// only on "ready", null (and the instance runs as before) with no binary / no ready; stopped by "quit", else SIGTERM. Fake processes.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startKeyboardHolder, stopKeyboardHolder } from "./headless_instance.mjs";
const fakeProc = ({ say = "ready\n", exitOnQuit = true } = {}) => {
  const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stdout.resume = () => {}; p.exitCode = null; p.signalCode = null;
  const written = []; p.killed = [];
  p.stdin = { write: (x) => { written.push(x); if (exitOnQuit && x === "quit\n") setTimeout(() => { p.exitCode = 0; p.emit("exit", 0); }, 5); }, end: () => {} };
  p.kill = (sig) => { p.killed.push(sig); p.signalCode = sig; setTimeout(() => p.emit("exit", null, sig), 5); };
  p.written = written;
  if (say) setTimeout(() => p.stdout.emit("data", Buffer.from(say)), 10);
  return p;
};
let spawned = null;
const ok = await startKeyboardHolder({ env: {}, binary: "/bin/hk", exists: () => true, spawnImpl: (...a) => (spawned = { a, p: fakeProc() }).p });
assert.ok(ok.proc, "ready → held"); assert.equal(spawned.a[0], "/bin/hk"); assert.deepEqual(spawned.a[2].stdio, ["pipe", "pipe", "ignore"], "never detached: its stdin closing ends it");
await stopKeyboardHolder(ok.proc);
assert.deepEqual(ok.proc.written, ["quit\n"]); assert.deepEqual(ok.proc.killed, [], "quit was enough");
const stubborn = await startKeyboardHolder({ env: {}, binary: "/bin/hk", exists: () => true, spawnImpl: () => fakeProc({ exitOnQuit: false }) });
await stopKeyboardHolder(stubborn.proc, { waitMs: 50 });
assert.deepEqual(stubborn.proc.killed, ["SIGTERM"], "no exit after quit → SIGTERM");
assert.equal((await startKeyboardHolder({ env: {}, binary: "/bin/hk", exists: () => false })).proc, null, "no binary → null");
const silent = await startKeyboardHolder({ env: {}, binary: "/bin/hk", exists: () => true, spawnImpl: () => fakeProc({ say: "" }), timeoutMs: 100 });
assert.equal(silent.proc, null); assert.match(silent.why, /ready/);
await stopKeyboardHolder(null);
console.log("PASS — keyboard holder: up only on ready, stopped by quit or SIGTERM, absent without a helper");
process.exit(0);
