#!/usr/bin/env node
// Deterministic tests for the Chromium exit diagnostic. No browser, no
// compositor, no live store: the recorder is driven with a fake child process
// against a real temporary directory, so atomic writes and teardown behaviour
// are exercised for real rather than simulated.
//
// The property that matters most and is asserted from several directions: NO
// CAPTURED STDERR BYTE EVER REACHES DISK OR OUTPUT. Chromium's stderr carries
// profile paths and, in some builds, page-authored console text; the ring
// buffer exists only to derive fixed marker enums and byte counts.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  BoundedStderr, runningRecord, applyExitEvent, validateExitRecord, formatExitDiagnostic,
  EXIT_LOG_BASENAME, EXIT_RECORD_SCHEMA, MAX_EXIT_LOG_BYTES, STDERR_MAX_LINES,
} from "./chromium_exit.js";
import { attachExitRecorder, stopExitRecorder, instanceEnv } from "./headless_instance.mjs";
import { readChromiumExitRecord, probeLeaderAlive, enrichBridgeResult } from "./index.js";

// Deterministic synchronisation: the recorder serialises every write through
// one promise chain, so awaiting the CURRENT chain (re-read after each emit,
// since it is reassigned) is exact. Counting setImmediate ticks would be a
// guess, and a wrong guess reads a stale file and blames the code.
const flush = async (state) => { for (let i = 0; i < 4; i++) await state.chain; };

// --- BoundedStderr: bounded on both axes, contents never exposed ------------
{
  const ring = new BoundedStderr(64, 3);
  ring.push("alpha\nbeta\ngamma\n");
  assert.equal(ring.truncated, false);
  ring.push("delta\n");
  assert.equal(ring.truncated, true, "the line cap drops the oldest");
  assert.ok(ring.capturedBytes <= 64);
  assert.equal(ring.totalBytes, "alpha\nbeta\ngamma\n".length + "delta\n".length, "total counts everything ever seen");
}
{
  const ring = new BoundedStderr(50, 1000);
  for (let i = 0; i < 500; i++) ring.push(`line ${i} with some padding text\n`);
  assert.ok(ring.capturedBytes <= 50, `byte cap holds under a flood (${ring.capturedBytes})`);
  assert.equal(ring.truncated, true);
  assert.ok(ring.totalBytes > 10000, "but the total still reflects the flood");
}
{
  const ring = new BoundedStderr();
  for (let i = 0; i < STDERR_MAX_LINES * 3; i++) ring.push(`noise ${i}\n`);
  assert.ok(ring.capturedBytes <= 64 * 1024);
}
{
  // Markers are derived, and only names are ever produced.
  const ring = new BoundedStderr();
  ring.push("[1:1:0831/1.234:ERROR] Received signal 11 SEGV_MAPERR\n");
  assert.deepEqual(ring.markers(), ["received_signal"], "only the signature actually present is reported");
  const quiet = new BoundedStderr();
  quiet.push("[INFO] ordinary chatter about fonts and gpu\n");
  assert.deepEqual(quiet.markers(), [], "ordinary noise matches nothing");
  // Binary-ish input must not throw.
  const bin = new BoundedStderr();
  bin.push(Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a]));
  assert.ok(bin.totalBytes > 0);
}

// --- record lifecycle: exit is authoritative, close never clobbers it -------
{
  const base = runningRecord({ leaderPid: 100 });
  assert.equal(base.state, "running");
  assert.equal(base.exit_code, null);

  const exited = applyExitEvent(base, { event: "exit", code: 0, signal: null, msFromSpawn: 500 });
  assert.equal(exited.state, "exited");
  assert.equal(exited.exit_code, 0);

  const closedAfter = applyExitEvent(exited, { event: "close", code: null, signal: null, msFromSpawn: 600 });
  assert.equal(closedAfter.state, "exited", "close must not downgrade a recorded exit");
  assert.equal(closedAfter.exit_code, 0, "and must not erase the code");
  assert.equal(closedAfter.ms_from_spawn, 500, "nor the timing of the exit itself");

  // The other arrival order.
  const closedFirst = applyExitEvent(base, { event: "close", code: null, signal: null, msFromSpawn: 400 });
  assert.equal(closedFirst.state, "closed");
  const exitedAfter = applyExitEvent(closedFirst, { event: "exit", code: null, signal: "SIGSEGV", msFromSpawn: 450 });
  assert.equal(exitedAfter.state, "exited", "a later exit is authoritative over an earlier close");
  assert.equal(exitedAfter.exit_signal, "SIGSEGV");
}

