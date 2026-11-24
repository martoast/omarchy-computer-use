#!/usr/bin/env node
// Teardown under signals, proven from OUTSIDE the process being signalled.
//
// MEASURED before this existed: on SIGTERM and on SIGINT the test process died
// and the compositor, the browser and BOTH directories survived — every time.
// sway runs under `setsid` and chromium detached, so each sits in its own
// process group that a signal to the test process never reaches, and no handler
// existed to run the `finally`.
//
// Nothing here trusts the child's own reporting: the child prints a READY
// marker naming the exact resources it owns, and the PARENT then checks those
// pids and paths itself. A child that lied, or died before cleaning up, cannot
// make these assertions pass.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

let pass = 0, fail = 0;
const check = (l, c, d = "") => { console.log(`${c ? "ok  " : "FAIL"} ${l}${c ? "" : "  <<< " + d}`); c ? pass++ : fail++; };
const info = (l, v) => console.log(`  · ${l}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = [];
const ids = (dir, pre) => { try { return readdirSync(dir).filter((n) => n.startsWith(pre)).map((n) => n.slice(pre.length)); } catch { return []; } };
const beforeWork = ids("/tmp", "computer-use-headless-").filter((i) => !i.startsWith("SENTINEL"));
const beforeRuntime = ids(process.env.XDG_RUNTIME_DIR || "/run/user/1000", "computer-use-headless-");
const childFile = (body) => {
  const f = path.join(import.meta.dirname, `child_teardown_${randomUUID().slice(0, 8)}.mjs`);
  writeFileSync(f, body); tmp.push(f); return f;
};

// Runs a child to its READY marker and hands back its declared resources.
async function startChild(body, env = {}) {
  const launched = launchChild(body, env);
  const ready = await new Promise((res) => {
    launched.child.stdout.on("data", (d) => { launched.outText += d; const m = launched.outText.match(/READY (\{.*\})/); if (m) res(JSON.parse(m[1])); });
    launched.child.on("exit", () => res(null));
  });
  return { child: launched.child, ready, out: () => launched.outText, err: () => launched.errText };
}

function launchChild(body, env = {}) {
  const f = childFile(body);
  const child = spawn("node", [f], { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  const launched = { child, outText: "", errText: "" };
  child.stderr.on("data", (d) => (launched.errText += d));
  return launched;
}

// A child that owns `count` instances and holds until signalled.
const HOLD_CHILD = (count, extra = "") => `
import { spawnHeadlessInstance, registerCleanupHook, installedSignalListenerCount } from "./headless_instance.mjs";
const hs = [];
for (let i = 0; i < ${count}; i++) hs.push(await spawnHeadlessInstance({ label: "sigtest" + i }));
${extra}
console.log("READY " + JSON.stringify({
  listeners: installedSignalListenerCount(),
  instances: hs.map((h) => ({ swayPid: h.swayPid, chromiumPid: h.chromiumPid, runtimeDir: h.runtimeDir, workDir: h.workDir })),
}));
// A live timer, NOT an unsettled promise: \`await new Promise(() => {})\` leaves
// the event loop with nothing to do, so node exits 13 ("unsettled top-level
// await") IMMEDIATELY — the child would be dead before the signal arrived and
// every assertion below would fail against a process that was never signalled.
setInterval(() => {}, 1000);
`;

async function signalCase(sig, { count = 1, extra = "", hookPath = null } = {}) {
  console.log(`\n================= ${sig} =================`);
  const started = await startChild(HOLD_CHILD(count, extra));
  const { child, ready } = started;
  if (!ready) return check(`${sig}: child reached READY`, false, `never became ready; stderr=${started.err()}`);
  info(`${sig} owned`, ready.instances.map((i) => ({ sway: i.swayPid, chromium: i.chromiumPid })));

  // PRECONDITION: the resources genuinely exist, so their later absence means
  // something. Without this the case could "pass" against a child that never
  // started anything.
  const before = ready.instances.every((i) => alive(i.swayPid) && alive(i.chromiumPid) && existsSync(i.runtimeDir) && existsSync(i.workDir));
  check(`${sig} precondition: every owned process and BOTH dirs exist`, before, JSON.stringify(ready.instances));

  const exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
  child.kill(sig);
  const ex = await exited;
  await sleep(1200);

  // CONVENTIONAL SIGNAL TERMINATION: asserted on the `signal` field itself, not
  // on a 128+N exit code, which a handler could fake by calling process.exit.
  check(`${sig} the child reports killed-by-${sig}, not a plain exit`, ex.signal === sig, JSON.stringify(ex));

  for (const [n, i] of ready.instances.entries()) {
    check(`${sig} instance ${n}: compositor gone`, !alive(i.swayPid), `sway ${i.swayPid} alive`);
    check(`${sig} instance ${n}: browser gone`, !alive(i.chromiumPid), `chromium ${i.chromiumPid} alive`);
    check(`${sig} instance ${n}: process GROUP gone`, !groupAlive(i.swayPid) && !groupAlive(i.chromiumPid), "a group survived");
    check(`${sig} instance ${n}: workDir removed`, !existsSync(i.workDir), i.workDir);
    // The half that went unnoticed for hours.
    check(`${sig} instance ${n}: runtimeDir removed TOO`, !existsSync(i.runtimeDir), i.runtimeDir);
  }
  return ready;
}

async function startupPhaseCase(phase) {
  const gateDir = `/tmp/teardown-phase-${phase}-${randomUUID().slice(0, 8)}`;
  await mkdir(gateDir, { recursive: true });
  const beforeW = ids("/tmp", "computer-use-headless-");
  const beforeR = ids(process.env.XDG_RUNTIME_DIR || "/run/user/1000", "computer-use-headless-");
  const started = launchChild(HOLD_CHILD(1), { HEADLESS_TEST_PHASE_DIR: gateDir, HEADLESS_TEST_PHASE: phase });
  const phaseFile = path.join(gateDir, `PHASE-${phase}`);
  const releaseFile = path.join(gateDir, `RELEASE-${phase}`);
  let announced = false, phaseInfo = null;
  for (let i = 0; i < 120 && !announced; i++) { await sleep(25); announced = existsSync(phaseFile); }
  if (announced) { try { phaseInfo = JSON.parse(await (await import("node:fs/promises")).readFile(phaseFile, "utf8")); } catch {} }
  check(`phase ${phase}: child announced gate`, announced, `stderr=${started.errText}`);
  const exited = started.child.exitCode !== null
    ? Promise.resolve({ code: started.child.exitCode, signal: null })
    : new Promise((res) => started.child.on("exit", (code, signal) => res({ code, signal })));
  started.child.kill("SIGTERM");
  const signalFile = path.join(gateDir, "SIGNAL-RECEIVED");
  let signalReceived = false;
  for (let i = 0; i < 120 && !signalReceived; i++) { await sleep(25); signalReceived = existsSync(signalFile); }
  check(`phase ${phase}: signal receipt precedes release`, signalReceived, started.errText);
  await writeFile(releaseFile, "release");
  const ex = await exited;
  await sleep(500);
  check(`phase ${phase}: original SIGTERM preserved`, ex.signal === "SIGTERM", JSON.stringify(ex));
  if (phase.startsWith("post-")) check(`phase ${phase}: owned PID was announced`, Number.isInteger(phaseInfo?.swayPid) || Number.isInteger(phaseInfo?.chromiumPid), JSON.stringify(phaseInfo));
  for (const [label, pid] of [["sway", phaseInfo?.swayPid], ["chromium", phaseInfo?.chromiumPid]]) {
    if (Number.isInteger(pid)) {
      check(`phase ${phase}: ${label} leader and group gone`, !alive(pid) && !groupAlive(pid), JSON.stringify({ pid, phaseInfo }));
    }
  }
  const afterW = ids("/tmp", "computer-use-headless-");
  const afterR = ids(process.env.XDG_RUNTIME_DIR || "/run/user/1000", "computer-use-headless-");
  check(`phase ${phase}: its exact work/runtime dirs are gone`,
    !!phaseInfo && !existsSync(phaseInfo.workDir) && !existsSync(phaseInfo.runtimeDir), JSON.stringify(phaseInfo));
  check(`phase ${phase}: its exact instance ID remains in neither directory set`,
    !!phaseInfo?.id && !afterW.includes(phaseInfo.id) && !afterR.includes(phaseInfo.id),
    `id=${phaseInfo?.id} work=${JSON.stringify(afterW)} runtime=${JSON.stringify(afterR)}`);
  const foreignWork = afterW.filter((i) => !beforeW.includes(i) && i !== phaseInfo?.id);
  const foreignRuntime = afterR.filter((i) => !beforeR.includes(i) && i !== phaseInfo?.id);
  if (foreignWork.length || foreignRuntime.length) info(`phase ${phase}: concurrent foreign additions (not owned by this case)`, { foreignWork, foreignRuntime });
  await rm(gateDir, { recursive: true, force: true }).catch(() => {});
}

try {
  // A sentinel that must survive everything: a directory matching the harness
  // naming pattern, and a live process. If cleanup ever matched by NAME instead
  // of by owned handle, these would die — which is how someone else's instance
  // gets destroyed.
  const sentinelDir = `/tmp/computer-use-headless-SENTINEL-${randomUUID().slice(0, 8)}`;
  mkdirSync(sentinelDir, { recursive: true });
  const sentinelProc = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  info("sentinel", { dir: sentinelDir, pid: sentinelProc.pid });

  await signalCase("SIGTERM");
  await signalCase("SIGINT");

  check("the SENTINEL directory was left alone", existsSync(sentinelDir), sentinelDir);
  check("the SENTINEL process was left alone", alive(sentinelProc.pid), "sentinel died — cleanup matched too broadly");

  if (process.env.TEARDOWN_PHASE_TEST === "1") {
    for (const phase of ["runtime-mkdir", "binary-copy", "post-sway-fingerprint", "post-chromium-fingerprint"]) await startupPhaseCase(phase);
  }

  // ---------------------------------------------------------------- multi
  console.log("\n================= two instances, one process =================");
  const multi = await signalCase("SIGTERM", { count: 2 });
  check("both instances were reaped by a single signal", multi && multi.instances.length === 2, "expected 2");

  // ---------------------------------------------------------------- hooks
  console.log("\n================= cleanup hooks =================");
  const restored = `/tmp/teardown-restored-${randomUUID().slice(0, 8)}`;
  const removed = `/tmp/teardown-removed-${randomUUID().slice(0, 8)}`;
  await writeFile(restored, "ORIGINAL");            // exists before: must be restored
  await writeFile(removed, "CREATED-BY-RUN");       // absent before: must be removed
  const hookExtra = `
import { writeFile, rm } from "node:fs/promises";
await writeFile(${JSON.stringify(restored)}, "MUTATED");
registerCleanupHook(hs[0], async () => { await writeFile(${JSON.stringify(restored)}, "ORIGINAL"); });
registerCleanupHook(hs[0], async () => { await rm(${JSON.stringify(removed)}, { force: true }); });
registerCleanupHook(hs[0], async () => { throw new Error("hook that throws"); });
`;
  const hooked = await signalCase("SIGTERM", { extra: hookExtra });
  const { readFileSync } = await import("node:fs");
  check("a hook restored the file it had captured", existsSync(restored) && readFileSync(restored, "utf8") === "ORIGINAL",
    existsSync(restored) ? readFileSync(restored, "utf8") : "missing");
  check("a hook removed the file that did not exist beforehand", !existsSync(removed), removed);
  // A throwing hook is reported, never allowed to strand a compositor.
  check("a THROWING hook did not suppress process/directory cleanup",
    hooked && !alive(hooked.instances[0].swayPid) && !existsSync(hooked.instances[0].runtimeDir), "cleanup was suppressed");
  await rm(restored, { force: true }).catch(() => {});

  // ---------------------------------------------------------------- normal + double
  console.log("\n================= normal exit, double teardown, listeners =================");
  const NORMAL = `
import { spawnHeadlessInstance, teardownHeadlessInstance, installedSignalListenerCount, getTeardownStats, inspectProcessIdentity } from "./headless_instance.mjs";
const a = await spawnHeadlessInstance({ label: "normal-a" });
const during = installedSignalListenerCount();
const snapshot = { swayPid: a.swayPid, chromiumPid: a.chromiumPid, runtimeDir: a.runtimeDir, workDir: a.workDir };
const identityBeforeTeardown = { sway: inspectProcessIdentity(a, "sway"), chromium: inspectProcessIdentity(a, "chromium") };
await teardownHeadlessInstance(a);
const firstStats = getTeardownStats();
// Calling teardown twice, and concurrently, must be harmless — every caller
// awaits the same work rather than starting a second one.
await Promise.all([teardownHeadlessInstance(a), teardownHeadlessInstance(a)]);
const b = await spawnHeadlessInstance({ label: "normal-b" });
const afterSecondSpawn = installedSignalListenerCount();
await teardownHeadlessInstance(b);
console.log("READY " + JSON.stringify({ snapshot, identityBeforeTeardown, during, firstStats, afterSecondSpawn, afterAll: installedSignalListenerCount() }));
process.exit(0);
`;
  const nf = childFile(NORMAL);
  const nres = await new Promise((res) => {
    const c = spawn("node", [nf], { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "pipe"] });
    let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d));
    c.on("exit", (code) => { const m = o.match(/READY (\{.*\})/); res({ code, stderr: e, data: m ? JSON.parse(m[1]) : null }); });
  });
  info("normal-path result", nres);
  check("normal teardown still exits 0", nres.code === 0, `code=${nres.code}; stderr=${nres.stderr}`);
  check("normal teardown removed the compositor and BOTH dirs",
    nres.data && !alive(nres.data.snapshot.swayPid) && !existsSync(nres.data.snapshot.runtimeDir) && !existsSync(nres.data.snapshot.workDir),
    JSON.stringify(nres.data?.snapshot));
  check("double + concurrent teardown is harmless (child exited cleanly)", nres.code === 0, `code=${nres.code}`);
  // Listeners are installed once, not per instance, and come OFF once nothing
  // is owned — importing this module must not permanently change the process's
  // signal behaviour.
  check("exactly one listener per signal while instances are owned", nres.data?.during === 2, `got ${nres.data?.during}`);
  check("a SECOND spawn does not accumulate listeners", nres.data?.afterSecondSpawn === 2, `got ${nres.data?.afterSecondSpawn}`);
  check("listeners are removed once nothing is owned", nres.data?.afterAll === 0, `got ${nres.data?.afterAll}`);
  check("first teardown attempts each owned group exactly once",
    nres.data?.firstStats?.groups?.chromium === 1 && nres.data?.firstStats?.groups?.sway === 1,
    JSON.stringify(nres.data?.firstStats));

  // ------------------------------------------------- completed double teardown
  // A COMPLETED teardown must do NOTHING on a second call. Proven by counting
  // teardown operations, not by the absence of an exception: the previous version rebuilt
  // its work from an unregistered handle and re-signalled the old pids, which
  // after PID REUSE kills a stranger. "It did not throw" would have passed.
  const COUNTED = `
import { spawnHeadlessInstance, teardownHeadlessInstance, resetTeardownStats, getTeardownStats } from "./headless_instance.mjs";
const h = await spawnHeadlessInstance({ label: "double" });
const snap = { swayPid: h.swayPid, chromiumPid: h.chromiumPid, runtimeDir: h.runtimeDir, workDir: h.workDir };
await teardownHeadlessInstance(h);            // the real one
// Instrument AFTER the first teardown: everything counted here is work the
// SECOND call attempted, and it must be zero. These are teardown-operation
// counters, not intercepted kernel syscalls.
resetTeardownStats();
await teardownHeadlessInstance(h);
await Promise.all([teardownHeadlessInstance(h), teardownHeadlessInstance(h)]);
console.log("READY " + JSON.stringify({ snap, stats: getTeardownStats() }));
process.exit(0);
`;
  const df = childFile(COUNTED);
  const dres = await new Promise((res) => {
    const c = spawn("node", [df], { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "pipe"] });
    let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d));
    c.on("exit", (code) => { const m = o.match(/READY (\{.*\})/); res({ code, stderr: e, data: m ? JSON.parse(m[1]) : null }); });
  });
  info("double-teardown instrumentation", { ...dres.data, stderr: dres.stderr });
  check("a completed teardown issues ZERO further kill/rm/hook operations",
    dres.data?.stats?.kills === 0 && dres.data?.stats?.rms === 0 && dres.data?.stats?.hooks === 0 &&
      dres.data?.stats?.groups?.chromium === 0 && dres.data?.stats?.groups?.sway === 0, JSON.stringify(dres.data?.stats));
  check("...and the first teardown really did remove everything",
    dres.data && !alive(dres.data.snap.swayPid) && !existsSync(dres.data.snap.runtimeDir) && !existsSync(dres.data.snap.workDir),
    JSON.stringify(dres.data?.snap));

  // ------------------------------------------------- second signal mid-cleanup
  // The race the implementation claims to handle. A deliberately SLOW hook holds
  // cleanup open; a second signal arrives while it is demonstrably still running
  // and must neither re-raise early nor start a second cleanup. The child must
  // ultimately report the ORIGINAL first signal.
  console.log("\n================= second signal during cleanup =================");
  const slowMark = `/tmp/teardown-slow-${randomUUID().slice(0, 8)}`;
  const SLOW = `
import { spawnHeadlessInstance, registerCleanupHook } from "./headless_instance.mjs";
import { writeFile } from "node:fs/promises";
const h = await spawnHeadlessInstance({ label: "slow" });
registerCleanupHook(h, async () => {
  await writeFile(${JSON.stringify(slowMark)}, "STARTED");
  await new Promise((r) => setTimeout(r, 4000));      // cleanup is demonstrably in progress
  await writeFile(${JSON.stringify(slowMark)}, "FINISHED");
});
console.log("READY " + JSON.stringify({ swayPid: h.swayPid, chromiumPid: h.chromiumPid, runtimeDir: h.runtimeDir, workDir: h.workDir }));
setInterval(() => {}, 1000);
`;
  const { child: slowChild, ready: slowReady } = await startChild(SLOW);
  check("slow-hook child reached READY", !!slowReady, "never ready");
  if (slowReady) {
    const slowExit = new Promise((res) => slowChild.on("exit", (code, signal) => res({ code, signal })));
    slowChild.kill("SIGTERM");
    // Wait until the hook has demonstrably STARTED, so the second signal really
    // does land mid-cleanup rather than before it.
    let started = false;
    for (let i = 0; i < 40 && !started; i++) { await sleep(100); started = existsSync(slowMark); }
    check("the first signal began cleanup (hook started)", started, "hook never started");
    slowChild.kill("SIGINT");                       // the duplicate, mid-flight
    const sx = await slowExit;
    await sleep(500);
    const { readFileSync: rfs } = await import("node:fs");
    check("the second signal did NOT cut cleanup short — the slow hook ran to completion",
      existsSync(slowMark) && rfs(slowMark, "utf8") === "FINISHED",
      existsSync(slowMark) ? rfs(slowMark, "utf8") : "hook file missing");
    check("the child reports the ORIGINAL first signal (SIGTERM), not the duplicate",
      sx.signal === "SIGTERM", JSON.stringify(sx));
    check("and everything was still reaped despite the duplicate signal",
      !alive(slowReady.swayPid) && !existsSync(slowReady.runtimeDir) && !existsSync(slowReady.workDir),
      JSON.stringify(slowReady));
    await rm(slowMark, { force: true }).catch(() => {});
  }

  // ---------------------------------------------------------------- 1:1 audit
  console.log("\n================= work/runtime dir correspondence =================");
  const { readdirSync } = await import("node:fs");
  const work = ids("/tmp", "computer-use-headless-").filter((i) => !i.startsWith("SENTINEL"));
  const runtime = ids(process.env.XDG_RUNTIME_DIR || "/run/user/1000", "computer-use-headless-");
  // BOTH directions: a work-only half is exactly as much of a leak as a
  // runtime-only half, and checking one way would hide the other.
  const orphanRuntime = runtime.filter((i) => !work.includes(i));
  const orphanWork = work.filter((i) => !runtime.includes(i));
  info("work dirs", work.length); info("runtime dirs", runtime.length);
  info("runtime-only halves", orphanRuntime); info("work-only halves", orphanWork);
  const ambient = {
    orphanRuntime, orphanWork,
    newWork: work.filter((i) => !beforeWork.includes(i)),
    newRuntime: runtime.filter((i) => !beforeRuntime.includes(i)),
  };
  // Exact resources announced by every child above are asserted gone. The
  // machine-wide set is diagnostic by default because another isolated test
  // process may legitimately create a paired instance while this suite runs.
  // A quiescent maintenance run can opt into the stronger ambient assertion.
  if (process.env.TEARDOWN_REQUIRE_QUIESCENT === "1") {
    check("quiescent audit: no runtime-only half", orphanRuntime.length === 0, JSON.stringify(ambient));
    check("quiescent audit: no work-only half", orphanWork.length === 0, JSON.stringify(ambient));
    check("quiescent audit: no new ambient IDs",
      ambient.newWork.length === 0 && ambient.newRuntime.length === 0, JSON.stringify(ambient));
  } else {
    info("ambient correspondence (diagnostic; foreign concurrent instances allowed)", ambient);
  }

  sentinelProc.kill("SIGKILL");
  await rm(sentinelDir, { recursive: true, force: true }).catch(() => {});
} catch (e) {
  console.error("FAILED:", e.stack || e.message); fail++;
} finally {
  for (const f of tmp) await rm(f, { force: true }).catch(() => {});
}
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
