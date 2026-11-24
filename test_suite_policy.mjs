#!/usr/bin/env node
// rev 24b — the suite runner honours the ONE-instance rule (pure, milliseconds,
// spawns no browser). run_suites.mjs executes on import, so it is pinned by a
// source scan plus black-box invocations whose refusal must fire before ANY
// child process — including the pure stage — is spawned.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  <<< " + String(detail).slice(0, 300)}`); cond ? pass++ : fail++; };
const root = import.meta.dirname;
const src = readFileSync(path.join(root, "run_suites.mjs"), "utf8");
const headlessDirs = () => readdirSync("/tmp").filter((d) => d.startsWith("computer-use-headless-")).length;
const ENV = "COMPUTER_USE_ALLOW_PARALLEL_INSTANCES";

// (a) the default is ONE live job.
check("(a) --jobs defaults to 1 (source pin)", /const JOBS = jobsText === null \? 1 : Number\(jobsText\);/.test(src), "");
check("(a) the old default of 4 is gone", !/: 4;\s*$/m.test(src.split("\n").find((l) => l.includes("const JOBS")) || ""), "");
// (b) the refusal branch exists and names the env var.
check("(b) --jobs>1 is refused unless the opt-in env is exactly \"1\"", new RegExp(`if \\(JOBS > 1 && process\\.env\\[PARALLEL_INSTANCES_ENV\\] !== "1"\\)`).test(src) && src.includes(`PARALLEL_INSTANCES_ENV = "${ENV}"`), "");
check("(b) the refusal exits 2 before the pure stage", src.indexOf("process.exit(2)") < src.indexOf("--- pure suites"), "");
// (e) every suite is spawned with stdin ignored (EOF), so a suite that imports
// index.js — whose stdio MCP server holds stdin — exits when it is done.
check("(e) suites are spawned with stdin \"ignore\"", /spawn\(cmd, args, \{ stdio: \["ignore", "pipe", "pipe"\] \}\)/.test(src), "");

// (c)/(d) black-box: the refusal fires before ANY child process. An `only`
// argument naming a non-existent suite guarantees nothing real would run even
// if the refusal failed to fire; the absence of any pure-suite line proves the
// pure stage never started, and the instance count proves no browser did.
const env = { ...process.env }; delete env[ENV];
const invoke = (jobs, extraEnv = {}) => spawnSync("node", ["run_suites.mjs", `--jobs=${jobs}`, "nonexistent_suite_for_policy_test.mjs"], { cwd: root, encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 20000 });
const before = headlessDirs();
for (const jobs of ["4", "2"]) {
  const r = invoke(jobs);
  check(`(c) --jobs=${jobs} without the opt-in exits 2 with the refusal`, r.status === 2 && r.stderr.includes(`refusing --jobs=${jobs}: one headless instance at a time (set ${ENV}=1`), JSON.stringify({ status: r.status, stderr: r.stderr.slice(0, 200) }));
  check(`(c) --jobs=${jobs}: no pure-suite line and no stage banner appeared (no child process before the refusal)`, !/--- pure suites|^ok  |^FAIL|PASS|engine_service\/test/m.test(r.stdout) && r.stdout.trim() === "", JSON.stringify(r.stdout.slice(0, 200)));
}
for (const bad of ["abc", "0", "-1", "1.5", ""]) {
  const r = invoke(bad);
  check(`(d) --jobs=${JSON.stringify(bad)} is refused as not an integer >= 1`, r.status === 2 && r.stderr.includes(`refusing --jobs=${bad}: it must be an integer >= 1`) && r.stdout.trim() === "", JSON.stringify({ status: r.status, stderr: r.stderr.slice(0, 160) }));
}
check("(c) no headless instance directory was created by any refused invocation", headlessDirs() === before, `${before} → ${headlessDirs()}`);
// The opt-in path is pinned by source only: running it would start the real
// pure stage (which includes this very suite) — never spawned from here.
check("(b) the opt-in path is the only way past the refusal (source pin)", src.includes(`process.env[PARALLEL_INSTANCES_ENV] !== "1"`) && !src.includes("--force"), "");
check("(a) this suite is registered in the pure stage", /"test_suite_policy\.mjs"/.test(src.match(/const PURE_JS = \[[\s\S]*?\];/)[0]), "");

console.log(fail ? `FAIL — ${pass} passed, ${fail} failed` : `PASS — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