// --- strict validation -------------------------------------------------------
const good = applyExitEvent(runningRecord({ leaderPid: 100 }),
  { event: "exit", code: 0, signal: null, msFromSpawn: 10, stderr: { total_bytes: 1, captured_bytes: 1, truncated: false }, markers: [], windowPid: 100 });
assert.equal(validateExitRecord(good).ok, true);
for (const [label, mutate] of [
  ["null", () => null],
  ["an array", () => []],
  ["a string", () => "x"],
  ["unknown schema", (r) => ({ ...r, schema: "other/9" })],
  ["missing schema", (r) => { const c = { ...r }; delete c.schema; return c; }],
  ["unknown state", (r) => ({ ...r, state: "vanished" })],
  ["missing leader_pid", (r) => ({ ...r, leader_pid: null })],
  ["negative leader_pid", (r) => ({ ...r, leader_pid: -3 })],
  ["string leader_pid", (r) => ({ ...r, leader_pid: "100" })],
  ["bad window_pid", (r) => ({ ...r, window_pid: 1.5 })],
  ["non-integer exit_code", (r) => ({ ...r, exit_code: "0" })],
  ["out-of-range exit_code", (r) => ({ ...r, exit_code: 999 })],
  ["free-text exit_signal", (r) => ({ ...r, exit_signal: "totally not a signal" })],
  ["negative ms", (r) => ({ ...r, ms_from_spawn: -1 })],
  ["missing stderr counts", (r) => ({ ...r, stderr: {} })],
  ["non-boolean truncated", (r) => ({ ...r, stderr: { ...r.stderr, truncated: "no" } })],
  ["markers not an array", (r) => ({ ...r, markers: "received_signal" })],
  ["unknown marker", (r) => ({ ...r, markers: ["definitely_not_a_marker"] })],
]) {
  const v = validateExitRecord(mutate(good));
  assert.equal(v.ok, false, `${label} must be refused`);
  assert.ok(typeof v.reason === "string" && v.reason.length, `${label} must say why`);
}

// --- the one-line diagnostic -------------------------------------------------
{
  const line = formatExitDiagnostic(validateExitRecord(good), false);
  assert.equal(line.includes("\n"), false, "one line");
  assert.match(line, /leader_exit=code:0/);
  assert.match(line, /leader_pid_matches_window_pid=true/);
  assert.match(line, /leader_alive_now=false/);
  assert.match(line, /exit code\/signal is authoritative; markers are corroborative only/);
  assert.match(line, /a live leader does not prove a healthy browser/);

  const sig = applyExitEvent(good, { event: "exit", code: null, signal: "SIGSEGV", msFromSpawn: 10 });
  assert.match(formatExitDiagnostic(validateExitRecord(sig), null), /leader_exit=signal:SIGSEGV/);
  assert.match(formatExitDiagnostic(validateExitRecord(sig), null), /leader_alive_now=unknown/);

  // Still running, and a live leader is reported WITHOUT implying health.
  const running = runningRecord({ leaderPid: 100 });
  const runLine = formatExitDiagnostic(validateExitRecord(running), true);
  assert.match(runLine, /leader_exit=running/);
  assert.match(runLine, /leader_alive_now=true/);
  assert.match(runLine, /does not prove a healthy browser/);

  // Unavailable shapes fail closed and never imply an outcome.
  for (const v of [{ ok: false, reason: "no exit record" }, { ok: false, reason: "unreadable exit record" }, null, undefined]) {
    const l = formatExitDiagnostic(v, null);
    assert.match(l, /chromium exit diagnostic unavailable/);
    assert.equal(/leader_exit=/.test(l), false, "no verdict without a record");
  }
}

// --- the recorder against a REAL directory ----------------------------------
class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stderr = new Readable({ read() {} });
  }
}
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "exit-rec-test-"));
const readRecord = async (dir) => JSON.parse(await readFile(path.join(dir, EXIT_LOG_BASENAME), "utf8"));

