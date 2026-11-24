#!/usr/bin/env node
// Run the test suites with bounded concurrency, and report per-suite timings.
//
// Every live suite spawns its OWN isolated compositor+browser, so they do not
// share state and can run at the same time. Running them one after another was
// costing most of the wall clock for no isolation benefit.
//
// Concurrency is BOUNDED rather than unlimited: spawning a nested compositor is
// the one operation this harness has measured as flaky under sustained load —
// headless_instance already retries a sway spawn for exactly that reason — so
// piling on every suite at once would trade wall clock for spurious failures.
import { spawn } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--jobs="));
// ONE headless instance at a time (rev 24b). The live stage used to default to
// four concurrent trees, which is four Chromium instances beside whatever the
// engine or a colleague is running — measured 2026-09-03: 8/91 suites failed
// under --jobs=4 and passed serially. Concurrency is opt-in twice over: an
// explicit --jobs=N AND COMPUTER_USE_ALLOW_PARALLEL_INSTANCES=1. The refusal
// runs HERE, before any child process (the pure stage included) is spawned.
export const PARALLEL_INSTANCES_ENV = "COMPUTER_USE_ALLOW_PARALLEL_INSTANCES";
const jobsText = limitArg ? limitArg.slice(7) : null;
const JOBS = jobsText === null ? 1 : Number(jobsText);
if (jobsText !== null && (!/^\d+$/.test(jobsText) || JOBS < 1)) {
  console.error(`refusing --jobs=${jobsText}: it must be an integer >= 1 (default 1: one headless instance at a time)`);
  process.exit(2);
}
if (JOBS > 1 && process.env[PARALLEL_INSTANCES_ENV] !== "1") {
  console.error(`refusing --jobs=${JOBS}: one headless instance at a time (set ${PARALLEL_INSTANCES_ENV}=1 to run ${JOBS} trees concurrently on purpose)`);
  process.exit(2);
}
const only = args.filter((a) => !a.startsWith("--"));

// Pure suites: no browser, milliseconds each. Run them FIRST and serially —
// they are the cheapest way to fail fast before paying for any instance.
const PURE_JS = ["test_dialog_dismissal.mjs", "test_action_routing.mjs", "test_transition_signals.mjs",
                 "test_navigation_recovery.mjs", "test_input_safety.mjs", "test_tree_priority.mjs",
                 "test_suite_policy.mjs", "test_clean_href.mjs"];
// Every Python test here is a pure accessibility-bridge test.
const PURE_PY = readdirSync(".").filter((f) => /^test_.*\.py$/.test(f)).sort();
const LIVE = only.length ? only : readdirSync(".")
  .filter((f) => /^test_.*\.mjs$/.test(f))
  .filter((f) => !PURE_JS.includes(f))
  .filter((f) => !["test_mcp_helpers.mjs", "test_headless_concurrent.mjs",
                   "test_vs_search_recovery.mjs"].includes(f));

// The engine's node:test suites run as ONE serial job in the pure stage (rev
// 17.1): they sat red unnoticed from 19bec8d until rev 17 because nothing ran
// them here.
// a project built on this core may keep node:test suites in engine_service/test; the core itself has none
const ENGINE_TESTS = existsSync("engine_service/test") ? readdirSync("engine_service/test").filter((f) => f.endsWith(".test.mjs")).sort().map((f) => `engine_service/test/${f}`) : [];
const run = (cmd, file, args = [file]) => new Promise((res) => {
  const t0 = Date.now();
  const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (out += d));
  c.on("exit", (code) => {
    const last = out.trim().split("\n").filter((l) => /PASS|FAIL|^ℹ (?:pass|fail) /.test(l)).pop() || "(no summary)";
    res({ file, code, ms: Date.now() - t0, last, out });
  });
});

const results = [];
const report = (r) => {
  const s = (r.ms / 1000).toFixed(1).padStart(6);
  console.log(`${r.code === 0 ? "ok  " : "FAIL"} ${s}s  ${r.file.padEnd(34)} ${r.last}`);
  results.push(r);
};

const t0 = Date.now();
console.log(`--- pure suites (serial, fail fast) ---`);
for (const f of [...PURE_PY, ...PURE_JS]) report(await run(f.endsWith(".py") ? "python3" : "node", f));
if (!only.length && ENGINE_TESTS.length) report(await run("node", `engine_service/test/*.test.mjs (${ENGINE_TESTS.length} files)`, ["--test", ...ENGINE_TESTS]));
if (results.some((r) => r.code !== 0)) {
  console.log("\nPure suites failed — stopping before spawning any browser.");
  for (const r of results.filter((x) => x.code !== 0)) console.log(r.out.slice(-1500));
  process.exit(1);
}

console.log(`\n--- live suites (${JOBS} at a time) ---`);
const queue = [...LIVE];
const workers = Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
  while (queue.length) report(await run("node", queue.shift()));
});
await Promise.all(workers);

const failed = results.filter((r) => r.code !== 0);
const wall = ((Date.now() - t0) / 1000).toFixed(1);
const cpu = (results.reduce((n, r) => n + r.ms, 0) / 1000).toFixed(1);
console.log(`\nwall ${wall}s · summed suite time ${cpu}s · speedup ${(cpu / wall).toFixed(1)}x`);
console.log(`${failed.length ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length} suites`);
for (const r of failed) { console.log(`\n===== ${r.file} =====`); console.log(r.out.slice(-2500)); }
process.exit(failed.length ? 1 : 0);
