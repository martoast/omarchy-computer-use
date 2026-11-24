#!/usr/bin/env node
// rev 16b — headless trees run at lower CPU priority (pure: no Chromium, no sway).
// A detached `sh` tree stands in for sway+Chromium: it is its own session (so its
// own autogroup) and its own process group, exactly like the real spawns.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { lowerTreePriority, headlessNiceLevel, HEADLESS_NICE_ENV, DEFAULT_HEADLESS_NICE } from "./headless_instance.mjs";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  <<< " + String(detail).slice(0, 300)}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const autogroupOf = (pid) => { try { return readFileSync(`/proc/${pid}/autogroup`, "utf8").trim(); } catch { return null; } };
const groupMembers = (pgrp) => { try { return execFileSync("pgrep", ["-g", String(pgrp)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); } catch { return []; } };
const niceOf = (pid) => { try { return Number(execFileSync("ps", ["-o", "ni=", "-p", String(pid)], { encoding: "utf8" }).trim()); } catch { return null; } };
const autogroupEnabled = (() => { try { return readFileSync("/proc/sys/kernel/sched_autogroup_enabled", "utf8").trim() === "1"; } catch { return false; } })();

async function spawnTree() {
  const leader = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], { detached: true, stdio: "ignore" });
  leader.unref();
  for (let i = 0; i < 40 && groupMembers(leader.pid).length < 3; i++) await sleep(25);
  return leader;
}
function killTree(pid) {
  try { process.kill(-pid, "SIGTERM"); } catch {}
  return new Promise((r) => setTimeout(async () => { try { process.kill(-pid, "SIGKILL"); } catch {} r(); }, 150));
}

// --- env parsing ---------------------------------------------------------------------------
check("default level is 10", headlessNiceLevel({}) === DEFAULT_HEADLESS_NICE && DEFAULT_HEADLESS_NICE === 10, "");
check("env 0 disables, env 19 is the maximum", headlessNiceLevel({ [HEADLESS_NICE_ENV]: "0" }) === 0 && headlessNiceLevel({ [HEADLESS_NICE_ENV]: "19" }) === 19, "");
for (const bad of ["-1", "20", "1.5", "x"]) { let threw = false; try { headlessNiceLevel({ [HEADLESS_NICE_ENV]: bad }); } catch (e) { threw = e instanceof RangeError; } check(`env ${JSON.stringify(bad)} is refused (RangeError)`, threw, ""); }
for (const bad of [-1, 20, 1.5, "10"]) { let threw = false; try { await lowerTreePriority(process.pid, bad); } catch (e) { threw = e instanceof RangeError; } check(`level ${JSON.stringify(bad)} is refused by the helper`, threw, ""); }
{ let threw = false; try { await lowerTreePriority(0, 10); } catch (e) { threw = e instanceof TypeError; } check("pid 0/1 is refused", threw, ""); }

// --- level 10 applies to the whole tree ------------------------------------------------------
{
  const leader = await spawnTree();
  const members = groupMembers(leader.pid);
  check("fixture tree: leader + two children in one process group", members.length >= 3 && members.includes(leader.pid), JSON.stringify(members));
  const before = autogroupOf(leader.pid);
  const result = await lowerTreePriority(leader.pid, 10);
  check("helper reports applied (autogroup and/or renice)", result.applied === true && result.level === 10, JSON.stringify(result));
  const after = groupMembers(leader.pid);
  const ag = after.map((pid) => autogroupOf(pid));
  if (autogroupEnabled) {
    check("every member shares the leader's autogroup at nice 10", ag.every((g) => g && g === ag[0] && / nice 10$/.test(g)), JSON.stringify({ before, ag }));
    check("the autogroup differs from this test process's own", ag[0] !== autogroupOf(process.pid), `${ag[0]} vs ${autogroupOf(process.pid)}`);
  } else {
    console.log("skip autogroup assertions (sched_autogroup_enabled is 0 here); renice path covers it");
  }
  const nices = after.map((pid) => niceOf(pid));
  check("renice -g set every member's nice to 10", nices.every((n) => n === 10), JSON.stringify(nices));
  await killTree(leader.pid);
  await sleep(200);
  check("the process-group teardown (SIGTERM then SIGKILL on -pgrp) leaves no survivor", groupMembers(leader.pid).length === 0, JSON.stringify(groupMembers(leader.pid)));
}

// --- level 0 leaves everything untouched -----------------------------------------------------
{
  const leader = await spawnTree();
  const result = await lowerTreePriority(leader.pid, 0);
  const members = groupMembers(leader.pid);
  check("level 0: helper does nothing and says so", result.applied === false && result.autogroup === false && result.renice === false, JSON.stringify(result));
  check("level 0: every member stays at nice 0", members.every((pid) => niceOf(pid) === 0), JSON.stringify(members.map(niceOf)));
  if (autogroupEnabled) check("level 0: autogroup nice stays 0", members.every((pid) => / nice 0$/.test(autogroupOf(pid) || "")), JSON.stringify(members.map(autogroupOf)));
  await killTree(leader.pid);
  await sleep(200);
  check("level 0 tree torn down", groupMembers(leader.pid).length === 0, "");
}

// --- a dead pid never throws (never fatal at spawn) --------------------------------------------
{
  const leader = await spawnTree();
  await killTree(leader.pid);
  await sleep(200);
  const result = await lowerTreePriority(leader.pid, 10);
  check("a vanished tree yields applied:false with recorded errors, no throw", result.applied === false && result.errors.length >= 1, JSON.stringify(result));
}

console.log(fail ? `FAIL — ${pass} passed, ${fail} failed` : `PASS — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