{
  // PRECREATED: a record exists before anything has ended, so an observer can
  // distinguish "still running" from "no recorder at all".
  const dir = path.join(tmpRoot, "precreate");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = { chromiumPid: 555 };
  const child = new FakeChild(555);
  const state = attachExitRecorder(handle, child, dir);
  await flush(state);
  const rec = await readRecord(dir);
  assert.equal(rec.schema, EXIT_RECORD_SCHEMA);
  assert.equal(rec.state, "running");
  assert.equal(rec.leader_pid, 555);
  assert.equal(validateExitRecord(rec).ok, true, "the precreated record validates");
}
{
  // EXIT then CLOSE, through the real event path, with stderr flowing.
  const dir = path.join(tmpRoot, "exit-then-close");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = { chromiumPid: 777 };
  const child = new FakeChild(777);
  const state = attachExitRecorder(handle, child, dir);
  child.stderr.push("[ERROR] Received signal 11 SEGV_MAPERR at 0xdeadbeef\n");
  child.stderr.push("secret-profile-path /tmp/computer-use-headless-abc/profile\n");
  await flush(state);
  child.emit("exit", null, "SIGSEGV");
  await flush(state);
  child.emit("close", null, "SIGSEGV");
  await flush(state);

  const rec = await readRecord(dir);
  assert.equal(rec.state, "exited");
  assert.equal(rec.exit_signal, "SIGSEGV");
  assert.equal(rec.window_pid, 777);
  assert.ok(rec.markers.includes("received_signal"), "markers are derived from stderr");
  assert.ok(rec.stderr.total_bytes > 0, "byte counts are recorded");

  // THE CENTRAL PROPERTY: no captured stderr text on disk.
  const raw = await readFile(path.join(dir, EXIT_LOG_BASENAME), "utf8");
  assert.equal(raw.includes("SEGV_MAPERR"), false, "no raw stderr in the file");
  assert.equal(raw.includes("secret-profile-path"), false, "no profile path in the file");
  assert.equal(raw.includes("0xdeadbeef"), false);
  // ...nor in the model-visible line.
  const line = formatExitDiagnostic(validateExitRecord(rec), false);
  assert.equal(line.includes("SEGV_MAPERR"), false, "no raw stderr in the output");
  assert.equal(line.includes("/tmp/"), false, "no filesystem path in the output");

  // ATOMIC: no temp file survives.
  const left = await readdir(dir);
  assert.deepEqual(left, [EXIT_LOG_BASENAME], `only the record remains, got ${JSON.stringify(left)}`);
}
{
  // MONOTONIC across arrival order, through the real chain.
  const dir = path.join(tmpRoot, "close-then-exit");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const child = new FakeChild(888);
  const state = attachExitRecorder({ chromiumPid: 888 }, child, dir);
  await flush(state);
  child.emit("close", 0, null);
  child.emit("exit", 0, null);
  await flush(state);
  const rec = await readRecord(dir);
  assert.equal(rec.state, "exited", "exit wins regardless of arrival order");
  assert.equal(rec.exit_code, 0);
}
{
  // TEARDOWN TOLERANCE: after stopping and removing the directory, a late
  // event must not recreate anything — a recreated path would defeat the
  // verified-absence teardown and leak a directory.
  const dir = path.join(tmpRoot, "late-event");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = { chromiumPid: 999 };
  const child = new FakeChild(999);
  const state = attachExitRecorder(handle, child, dir);
  await flush(state);
  stopExitRecorder(handle);
  await rm(dir, { recursive: true, force: true });
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  await flush(state);
  let exists = true;
  try { await readdir(dir); } catch { exists = false; }
  assert.equal(exists, false, "a late event must not recreate the removed directory");
}

