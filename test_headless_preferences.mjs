import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedChromiumPreferences } from "./headless_instance.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "computer-use-prefs-"));
try {
  const defaults = path.join(root, "Default");
  await mkdir(defaults);
  await writeFile(path.join(defaults, "Preferences"), JSON.stringify({ unrelated: { keep: true }, profile: { name: "fixture" }, autofill: { custom: 1 } }));
  const result = await seedChromiumPreferences(root);
  assert.deepEqual(result.unrelated, { keep: true });
  assert.equal(result.profile.name, "fixture");
  assert.equal(result.profile.password_manager_enabled, false);
  assert.equal(result.credentials_enable_service, false);
  assert.equal(result.autofill.custom, 1);
  assert.equal(result.autofill.enabled, false);
  assert.equal(result.autofill.profile_enabled, false);
  assert.equal(result.autofill.credit_card_enabled, false);
  const reread = JSON.parse(await readFile(path.join(defaults, "Preferences"), "utf8"));
  assert.deepEqual(reread, result);
  console.log("headless Chromium preference seeding: PASS");
} finally { await rm(root, { recursive: true, force: true }); }

// A profile the previous run left as "Crashed" (teardown ends Chromium by signal) is marked clean before launch,
// so the next launch never opens with "Restore pages?" over the store.
{
  const { seedChromiumPreferences } = await import("./headless_instance.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const os = await import("node:os"), path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "prefs-"));
  mkdirSync(path.join(dir, "Default"));
  writeFileSync(path.join(dir, "Default", "Preferences"), JSON.stringify({ profile: { exit_type: "Crashed", name: "keep" } }));
  await seedChromiumPreferences(dir);
  const p = JSON.parse(readFileSync(path.join(dir, "Default", "Preferences"), "utf8")).profile;
  if (p.exit_type !== "Normal" || p.exited_cleanly !== true || p.name !== "keep") throw new Error(`crash state not cleared: ${JSON.stringify(p)}`);
  console.log("crash-restore state cleared before launch: PASS");
}
