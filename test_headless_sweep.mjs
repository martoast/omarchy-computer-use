#!/usr/bin/env node
// Headless safety net — the sweep's decision and its directory walk (pure: no Chromium, no sway, no real kill).
// The owner's liveness is injected (startTimeOf), and the walk runs over a private temp dir with an injected teardown.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepDecision, sweepHeadlessInstances, OWNER_RECORD_FILE, MAX_LIFETIME_MS } from "./headless_instance.mjs";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  <<< " + String(detail).slice(0, 300)}`); cond ? pass++ : fail++; };

const NOW = 1_000_000_000;
const SELF = 4242, SELF_START = "777", OTHER = 5151, OTHER_START = "888";
const alive = { [SELF]: SELF_START, [OTHER]: OTHER_START };
const ctx = (extra = {}) => ({ now: NOW, selfPid: SELF, selfStart: SELF_START, registeredIds: new Set(["aaaaaaaa"]), startTimeOf: (pid) => alive[pid] ?? null, ...extra });
const rec = (over = {}) => ({ id: "aaaaaaaa", ownerPid: SELF, ownerStart: SELF_START, label: "Gallery-owala", startedAt: NOW - 60_000, maxLifetimeMs: MAX_LIFETIME_MS.read, ...over });
const decide = (r, extra) => sweepDecision(r, ctx(extra));

// --- the decision ---------------------------------------------------------------------------------
check("dead owner → kill", decide(rec({ ownerPid: 9999, ownerStart: "1" })).action === "kill" && decide(rec({ ownerPid: 9999 })).reason === "owner-dead");
check("recycled owner pid (starttime differs) → kill", decide(rec({ ownerPid: OTHER, ownerStart: "123" })).action === "kill");
check("alive owner (this process), within lifetime → keep", decide(rec()).action === "keep", JSON.stringify(decide(rec())));
{ const d = decide(rec({ startedAt: NOW - MAX_LIFETIME_MS.read - 1 })); check("alive owner (this process), past lifetime → kill", d.action === "kill" && d.reason === "max-lifetime", JSON.stringify(d)); }
{ const d = decide(rec({ ownerPid: OTHER, ownerStart: OTHER_START, startedAt: NOW - 10 * MAX_LIFETIME_MS.default })); check("another live owner's instance, even far past lifetime → keep", d.action === "keep" && d.reason === "other-owner", JSON.stringify(d)); }
check("this process's record no longer registered → kill (orphaned)", decide(rec({ id: "bbbbbbbb" })).reason === "orphaned");
for (const [name, bad] of [["null", null], ["string", "x"], ["no id", rec({ id: undefined })], ["bad id", rec({ id: "../etc" })], ["pid 1", rec({ ownerPid: 1 })], ["no start", rec({ startedAt: "yesterday" })], ["no lifetime", rec({ maxLifetimeMs: 0 })]]) {
  let d; try { d = decide(bad); } catch (e) { d = { action: "threw", reason: e.message }; }
  check(`invalid record (${name}) → skip, never throws`, d.action === "skip", JSON.stringify(d));
}

// --- the directory walk ---------------------------------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), "headless-sweep-test-"));
try {
  const dir = (id, content) => { const d = path.join(tmp, `computer-use-headless-${id}`); mkdirSync(d); if (content !== undefined) writeFileSync(path.join(d, OWNER_RECORD_FILE), content); return d; };
  dir("11111111", JSON.stringify(rec({ id: "11111111", ownerPid: 2 ** 22 + 7 })));          // dead owner
  dir("22222222", JSON.stringify(rec({ id: "22222222", ownerPid: process.ppid, ownerStart: null }))); // another live owner
  dir("33333333");                                                                         // no record (older code, the variant bench)
  dir("44444444", "{not json");                                                            // corrupt
  dir("55555555", JSON.stringify(rec({ id: "66666666", ownerPid: 2 ** 22 + 7 })));          // record of another dir
  mkdirSync(path.join(tmp, "unrelated-dir"));
  const torn = [], lines = [];
  const result = await sweepHeadlessInstances({ tmpDir: tmp, now: NOW, log: (l) => lines.push(l), tearDown: async (r, workDir) => { torn.push([r.id, workDir]); } });
  check("walk checks only computer-use-headless-* dirs", result.checked === 5, JSON.stringify(result));
  check("walk tears down only the dead owner's instance", torn.length === 1 && torn[0][0] === "11111111" && torn[0][1].endsWith("computer-use-headless-11111111"), JSON.stringify(torn));
  check("missing / corrupt / mismatched records are left alone", result.killed.map((k) => k.id).join() === "11111111", JSON.stringify(result.killed));
  check("one log line, only because it killed something", lines.length === 1 && /tore down 1 instance/.test(lines[0]) && /owner-dead/.test(lines[0]), JSON.stringify(lines));
  const quiet = [];
  await sweepHeadlessInstances({ tmpDir: tmp, now: NOW, log: (l) => quiet.push(l), tearDown: async () => { throw new Error("boom"); } });
  check("a failing teardown is logged, never thrown", quiet.some((l) => /boom/.test(l)), JSON.stringify(quiet));
  const none = [];
  await sweepHeadlessInstances({ tmpDir: path.join(tmp, "missing"), log: (l) => none.push(l) });
  check("missing tmp dir → nothing, no log", none.length === 0);
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