// --- the observer's read: strict, size-capped, fails closed -----------------
{
  const dir = path.join(tmpRoot, "observer");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const logPath = path.join(dir, EXIT_LOG_BASENAME);
  await writeFile(logPath, JSON.stringify(good));
  assert.equal((await readChromiumExitRecord({ logPath, workDir: dir })).ok, true, "a valid record reads back");

  // THE PATH IS BOUND TO THE TRUSTED INSTANCE DIRECTORY, and every rejection
  // happens BEFORE any filesystem call — asserted by counters, not by reading
  // the source. Absolute-plus-basename alone would accept any file on the box.
  let stats = 0, reads = 0;
  const counting = { stat: async () => { stats++; return { size: 10 }; }, readFile: async () => { reads++; return "{}"; } };
  const zeroIo = async (label, args) => {
    stats = 0; reads = 0;
    const out = await readChromiumExitRecord({ ...counting, ...args });
    assert.equal(out.ok, false, `${label} is refused`);
    assert.equal(stats + reads, 0, `${label} must not touch the filesystem at all`);
    return out;
  };
  assert.equal((await zeroIo("no configured path", { logPath: "", workDir: dir })).reason, "no HEADLESS_EXIT_LOG");
  assert.equal((await zeroIo("no work dir", { logPath, workDir: "" })).reason, "no HEADLESS_WORK_DIR");
  assert.equal((await zeroIo("relative work dir", { logPath, workDir: "relative/dir" })).reason, "no HEADLESS_WORK_DIR");
  assert.equal((await zeroIo("relative log path", { logPath: "relative/chromium-exit.json", workDir: dir })).reason, "unexpected exit-log path");
  assert.equal((await zeroIo("wrong basename", { logPath: path.join(dir, "other-name.json"), workDir: dir })).reason, "unexpected exit-log path");
  assert.equal((await zeroIo("ARBITRARY absolute path", { logPath: "/etc/chromium-exit.json", workDir: dir })).reason, "unexpected exit-log path");
  assert.equal((await zeroIo("another instance's dir", { logPath: "/tmp/other-instance/chromium-exit.json", workDir: dir })).reason, "unexpected exit-log path");
  assert.equal((await zeroIo("traversal out of the work dir", { logPath: path.join(dir, "..", EXIT_LOG_BASENAME), workDir: dir })).reason, "unexpected exit-log path");
  assert.equal((await zeroIo("traversal back in via ..", { logPath: path.join(dir, "sub", "..", "..", EXIT_LOG_BASENAME), workDir: dir })).reason, "unexpected exit-log path");
  // ...and a traversal that RESOLVES to the trusted file is accepted, proving
  // the check is on the resolved path rather than on the spelling.
  assert.equal((await readChromiumExitRecord({ logPath: path.join(dir, "sub", "..", EXIT_LOG_BASENAME), workDir: dir })).ok, true);

  // Missing, oversized, malformed, and invalid all fail closed with a reason.
  assert.equal((await readChromiumExitRecord({ logPath, workDir: dir, stat: async () => ({ size: MAX_EXIT_LOG_BYTES + 1 }) })).reason, "exit record too large");
  await writeFile(logPath, "{ not json");
  assert.equal((await readChromiumExitRecord({ logPath, workDir: dir })).reason, "unreadable exit record");
  await writeFile(logPath, JSON.stringify({ schema: "other/1" }));
  assert.equal((await readChromiumExitRecord({ logPath, workDir: dir })).reason, "unknown schema");
  await rm(logPath, { force: true });
  assert.equal((await readChromiumExitRecord({ logPath, workDir: dir })).reason, "no exit record");
}

// --- the liveness probe is separate and honest ------------------------------
assert.equal(probeLeaderAlive(process.pid), true, "our own pid is held");
assert.equal(probeLeaderAlive(2 ** 31 - 1), false, "an impossible pid is not");
assert.equal(probeLeaderAlive(0), null, "a non-pid is unknown, not false");
assert.equal(probeLeaderAlive(-1), null);
assert.equal(probeLeaderAlive(null), null);
assert.equal(probeLeaderAlive(123, () => { const e = new Error("denied"); e.code = "EPERM"; throw e; }), true, "EPERM means held by someone else");
assert.equal(probeLeaderAlive(123, () => { const e = new Error("gone"); e.code = "ESRCH"; throw e; }), false);
assert.equal(probeLeaderAlive(123, () => { throw new Error("weird"); }), null, "an unrecognised error is unknown, never a verdict");

// --- MONOTONIC clock: a wall clock that steps BACKWARDS must not poison it ---
{
  const dir = path.join(tmpRoot, "monotonic");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let t = 1000;
  const child = new FakeChild(4242);
  const state = attachExitRecorder({ chromiumPid: 4242 }, child, dir, { now: () => t });
  await state.ready;
  t = 400; // NTP step / suspend: the clock goes backwards
  child.emit("exit", 0, null);
  await flush(state);
  const rec = await readRecord(dir);
  assert.equal(rec.ms_from_spawn >= 0, true, "a backward clock can never produce a negative age");
  assert.equal(rec.ms_from_spawn, 0, "it clamps rather than reporting nonsense");
  assert.equal(validateExitRecord(rec).ok, true);
  assert.equal("spawned_at_ms" in rec, false, "no epoch wall-clock value is persisted");
}
{
  // A normal forward clock reports the real delta, rounded to an integer.
  const dir = path.join(tmpRoot, "monotonic-forward");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let t = 10.25;
  const child = new FakeChild(4343);
  const state = attachExitRecorder({ chromiumPid: 4343 }, child, dir, { now: () => t });
  await state.ready;
  t = 1510.75;
  child.emit("exit", null, "SIGSEGV");
  await flush(state);
  const rec = await readRecord(dir);
  assert.equal(rec.ms_from_spawn, 1501);
  assert.equal(rec.exit_signal, "SIGSEGV");
  assert.equal(rec.exit_code, null, "a signal exit carries no code");
}

// --- the PRECREATE BARRIER is awaitable and settles explicitly ---------------
{
  const dir = path.join(tmpRoot, "barrier");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const state = attachExitRecorder({ chromiumPid: 1 }, new FakeChild(1), dir);
  const ready = await state.ready;
  assert.deepEqual(ready, { ok: true }, "the barrier settles as an explicit outcome");
  // The file exists the moment the barrier resolves — no draining needed.
  assert.equal((await readRecord(dir)).state, "running");
}
{
  // An initial-write failure must SETTLE AS A FAILURE, never be silently
  // reported as precreated.
  const missing = path.join(tmpRoot, "does-not-exist-at-all");
  const state = attachExitRecorder({ chromiumPid: 2 }, new FakeChild(2), missing);
  const ready = await state.ready;
  assert.equal(ready.ok, false, "a failed precreate is reported, not assumed");
  assert.ok(typeof ready.reason === "string" && ready.reason.length, "and says why");
}

// --- markers SPLIT ACROSS CHUNKS are still recognised ------------------------
{
  const ring = new BoundedStderr();
  ring.push("[ERROR] Received sig");
  ring.push("nal 11 SEGV_MAPERR\n");
  assert.ok(ring.markers().includes("received_signal"), "a marker split across two chunks is not missed");
  // Note SEGV_MAPERR does NOT contain the literal "SIGSEGV" — the sigsegv
  // marker is a separate signature, split here across its own boundary.
  const split = new BoundedStderr();
  split.push("thread crashed with SIG");
  split.push("SEGV inside the renderer\n");
  assert.ok(split.markers().includes("sigsegv"), "a second signature also survives a split");
}
{
  // Byte-by-byte delivery, the worst case.
  const ring = new BoundedStderr();
  for (const ch of "Check failed: something\n") ring.push(ch);
  assert.ok(ring.markers().includes("check_failed"), "byte-at-a-time delivery still matches");
}
{
  // A marker seen EARLY survives eviction of the line that carried it — the
  // ring drops old lines, but a crash signature must not be forgotten.
  const ring = new BoundedStderr(64, 2);
  ring.push("FATAL: something exploded\n");
  for (let i = 0; i < 50; i++) ring.push(`filler line ${i}\n`);
  assert.ok(ring.markers().includes("fatal_error"), "eviction must not erase a recorded marker");
}
{
  // Raw byte counting happens BEFORE decoding: a multi-byte sequence is
  // measured as written, and a chunk split mid-character does not throw.
  const ring = new BoundedStderr();
  const euro = Buffer.from("€\n", "utf8"); // 3 bytes + newline
  ring.push(euro.subarray(0, 2));
  ring.push(euro.subarray(2));
  assert.equal(ring.totalBytes, euro.length, "raw bytes counted, not decoded characters");
}

// --- in-flight write racing stop + removal -----------------------------------
{
  // The hard case: a write is ALREADY in flight when teardown stops the
  // recorder and removes the directory. Nothing may be recreated — not the
  // record, not a temp file, not the directory itself.
  const dir = path.join(tmpRoot, "inflight");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = { chromiumPid: 7777 };
  const child = new FakeChild(7777);
  const state = attachExitRecorder(handle, child, dir);
  await state.ready;
  child.emit("exit", null, "SIGKILL");        // starts a write
  const stopped = stopExitRecorder(handle);    // stop lands while it is in flight
  await rm(dir, { recursive: true, force: true });
  await stopped;                               // teardown drains before removing
  child.emit("close", null, "SIGKILL");         // and a later event too
  await flush(state);
  let exists = true;
  try { await readdir(dir); } catch { exists = false; }
  assert.equal(exists, false, "an in-flight write must not resurrect the removed directory");
}

// --- WRITER -> JSON -> VALIDATOR -> FORMATTER, end to end -------------------
// The defect this pins (found by codex and reproduced independently by Fable):
// totalBytes counted raw newline bytes while the retained count stored only
// non-empty line TEXT, so ordinary "FATAL...\n" gave total 23 / captured 22 /
// truncated false — a shape the validator correctly refuses. The recorder was
// failing its own schema, and the diagnostic silently became "unavailable"
// exactly when a real crash marker was present.
{
  const dir = path.join(tmpRoot, "roundtrip");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const child = new FakeChild(31337);
  const state = attachExitRecorder({ chromiumPid: 31337 }, child, dir);
  await state.ready;
  child.stderr.push("FATAL: renderer went away\n");   // ordinary, newline-terminated
  child.emit("exit", null, "SIGABRT");
  await flush(state);

  const onDisk = JSON.parse(await readFile(path.join(dir, EXIT_LOG_BASENAME), "utf8"));
  assert.equal(onDisk.stderr.total_bytes, onDisk.stderr.captured_bytes,
    "untruncated input must retain every byte it counted, delimiters included");
  assert.equal(onDisk.stderr.truncated, false);
  const validated = validateExitRecord(onDisk);
  assert.equal(validated.ok, true, `the recorder's own output must validate (got ${validated.reason})`);
  const line = formatExitDiagnostic(validated, false);
  assert.match(line, /leader_exit=signal:SIGABRT/, "and reach the formatter as a real verdict");
  assert.match(line, /markers=\[fatal_error\]/);
  assert.equal(/diagnostic unavailable/.test(line), false, "never degrades to unavailable");
}
{
  // CRLF and empty lines are ordinary Chromium output; they must not skew the
  // accounting either.
  const ring = new BoundedStderr();
  ring.push("alpha\r\n\r\n\r\nbeta\r\n");
  assert.equal(ring.capturedBytes, ring.totalBytes, "CRLF and blank lines are retained byte for byte");
  assert.equal(ring.truncated, false);
  const ends = new BoundedStderr();
  ends.push("no trailing newline");
  assert.equal(ends.capturedBytes, ends.totalBytes, "a trailing partial line is retained too");
  const empties = new BoundedStderr();
  empties.push("\n\n\n");
  assert.equal(empties.capturedBytes, empties.totalBytes, "delimiters alone are still bytes");
}
{
  // Once truncation DOES happen the record stays self-consistent: captured is
  // below total, and truncated says so.
  const ring = new BoundedStderr(32, 1000);
  for (let i = 0; i < 40; i++) ring.push(`0123456789\n`);
  const stats = ring.stats();
  assert.ok(stats.captured_bytes <= 32, "the byte cap holds");
  assert.ok(stats.captured_bytes < stats.total_bytes);
  assert.equal(stats.truncated, true, "and dropped bytes are declared");
  const rec = applyExitEvent(runningRecord({ leaderPid: 5, windowPid: 5 }),
    { event: "exit", code: 0, signal: null, msFromSpawn: 1, stderr: stats, markers: ring.markers(), windowPid: 5 });
  assert.equal(validateExitRecord(rec).ok, true, "a truncated record validates as well");
}
{
  // Line-cap eviction is also byte-conserving and still declares truncation.
  const ring = new BoundedStderr(1 << 20, 2);
  ring.push("one\ntwo\nthree\nfour\n");
  const stats = ring.stats();
  assert.ok(stats.captured_bytes < stats.total_bytes);
  assert.equal(stats.truncated, true);
  assert.equal(validateExitRecord(applyExitEvent(runningRecord({ leaderPid: 5 }),
    { event: "close", msFromSpawn: 1, stderr: stats, markers: [] })).ok, true);
}

// --- a FAILED precreate is surfaced, not silently indistinguishable ---------
{
  // Spawn must not fail for a diagnostic, but the observer must be able to say
  // "never created" rather than reporting a merely absent file.
  const missing = path.join(tmpRoot, "no-such-dir-for-precreate");
  const state = attachExitRecorder({ chromiumPid: 3 }, new FakeChild(3), missing);
  const ready = await state.ready;
  assert.equal(ready.ok, false);

  // The instanceEnv contract carries the outcome as a bounded flag.
  const failedEnv = instanceEnv({ workDir: "/tmp/inst", runtimeDir: "/run/x", waylandDisplay: "wayland-1", chromiumPid: 1, width: 1, height: 1, swaySock: "/s", exitRecorderReady: false });
  assert.equal(failedEnv.HEADLESS_EXIT_LOG_READY, "0");
  const okEnv = instanceEnv({ workDir: "/tmp/inst", runtimeDir: "/run/x", waylandDisplay: "wayland-1", chromiumPid: 1, width: 1, height: 1, swaySock: "/s", exitRecorderReady: true });
  assert.equal(okEnv.HEADLESS_EXIT_LOG_READY, "1");
  assert.equal(/error|Error|ENOENT|no-such-dir/.test(JSON.stringify(failedEnv)), false, "no raw error text or failure path in the env");

  // ...and the observer reports that fixed reason, with ZERO filesystem calls.
  let stats2 = 0, reads2 = 0;
  const out = await readChromiumExitRecord({
    logPath: failedEnv.HEADLESS_EXIT_LOG,
    workDir: failedEnv.HEADLESS_WORK_DIR,
    ready: failedEnv.HEADLESS_EXIT_LOG_READY,
    stat: async () => { stats2++; return { size: 1 }; },
    readFile: async () => { reads2++; return "{}"; },
  });
  assert.deepEqual(out, { ok: false, reason: "exit record was never created" });
  assert.equal(stats2 + reads2, 0, "a never-created record must not be looked for on disk");
  assert.match(formatExitDiagnostic(out, null), /unavailable: exit record was never created/);
}

// --- the gate decides ALL reads, proven by counting --------------------------
{
  let windowProbes = 0, exitReads = 0, liveProbes = 0;
  const deps = {
    probeCurrentWindowPid: async () => { windowProbes++; return { available: false, reason: "test" }; },
    readChromiumExitRecord: async () => { exitReads++; return { ok: false, reason: "test" }; },
    probeLeaderAlive: () => { liveProbes++; return null; },
  };
  const reset = () => { windowProbes = 0; exitReads = 0; liveProbes = 0; };
  const APP_LOST = "no AT-SPI application found for pid 724847";

  // Every shape that must perform ZERO reads.
  for (const [label, result, backend] of [
    ["a successful snapshot", { elements: [] }, "headless"],
    ["another bridge error", { error: "stale ref" }, "headless"],
    ["a near-miss error string", { error: `${APP_LOST} extra` }, "headless"],
    ["the same error on hyprland", { error: APP_LOST }, "hyprland"],
    ["no backend", { error: APP_LOST }, undefined],
  ]) {
    reset();
    const out = await enrichBridgeResult({ ...result }, backend, deps);
    assert.equal(exitReads, 0, `${label}: zero exit-record reads`);
    assert.equal(windowProbes, 0, `${label}: zero window probes`);
    assert.equal(out.error, result.error, `${label}: the result is returned untouched`);
  }

  // The one shape that reads — AT MOST ONCE each.
  reset();
  const enriched = await enrichBridgeResult({ error: APP_LOST }, "headless", deps);
  assert.equal(exitReads, 1, "exactly one exit-record read on the exact gate");
  assert.equal(windowProbes, 1, "exactly one window probe");
  assert.match(enriched.error, /app-lookup diagnostic/);
  assert.match(enriched.error, /chromium exit diagnostic unavailable/);
  assert.equal(enriched.error.includes("\n"), false, "the enriched error stays one line");

  // The liveness probe is only taken when there is a record to take it for.
  reset();
  await enrichBridgeResult({ error: APP_LOST }, "headless", {
    ...deps,
    readChromiumExitRecord: async () => { exitReads++; return validateExitRecord(good); },
  });
  assert.equal(liveProbes, 1, "one liveness probe when a record exists");
}

await rm(tmpRoot, { recursive: true, force: true });
console.log("PASS — chromium exit diagnostic (bounded, text-free, atomic, fail-closed)");
