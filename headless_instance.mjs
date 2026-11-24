// Lifecycle manager for isolated, off-screen browser automation instances.
//
// Each instance is: a headless sway compositor (WLR_BACKENDS=headless, true
// wlroots — unlike Hyprland's Aquamarine backend, this boots cleanly on a
// single-GPU machine without fighting the real session for DRM master,
// verified live) + one Chromium window, each in its own isolated
// XDG_RUNTIME_DIR so multiple instances can spawn truly concurrently with
// zero socket-naming collisions (verified live — sway ignores a pre-set
// WAYLAND_DISPLAY name and always auto-picks within whatever runtime dir
// it's given, so giving each instance its own dir makes every instance
// independently pick "wayland-1" with no coordination needed). Input uses
// wlrctl (Wayland-protocol virtual keyboard/pointer, scoped to
// $WAYLAND_DISPLAY) instead of ydotool (kernel uinput, one real device
// shared by the whole machine) — that's what makes N of these safe to run
// alongside each other and alongside the real interactive desktop.
//
// Each instance gets its own Chromium profile. By default it is disposable.
// Callers may explicitly name a persistent profile (normally one per site)
// so cookie-backed delivery preferences survive process teardown without ever
// sharing the real browser's profile or another store's cookies.

import { blockingProxy } from "./tracker_block_proxy.mjs";
import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { mkdir, rm, rename, writeFile, readFile, readdir, copyFile, chmod } from "node:fs/promises";
import { readFileSync, readlinkSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { BoundedStderr, runningRecord, applyExitEvent, EXIT_LOG_BASENAME } from "./chromium_exit.js";
import { defaultHelperBinary } from "./headless_keyboard_client.mjs";
import { existsSync } from "node:fs";

const swayConfig = (width, height) => `output HEADLESS-1 resolution ${width}x${height}\nseat seat0 xcursor_theme none\n`;
// COMPUTER_USE_VISIBLE_INSTANCES=1 (demos: "show me the real browsers"): the instance's compositor runs as a WINDOW
// on the desktop (wlroots' wayland backend) instead of headless. Everything else is unchanged — its own runtime dir,
// its own virtual pointer/keyboard, so several agents still work in parallel without touching the desktop's input.
// The browser then lays out at the window's size. Never set by the engine.
const visibleInstances = () => process.env.COMPUTER_USE_VISIBLE_INSTANCES === "1";
// COMPUTER_USE_VISIBLE_SCALE (demos): draw the browser at this output scale, e.g. 0.5 — a 632x518 demo tile then
// gives the page a 1264x1036 screen (the store's DESKTOP layout, drawn at half size) instead of its phone layout.
const visibleSwayConfig = () => `seat seat0 xcursor_theme none\n${Number(process.env.COMPUTER_USE_VISIBLE_SCALE) > 0 ? `output * scale ${Number(process.env.COMPUTER_USE_VISIBLE_SCALE)}\n` : ""}`;
const CHROMIUM_CANONICAL_EXE = "/usr/lib/chromium/chromium";
const activePersistentProfiles = new Set();

// How long teardown waits for a SIGKILL to actually take effect before declaring a process group WEDGED. SIGKILL
// is uncatchable, but a target in UNINTERRUPTIBLE SLEEP (D state) — blocked inside a device ioctl, e.g. a GPU/DRM
// call — is reaped only when that syscall returns, normally within a few seconds. So we poll /proc up to this
// bound rather than declaring a wedge after a fixed instant; env-tunable, never unbounded.
const WEDGE_TIMEOUT_MS = Number(process.env.HEADLESS_WEDGE_TIMEOUT_MS || 20000);

/** Poll `isGone()` until it returns truthy or the timeout elapses; resolves true if it went gone in time, false
 * if the deadline passed first. `isGone` is injected so the wedge path is unit-testable without real processes. */
export async function pollUntilGone(isGone, { timeoutMs = WEDGE_TIMEOUT_MS, intervalMs = 250 } = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  if (await isGone()) return true;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (await isGone()) return true;
  }
  return false;
}

// NO DEVTOOLS, EVER: this harness drives the browser only through the
// accessibility tree and virtual input, like a person with a screen reader. A
// browser launched with a DevTools port also behaves differently on some sites
// (requests reset with ERR_HTTP2_PROTOCOL_ERROR). There is no option for it,
// chromiumArgv has no such parameter, and spawnHeadlessInstance rejects an
// unknown option key (pinned by test_devtools_guard.mjs; AGENTS.md rule 7).
// DESKTOP RESPONSIVENESS (rev 16b): every headless tree (a nested sway plus a
// Chromium that renders on the CPU) runs inside the user's own session, so it
// competes with his desktop at equal weight. With kernel autogroup scheduling
// (sched_autogroup_enabled = 1 here) a detached child is its own session and
// therefore its own autogroup, and per-process nice is invisible ACROSS
// autogroups — the cross-session lever is the autogroup's own nice level,
// written to /proc/<pid>/autogroup (accepted unprivileged for 0..19). The
// process-group renice is the fallback when autogroup scheduling is off. No
// effect on an idle machine (CFS weights only matter under contention); under
// contention the run yields to the foreground by design. Level from
// COMPUTER_USE_HEADLESS_NICE (0..19, default 10, 0 disables); never fatal.
export const HEADLESS_NICE_ENV = "COMPUTER_USE_HEADLESS_NICE";
export const DEFAULT_HEADLESS_NICE = 10;
export function headlessNiceLevel(env = process.env) {
  const raw = env?.[HEADLESS_NICE_ENV];
  if (raw === undefined || raw === "") return DEFAULT_HEADLESS_NICE;
  const level = Number(raw);
  if (!Number.isInteger(level) || level < 0 || level > 19) throw new RangeError(`${HEADLESS_NICE_ENV} must be an integer 0..19`);
  return level;
}
/**
 * Lower the CPU priority of a detached process tree led by `pid` (its own
 * session/process group). Returns { applied, autogroup, renice, level, errors };
 * a bad level throws, a failed write never does.
 */
export async function lowerTreePriority(pid, level = DEFAULT_HEADLESS_NICE) {
  if (!Number.isInteger(pid) || pid <= 1) throw new TypeError("pid must be a positive process id");
  if (!Number.isInteger(level) || level < 0 || level > 19) throw new RangeError("nice level must be an integer 0..19");
  const result = { applied: false, autogroup: false, renice: false, level, errors: [] };
  if (level === 0) return result;
  try { await writeFile(`/proc/${pid}/autogroup`, String(level)); result.autogroup = true; }
  catch (e) { result.errors.push(`autogroup: ${e?.code || e?.message || e}`); }
  try { await run("renice", ["-n", String(level), "-g", String(pid)]); result.renice = true; }
  catch (e) { result.errors.push(`renice: ${String(e?.message || e).slice(0, 120)}`); }
  result.applied = result.autogroup || result.renice;
  return result;
}

/**
 * The Chromium argv, byte for byte what spawnHeadlessInstance launches (pure,
 * so a fixture can pin it). It has no DevTools parameter and never emits a
 * --remote-* flag.
 */
const PROXY_ENV_KEYS = ["http_proxy", "https_proxy", "all_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];

/**
 * The browser's environment. A proxy is opt-in PER SITE (some sites refuse
 * proxy traffic, others show a different country's site without one). It is applied through
 * Chromium's own proxy environment, so the argv stays byte-identical and
 * denylist-clean, and only to this one browser process: the desktop, the
 * engine and the tunnel never see it. Any proxy inherited from the caller is
 * stripped, so no site gets one by accident.
 */
/**
 * THE INSTANCE'S KEYBOARD HOLDER (root cause of the Chromium SIGSEGV in xkb_state_update_mask, 2026-10-04): a zwp virtual keyboard
 * joins the seat BEFORE its keymap upload, so whenever the seat goes from no keyboard to one, a client that asks for its wl_keyboard
 * in that window gets NO_KEYMAP, then enter, then modifiers(0,0,0,0) — and Chromium's fresh WaylandKeyboard, whose xkb_state is still
 * NULL, calls xkb_state_update_mask(NULL) on it. Every index.js brings its own keyboard helper and each one-shot wtype is a keyboard
 * of its own, so the bag clear's process leaving and the agent's arriving turned the capability OFF and ON under a running browser
 * (measured with a Chromium-like probe client: MODIFIERS-BEFORE-KEYMAP on 29/30 new keyboards; with one keyboard alive the whole run,
 * 0 and a single keyboard object). One keyboard device is therefore held for the instance's whole life, up BEFORE Chromium: its
 * first wl_keyboard sees a real keymap and the capability never toggles while it lives. It types nothing; it exits on "quit", on
 * SIGTERM, or by itself when its stdin closes (the owning process died). No helper binary, or no "ready" in time → null, and the
 * instance runs as before (logged by the caller).
 */
export async function startKeyboardHolder({ env, binary = defaultHelperBinary(env), spawnImpl = spawn, exists = existsSync, timeoutMs = 3000 } = {}) {
  if (!binary || !exists(binary)) return { proc: null, why: `no keyboard helper at ${binary}` };
  let proc;
  try { proc = spawnImpl(binary, [], { env, stdio: ["pipe", "pipe", "ignore"] }); } catch (e) { return { proc: null, why: `spawn failed (${e?.code || e?.message || e})` }; }
  const ready = await new Promise((resolve) => {
    let buf = "";
    const done = (v) => { clearTimeout(timer); proc.stdout?.off?.("data", onData); resolve(v); };
    const onData = (d) => { buf += String(d); if (/^ready$/m.test(buf)) done(true); };
    const timer = setTimeout(() => done(false), timeoutMs);
    proc.stdout?.on?.("data", onData);
    proc.once?.("exit", () => done(false));
    proc.once?.("error", () => done(false));
  });
  if (!ready) { try { proc.kill("SIGTERM"); } catch {} return { proc: null, why: "the helper did not report ready" }; }
  proc.stdout?.resume?.(); // its later answers are drained, never read
  return { proc, why: null };
}
/** Ends the holder: "quit" on its stdin, then SIGTERM if it is still there after a beat. Never throws. */
export async function stopKeyboardHolder(proc, { waitMs = 500 } = {}) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return;
  const exited = new Promise((r) => proc.once("exit", r));
  try { proc.stdin.write("quit\n"); proc.stdin.end(); } catch {}
  const t = await Promise.race([exited.then(() => "exited"), new Promise((r) => setTimeout(() => r("timeout"), waitMs))]);
  if (t !== "exited") { try { proc.kill("SIGTERM"); } catch {} }
}

export function chromiumEnvFor({ base = {}, runtimeDir, waylandDisplay, usExitProxy = null } = {}) {
  const env = { ...base, XDG_RUNTIME_DIR: runtimeDir, WAYLAND_DISPLAY: waylandDisplay, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  if (usExitProxy != null) {
    let url;
    try { url = new URL(usExitProxy); } catch { throw new TypeError("usExitProxy must be a URL"); }
    if (!["http:", "socks5:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
      throw new TypeError("usExitProxy must be a loopback http:// or socks5:// proxy with no credentials");
    }
    const proxy = `${url.protocol}//${url.host}`;
    Object.assign(env, { http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, no_proxy: "localhost,127.0.0.1,::1" });
  }
  return env;
}

/** A persistent profile's HTTP cache, kept between runs (a person's browser does not re-download a store's
 * scripts, fonts and images on every visit). Measured 2026-09-26: with the cache in the per-run instance dir,
 * every run started cold and Owala's cart took ~8.5 s to show content. One browser per profile at a time (the
 * profile lock), so the cache is never shared by two live browsers. */
export function persistentCacheDir(profileKey, root = process.env.COMPUTER_USE_CACHE_ROOT || path.join(os.homedir(), ".cache", "omarchy-computer-use", "browser-cache")) {
  return path.join(path.resolve(root), path.basename(persistentProfileDir(profileKey)));
}

// Ad, analytics, session-replay and marketing-popup hosts that no task needs. Refused by the loopback blocking proxy of
// our own instances only (never a system policy: the user's own Chromium is untouched), the way an ad blocker leaves them
// unloaded. Session-replay scripts observe every DOM change, and with several browsers in parallel the pages' own CPU
// becomes the bottleneck. Security and site-operation domains are never listed.
export const BLOCKED_TRACKER_HOSTS = Object.freeze([
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com", "adservice.google.com",
  "connect.facebook.net", "analytics.tiktok.com", "ct.pinterest.com", "s.pinimg.com", "bat.bing.com", "sc-static.net",
  "tr.snapchat.com", "static.ads-twitter.com", "ads-twitter.com", "redditstatic.com", "alb.reddit.com",
  "amazon-adsystem.com", "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com", "rubiconproject.com",
  "quantummetric.com", "fullstory.com", "hotjar.com", "clarity.ms", "contentsquare.net", "mouseflow.com",
  "crazyegg.com", "heapanalytics.com", "logrocket.io", "smartlook.com", "glassboxdigital.io",
  "attn.tv", "attentivemobile.com", "privy.com", "justuno.com", "wisepops.com", "postscript.io",
]);
export function chromiumArgv({ profileDir, cacheDir, instanceDir = null, initialUrl, allowInsecureLocalhost = false, softwareRender = false } = {}) {
  return [
    `--user-data-dir=${profileDir}`,
    // Keep an instance-owned path (and therefore the random instance ID)
    // in argv even when user-data-dir is persistent. Teardown's process
    // fingerprint requires that unforgeable token before it will signal a
    // process group. Cache is disposable; cookies/preferences are not.
    `--disk-cache-dir=${cacheDir}`,
    // Bounded, and the instance-owned path (the teardown token) stays in argv even when the cache is persistent.
    "--disk-cache-size=314572800",
    // Never the crash-restore prompt, whatever the previous run's ending (see seedChromiumPreferences).
    "--hide-crash-restore-bubble",
    ...(instanceDir ? [`--crash-dumps-dir=${path.join(instanceDir, "crash-dumps")}`] : []),
    // Ozone platform is STATED, not auto-detected. Chromium's auto-detection
    // reads the SPAWNING process's session env, so a caller whose env lacks
    // XDG_SESSION_TYPE (a CI runner, a cron job, an agent's tmux pane, a
    // restarted parent) makes Chromium select X11, exit immediately with
    // "Missing X server or $DISPLAY" / "The platform failed to initialize",
    // and never map a window -- which surfaces here as all three spawn
    // retries failing with "Timed out waiting for chromium window", i.e. the
    // whole headless harness being unrunnable outside an interactive desktop
    // session. There is nothing to detect: this instance is a nested
    // wlroots/Sway compositor with no X server at all, so Wayland is the only
    // platform that can work. (Chromium logs that this is "not compatible
    // with Vulkan" -- verified as a GPU-path warning only: the window maps
    // and the page renders.)
    "--ozone-platform=wayland",
    // Software (SwiftShader) GL for callers that only read the accessibility tree (the catalog harvester): route
    // all GL through ANGLE's CPU SwiftShader backend so rendering never runs on the host GPU. Under the harvester's
    // rapid spawn/SIGKILL churn, killing ACTIVE GPU compositing mid-DRM-ioctl leaves a wedged GPU context that can
    // hang the HOST compositor sharing that GPU (observed: it dropped Hyprland into safe mode). SwiftShader keeps
    // that off the GPU while leaving the browser otherwise standard (--disable-gpu is denylisted: some sites reset
    // requests from a browser with GPU flags). Accessibility is a separate, GPU-independent Chromium
    // subsystem, so the tree read is unaffected. OFF by default — manual/streaming keeps its GPU path, argv byte-identical.
    ...(softwareRender ? ["--use-gl=angle", "--use-angle=swiftshader"] : []),
    "--force-renderer-accessibility",
    // The omnibox popup as a native view, never a WebUI DOCUMENT (2026-10-03, live on Coach's bag, Alo's /cart, Nike's bag link):
    // Chromium 151's WebUI omnibox popups ("AI Mode" omnibox_popup_aim.html) are hidden `document web`s that take keyboard focus
    // after a navigation — typed OR a link press — and while one holds it the page's own document stays an EMPTY placeholder in
    // the accessibility tree (no name, no URI, 0 children; the popup's own load shows as chrome-error://chromewebdata/). Every
    // read is then "no page document URI could be read" for as long as it lasts (17 s+, Escape changes nothing); a click on the
    // page body gives the page focus and its tree appears at once. Browser UI only — nothing a page can observe.
    "--disable-features=WebUIOmniboxAimPopup,WebUIOmniboxPopup,WebUIOmniboxFullPopup",
    "--lang=en-US",
    "--accept-lang=en-US,en",
    "--no-first-run",
    "--no-default-browser-check",
    // No DevTools flag exists here: it would break this harness's
    // accessibility/uinput control boundary.
    ...(allowInsecureLocalhost ? ["--allow-insecure-localhost"] : []),
    "--new-window",
    initialUrl,
  ];
}

// PERSISTENT-PROFILE HYGIENE. Rules:
//   1. Persistent per-site profiles STAY: a profile with ordinary cookie history
//      behaves like a normal browser (signed-in state, saved settings), and a
//      DevTools flag on the command line, not the profile, is what breaks pages.
//   2. Every persistent profile (typically one per site, or one per user
//      session) keeps a small LEDGER of session outcomes
//      inside the profile, written by the caller from observed page evidence,
//      and is QUARANTINED — renamed aside as `<key>.blocked-<timestamp>`, the
//      manual precedent, never deleted, never reused — before the next spawn
//      when the last session ended in a challenge, or in an application error
//      on an (origin, kind) the same profile had completed before.
//   3. Nothing deletes a persistent profile automatically: quarantine is a
//      rename, and the shopper's cart-preparation profiles are never touched.
export const PROFILE_LEDGER_FILE = ".computer-use-ledger.json";
export const PROFILE_LEDGER_MAX_ENTRIES = 200;
export const PROFILE_OUTCOME_KINDS = Object.freeze(["search", "product", "cart"]);
const PROFILE_OUTCOME_CLASSES = new Set(["challenge", "application_error", null]);
/** Read a profile's outcome ledger. Missing or corrupt → { entries: [] }; never throws. */
export async function readProfileLedger(profileDir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(profileDir, PROFILE_LEDGER_FILE), "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter(validLedgerEntry) : [];
    return { entries };
  } catch { return { entries: [] }; }
}
function validLedgerEntry(e) {
  return !!e && typeof e === "object" && typeof e.at === "string" && Number.isFinite(Date.parse(e.at))
    && PROFILE_OUTCOME_CLASSES.has(e.class ?? null) && (e.origin === null || typeof e.origin === "string") && PROFILE_OUTCOME_KINDS.includes(e.kind);
}
/** Append one outcome { at, class, origin, kind } (validated); keeps the last PROFILE_LEDGER_MAX_ENTRIES. */
export async function writeProfileLedger(profileDir, entry) {
  const normalized = { at: entry?.at, class: entry?.class ?? null, origin: entry?.origin ?? null, kind: entry?.kind };
  if (!validLedgerEntry(normalized)) throw new TypeError("invalid profile ledger entry");
  if (normalized.origin !== null) { let u; try { u = new URL(normalized.origin); } catch { throw new TypeError("ledger origin must be an http(s) origin"); } normalized.origin = u.origin; }
  const ledger = await readProfileLedger(profileDir);
  const entries = [...ledger.entries, normalized].slice(-PROFILE_LEDGER_MAX_ENTRIES);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(profileDir, PROFILE_LEDGER_FILE), JSON.stringify({ entries }), { mode: 0o600 });
  return { entries };
}
/** Pure: should the profile be set aside before its next use? */
export function profileQuarantineDecision(ledger) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries.filter(validLedgerEntry) : [];
  if (!entries.length) return { quarantine: false, reason: "no-ledger" };
  const last = entries[entries.length - 1];
  if (last.class === "challenge") return { quarantine: true, reason: "last-session-challenge" };
  if (last.class === "application_error") {
    const completedBefore = entries.slice(0, -1).some((e) => e.class === null && e.origin === last.origin && e.kind === last.kind);
    if (completedBefore) return { quarantine: true, reason: "application-error-after-earlier-completion" };
    return { quarantine: false, reason: "application-error-without-earlier-completion" };
  }
  return { quarantine: false, reason: "last-session-completed" };
}
function quarantineName(profileDir, now = new Date()) {
  // The manual precedent: <key>.blocked-<compact UTC stamp>, e.g. .blocked-20260902T230600Z
  const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  return `${profileDir}.blocked-${stamp}`;
}
async function renameProfileAside(profileDir, now) {
  const target = quarantineName(profileDir, now);
  try { await rename(profileDir, target); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
  return target;
}
/** Rename a persistent profile aside (never delete). Refuses an active key. Returns the new path, or null when absent. */
export async function quarantinePersistentProfile(profileKey, { root, now = new Date() } = {}) {
  const profileDir = root === undefined ? persistentProfileDir(profileKey) : persistentProfileDir(profileKey, root);
  if (activePersistentProfiles.has(profileDir)) throw new Error(`persistent profile in use: ${profileKey}`);
  return renameProfileAside(profileDir, now);
}

export function persistentProfileDir(profileKey, root = process.env.COMPUTER_USE_PROFILE_ROOT || path.join(os.homedir(), ".local", "state", "omarchy-computer-use", "browser-profiles")) {
  if (typeof profileKey !== "string" || !/^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/i.test(profileKey)) {
    throw new TypeError("persistent profile key must be 1-128 hostname-safe characters");
  }
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot === path.parse(resolvedRoot).root) throw new TypeError("persistent profile root cannot be a filesystem root");
  return path.join(resolvedRoot, profileKey.toLowerCase());
}

// Seed only the Chromium-owned preferences that would otherwise surface
// credential/autofill UI during an isolated automation run. Read and merge
// first so persistent profiles retain every unrelated preference.
export async function seedChromiumPreferences(profileDir, { addressAutofill = false } = {}) {
  const preferencesPath = path.join(profileDir, "Default", "Preferences");
  let preferences = {};
  try { preferences = JSON.parse(await readFile(preferencesPath, "utf8")); } catch (e) {
    if (e?.code !== "ENOENT") throw new Error(`invalid Chromium Preferences: ${e.message}`);
  }
  preferences.credentials_enable_service = false;
  // Location and notification permission are blocked outright, as a person
  // would set them: the page never raises a permission request. (Live Dick's
  // checkout asks for location from its ZIP box; the Chromium browser process
  // segfaulted at the same address twice right there.)
  const profile = { ...(preferences.profile || {}), password_manager_enabled: false };
  profile.default_content_setting_values = { ...(profile.default_content_setting_values || {}), geolocation: 2, notifications: 2 };
  // Teardown ends the browser by signal, so Chromium records every run as a crash ("exit_type": "Crashed") and the
  // next launch of a persistent profile opens with "Restore pages? Chromium didn't shut down correctly" over the
  // store (live YoungLA 2026-09-26). The profile is marked as having exited normally before each launch.
  profile.exit_type = "Normal";
  profile.exited_cleanly = true;
  preferences.profile = profile;
  preferences.autofill = {
    // Address autofill only when asked (cart runs: the saved delivery address). Cards never.
    ...(preferences.autofill || {}), enabled: !!addressAutofill, profile_enabled: !!addressAutofill, credit_card_enabled: false,
  };
  await mkdir(path.dirname(preferencesPath), { recursive: true, mode: 0o700 });
  await writeFile(preferencesPath, JSON.stringify(preferences), { mode: 0o600 });
  return preferences;
}

async function waitFor(fn, { timeoutMs = 10000, intervalMs = 150, label = "condition" } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

// A raw AF_UNIX connect() that resolves true once the server is ACCEPTING (listen() is up), false on
// ECONNREFUSED/ENOENT — bound-but-not-yet-listening, or the file not there yet. It never rejects for those:
// they are the "keep polling" cases. The socket is unref'd and destroyed immediately; a bare connect+close
// with no Wayland handshake is a client the compositor drops without ceremony.
function defaultSocketConnectProbe(socketPath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; try { sock.destroy(); } catch {} resolve(ok); };
    const sock = netConnect({ path: socketPath });
    sock.unref();
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

// bind() makes a unix socket FILE visible before listen() is necessarily accepting; under sustained instance
// churn that gap is real and surfaces as Chromium's "Failed to connect to Wayland display: Connection refused
// (111)". Poll a real connect() until it lands — the exact readiness condition the file's mere existence does
// NOT prove — bounded by timeoutMs. This replaces a blind settle sleep with a measured mechanism: it costs the
// true gap (tens of ms idle) and waits longer only when the gap genuinely is, instead of a fixed guess that is
// both wasteful idle and unsafe if churn ever exceeds it. checkAbort (default: the module shutdown guard) bails
// the poll loop early. connectImpl is injectable so the wait is unit-testable without a compositor.
export async function probeSocketAccepting(socketPath, { timeoutMs = 8000, pollMs = 20, label = "socket", connectImpl = defaultSocketConnectProbe, checkAbort = assertNotShuttingDown } = {}) {
  const start = Date.now();
  let attempts = 0;
  for (;;) {
    checkAbort();
    attempts++;
    if (await connectImpl(socketPath)) return { attempts, waitedMs: Date.now() - start };
    if (Date.now() - start >= timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label} to accept connections`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${err}`));
      else resolve(out);
    });
  });
}

function findChromiumPid(node) {
  if (node.app_id === "chromium" && node.pid) return node.pid;
  for (const child of [...(node.nodes || []), ...(node.floating_nodes || [])]) {
    const found = findChromiumPid(child);
    if (found) return found;
  }
  return null;
}


// --- Chromium exit recorder (diagnostics only) ------------------------------
// Writes a bounded, TEXT-FREE record of how this instance's browser ended, for
// the MCP server to read when an AT-SPI app lookup misses. It never retries
// anything, never touches the frozen window pid, and never influences the run.
//
// Ordering matters and is enforced: 'exit' and 'close' can arrive in either
// order, and a close that clobbered the exit code would destroy the one datum
// worth capturing. Every update goes through one per-instance promise chain, so
// writes are serialized and a later event can never overwrite an earlier
// verdict through interleaving.
const exitRecorders = new WeakMap();

export function attachExitRecorder(handle, child, workDir, deps = {}) {
  // MONOTONIC clock. The delta is the only time value reported, and a wall
  // clock can step backwards (NTP, suspend), which would produce a negative or
  // absurd "age" precisely in a post-mortem. No epoch value is persisted.
  const now = deps.now || (() => performance.now());
  const state = {
    path: path.join(workDir, EXIT_LOG_BASENAME),
    stderr: new BoundedStderr(),
    record: runningRecord({ leaderPid: child.pid }),
    startedAt: now(),
    now,
    chain: Promise.resolve(),
    stopped: false,
    ready: null,
  };
  exitRecorders.set(handle, state);

  // Drain stderr into the bounded ring. Contents never leave this process.
  child.stderr?.on("data", (chunk) => state.stderr.push(chunk));
  child.stderr?.on("error", () => {});
  child.stderr?.unref?.();

  const update = (event, code, signal) => {
    state.chain = state.chain.then(async () => {
      // A late event after teardown must NOT recreate a deleted directory.
      if (state.stopped) return;
      state.record = applyExitEvent(state.record, {
        event,
        code: code ?? null,
        signal: signal ?? null,
        msFromSpawn: Math.max(0, Math.round(state.now() - state.startedAt)),
        stderr: state.stderr.stats(),
        markers: state.stderr.markers(),
        windowPid: handle.chromiumPid ?? null,
      });
      await writeExitRecord(state);
    }).catch(() => {});
    return state.chain;
  };
  child.on("exit", (code, signal) => update("exit", code, signal));
  child.on("close", (code, signal) => update("close", code, signal));

  // PRECREATE, and expose it as an AWAITABLE barrier. Spawn awaits this before
  // the handle can be observed, so "a record exists" is a guarantee rather than
  // a hope: absence then means "no recorder", never "not written yet".
  // The outcome is explicit — an initial-write failure settles as {ok:false}
  // and is never silently reported as precreated.
  state.ready = state.chain
    .then(() => writeExitRecordOrThrow(state))
    .then(() => ({ ok: true }), (e) => ({ ok: false, reason: e?.code || e?.message || "write failed" }));
  state.chain = state.ready;
  return state;
}

/** Atomic replace: temp file in the SAME 0700 workDir, then rename. A reader
 * therefore sees either the previous complete record or the next one, never a
 * half-written file. Throws so the precreate barrier can report an explicit
 * outcome; the event path uses the swallowing wrapper below. */
async function writeExitRecordOrThrow(state) {
  if (state.stopped) return;
  const tmp = `${state.path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state.record), { mode: 0o600 });
    // Re-check AFTER the write: a stop may have landed while it was in flight,
    // and renaming into a directory teardown is removing would resurrect it.
    if (state.stopped) {
      await rm(tmp, { force: true }).catch(() => {});
      return;
    }
    await rename(tmp, state.path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** A diagnostic must never become a second failure, and after teardown the
 * directory is legitimately gone, so lifecycle-event writes swallow. */
async function writeExitRecord(state) {
  try { await writeExitRecordOrThrow(state); } catch {}
}

/** Stop recording before the directory is removed, so a late exit/close event
 * cannot recreate anything under a path teardown has already deleted. Returns
 * the settled chain so teardown can DRAIN an in-flight write before removing. */
/** The browser process's own exit as its recorder saw it — { state, signal, code } — or null while it runs (or without a recorder).
 * 2026-10-03: Chromium SIGSEGVs in xkb_state_update_mask (25 coredumps in a week) looked like empty reads; the runner retries on this. */
export function chromiumExitOf(handle) {
  const r = exitRecorders.get(handle)?.record;
  if (!r || r.state === "running") return null;
  return { state: r.state, signal: r.exit_signal ?? null, code: r.exit_code ?? null };
}
export function stopExitRecorder(handle) {
  const state = exitRecorders.get(handle);
  if (!state) return Promise.resolve();
  state.stopped = true;
  return state.chain.catch(() => {});
}

// --- Lifecycle ownership ----------------------------------------------------
// MEASURED, with a disposable child harness: on SIGTERM and on SIGINT the test
// process died and the compositor, the browser AND BOTH directories all
// survived, every time. sway and chromium are detached, so each sits in its
// own PROCESS GROUP that a signal to the
// test process never reaches — and with no handler installed anywhere, the
// `finally` that owns teardown was simply never reached.
//
// Every instance owns TWO directories, which is easy to miss and was missed
// repeatedly: a workDir under /tmp and a runtimeDir under XDG_RUNTIME_DIR.
// Cleaning one and declaring victory leaves the other behind forever.
//
// Ownership lives HERE rather than in each suite: a handler copied into fifteen
// suites is fifteen chances to get it wrong, and they would drift.
const registry = new Map();          // handle -> { closing: Promise|null, hooks: [] }
let signalsInstalled = false;
let shutdown = null;                 // ONE process-wide shutdown, shared by every signal
const teardownStats = { kills: 0, rms: 0, hooks: 0, groups: { chromium: 0, sway: 0 } };

export function resetTeardownStats() { teardownStats.kills = 0; teardownStats.rms = 0; teardownStats.hooks = 0; teardownStats.groups.chromium = 0; teardownStats.groups.sway = 0; }
export function getTeardownStats() { return { ...teardownStats, groups: { ...teardownStats.groups } }; }

function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, onSignal);
}

function removeSignalHandlers() {
  if (!signalsInstalled) return;
  signalsInstalled = false;
  for (const sig of ["SIGTERM", "SIGINT"]) process.removeListener(sig, onSignal);
}

// A SECOND signal during cleanup must JOIN the shutdown already running, never
// start another one and never re-raise early — that would kill the process
// while the first cleanup is still holding resources open.
function onSignal(sig) {
  if (shutdown) return;
  if (process.env.HEADLESS_TEST_PHASE_DIR) {
    try { writeFileSync(path.join(process.env.HEADLESS_TEST_PHASE_DIR, "SIGNAL-RECEIVED"), sig); } catch {}
  }
  shutdown = (async () => {
    // New spawns are rejected once shutdown is set. Drain in a loop anyway so
    // a spawn that crossed the last async boundary is joined before re-raise.
    while (registry.size) {
      const results = await Promise.allSettled([...registry.keys()].map((h) => teardownHeadlessInstance(h)));
      for (const r of results) {
        if (r.status === "rejected") console.error(`[headless teardown] ${r.reason?.message || r.reason}`);
      }
    }
    // Report, never swallow: a failed kill or remove is exactly what someone
    // debugging a leftover process needs to see.
    // Restore the default disposition and re-send the ORIGINAL signal, so the
    // parent observes conventional signal termination rather than exit 0.
    removeSignalHandlers();
    process.kill(process.pid, sig);
  })();
}

/** Register a cleanup hook the signal path must also run — e.g. a suite
 * restoring shared state it captured before starting. Generic on purpose: this
 * module knows nothing about what the hook restores.
 * Register it only AFTER the original state has been captured, or a signal
 * arriving in between would "restore" something never recorded. */
export function registerCleanupHook(handle, hook) {
  const entry = registry.get(handle);
  if (!entry) throw new Error("registerCleanupHook: unknown or already torn-down instance");
  entry.hooks.push(hook);
}

// --- Safety net: max lifetime, owner record, sweep ---------------------------
// Normal teardown is the caller's `finally`. It never runs when a job HANGS, or
// when the owning process CRASHES (SIGKILL, OOM, a restart mid-job): the browser
// then keeps its CPU and memory forever. Two backstops:
//   1. every instance has a max lifetime; past it this process tears it down
//      through the ordinary teardown path and resolves `handle.expired`, so the
//      job sees an ended run instead of waiting on a dead browser;
//   2. every instance writes an owner record (pid + its /proc starttime, label,
//      start, lifetime, the process fingerprints) into its workDir, and a sweep
//      tears down instances whose owner is dead, or which are this process's own
//      and past their lifetime. Another LIVE process's instance is never touched
//      (the variant bench, a probe): its own timer owns it. No record → left alone.
export const MAX_LIFETIME_MS = Object.freeze({
  read: 5 * 60_000,     // a gallery store search or a product read (their own budgets are 75 s / 45 s)
  session: 15 * 60_000, // a cart or manual session (their deadlines are 10-12 min)
  default: 30 * 60_000, // anything that does not say: benches, harvests, probes
});
export const OWNER_RECORD_FILE = "owner.json";
const INSTANCE_DIR_RE = /^computer-use-headless-([0-9a-f]{8})$/;
const startTimeOf = (pid) => procRecord(pid)?.starttime || null;

function writeOwnerRecord(handle) {
  const entry = registry.get(handle);
  if (!entry?.owner) return;
  const record = { ...entry.owner, runtimeDir: handle.runtimeDir, workDir: handle.workDir, sway: entry.sway || null, chromium: entry.chromium || null };
  const file = path.join(handle.workDir, OWNER_RECORD_FILE);
  // Atomic replace; a write after teardown removed the dir fails (ENOENT) and is dropped, never recreating it.
  try { writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 }); renameSync(`${file}.tmp`, file); } catch {}
}

/** Pure: what the sweep does with one owner record. `startTimeOf(pid)` is the owner's /proc starttime now (null =
 * gone); a different starttime means the pid was recycled, i.e. the owner is dead. Returns { action, reason }, action
 * "kill" | "keep" | "skip" (not a valid record: never touched). */
export function sweepDecision(record, { now = Date.now(), selfPid = process.pid, selfStart = startTimeOf(process.pid), registeredIds = new Set(), startTimeOf: owner = startTimeOf } = {}) {
  if (!record || typeof record !== "object" || typeof record.id !== "string" || !/^[0-9a-f]{8}$/.test(record.id)
    || !Number.isInteger(record.ownerPid) || record.ownerPid <= 1 || !Number.isFinite(record.startedAt)
    || !Number.isFinite(record.maxLifetimeMs) || record.maxLifetimeMs <= 0) return { action: "skip", reason: "no-valid-record" };
  const ownerNow = owner(record.ownerPid);
  const ownerAlive = ownerNow != null && (record.ownerStart == null || ownerNow === record.ownerStart);
  if (!ownerAlive) return { action: "kill", reason: "owner-dead" };
  const mine = record.ownerPid === selfPid && (record.ownerStart == null || record.ownerStart === selfStart);
  if (!mine) return { action: "keep", reason: "other-owner" };
  // Ours but no longer registered: its teardown already ran (or failed) and left it behind.
  if (!registeredIds.has(record.id)) return { action: "kill", reason: "orphaned" };
  if (now - record.startedAt > record.maxLifetimeMs) return { action: "kill", reason: "max-lifetime" };
  return { action: "keep", reason: "within-lifetime" };
}

/** Find and tear down leftover instances under `tmpDir` (see sweepDecision). Never throws. Logs one line only when it
 * killed something. Returns { checked, killed: [{ id, label, reason }] }. */
export async function sweepHeadlessInstances({ tmpDir = os.tmpdir(), now = Date.now(), log = (line) => console.error(line), tearDown = tearDownRecord } = {}) {
  const killed = [];
  let names = [];
  try { names = readdirSync(tmpDir); } catch { return { checked: 0, killed }; }
  const own = new Map([...registry.keys()].map((h) => [h.id, h]));
  let checked = 0;
  for (const name of names) {
    const id = INSTANCE_DIR_RE.exec(name)?.[1];
    if (!id) continue;
    checked++;
    let record = null;
    try { record = JSON.parse(readFileSync(path.join(tmpDir, name, OWNER_RECORD_FILE), "utf8")); } catch {}
    if (record?.id !== id) continue;                  // missing, corrupt, or not this dir's: leave it alone
    const decision = sweepDecision(record, { now, registeredIds: new Set(own.keys()) });
    if (decision.action !== "kill") continue;
    if (own.has(id)) registry.get(own.get(id))?.expire?.({ reason: "max_lifetime_exceeded" });
    try { await (own.has(id) ? teardownHeadlessInstance(own.get(id)) : tearDown(record, path.join(tmpDir, name))); }
    catch (e) { log(`[headless sweep] ${id} teardown reported ${e?.message || e}`); }
    killed.push({ id, label: record.label || "", reason: decision.reason });
  }
  if (killed.length) log(`[headless sweep] tore down ${killed.length} instance(s): ${killed.map((k) => `${k.label || k.id} (${k.reason})`).join(", ")}`);
  return { checked, killed };
}

/** Tear down an instance this process does not own, from its record alone: the same verified group kill as teardown
 * (endGroup re-checks every fingerprint, so a recycled pid is never signalled), then both directories. */
async function tearDownRecord(record, workDir) {
  const problems = [];
  for (const [label, rec] of [["chromium", record.chromium], ["sway", record.sway]]) {
    try { const p = await endGroup(rec, label); if (p) problems.push(p); } catch (e) { problems.push(`${label}: ${e?.message || e}`); }
  }
  // Only this instance's own runtime dir, named after its id; never a path the record merely claims.
  const runtimeDir = typeof record.runtimeDir === "string" && path.basename(record.runtimeDir) === `computer-use-headless-${record.id}` ? record.runtimeDir : null;
  for (const dir of [runtimeDir, workDir]) if (dir) await rm(dir, { recursive: true, force: true }).catch((e) => problems.push(`${dir}: ${e?.message || e}`));
  if (problems.length) throw new Error(problems.join("; "));
}

/** Sweep once now (leftovers of a crash or restart), then every `intervalMs` on an unref'd timer; a sweep still
 * running (a slow kill) is never overlapped. Returns the timer. */
export function startHeadlessSweeper({ intervalMs = 60_000, sweep = sweepHeadlessInstances } = {}) {
  let running = null;
  const tick = () => { if (!running) running = sweep().catch(() => {}).finally(() => { running = null; }); };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

/** This process's live instances and their memory: { count, rss_mb, instances: [{ id, label, age_s, rss_mb }] }. */
export function liveHeadlessInstances(now = Date.now()) {
  const instances = [...registry].map(([handle, entry]) => {
    let kb = 0;
    for (const rec of [entry.sway, entry.chromium]) {
      for (const m of rec ? ownedGroupMembers(rec) : []) {
        try { kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${m.pid}/status`, "utf8"))?.[1] || 0); } catch {}
      }
    }
    return { id: handle.id, label: handle.label || entry.owner?.label || "", age_s: Math.round((now - (entry.owner?.startedAt ?? now)) / 1000), rss_mb: Math.round(kb / 1024) };
  });
  return { count: instances.length, rss_mb: instances.reduce((n, i) => n + i.rss_mb, 0), instances };
}

/** For tests: how many signal listeners this module currently has installed. */
export function installedSignalListenerCount() {
  return ["SIGTERM", "SIGINT"].reduce((n, s) => n + process.listeners(s).filter((l) => l === onSignal).length, 0);
}

export function normalizeHeadlessInitialUrl(value) {
  if (value == null) return "about:blank";
  if (value === "about:blank") return value;
  if (typeof value !== "string") throw new TypeError("initialUrl must be an http(s) URL");
  let url;
  try { url = new URL(value); } catch { throw new TypeError("initialUrl must be an http(s) URL"); }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new TypeError("initialUrl must be an http(s) URL without credentials");
  }
  url.hash = "";
  return url.toString();
}

/**
 * Spawn one isolated headless automation instance.
 * @returns {Promise<object>} handle — pass this to teardownHeadlessInstance when done,
 *   and to instanceEnv() to get the env vars for spawning an MCP server against it.
 */
// Retries the whole spawn on failure. Caught live: under sustained
// multi-session load on this machine (several concurrent Claude Code
// sessions each running their own automation), a freshly-spawned sway
// process sometimes gets killed (SIGKILL, from outside this process --
// ruled out OOM-killer logs, GPU/DRM exhaustion, and orphaned processes as
// the direct cause, but couldn't fully pin down the mechanism without root
// access) within the first ~500ms of starting, well before Chromium even
// connects. A single retry consistently recovers when this happens, so
// treat it as transient contention rather than a hard failure.
const SPAWN_OPTIONS = new Set(["width", "height", "label", "persistentProfileKey", "initialUrl", "allowInsecureLocalhost", "beforeChromium", "onCaptureReady", "softwareRender", "usExitProxy", "addressAutofill", "profileSetup", "blockTrackers", "maxLifetimeMs"]);
export async function spawnHeadlessInstance(opts = {}, attempt = 1) {
  // Validate before allocating directories/processes, and keep invalid input
  // out of the transient-spawn retry loop.
  const normalizedOpts = { ...opts, initialUrl: normalizeHeadlessInitialUrl(opts.initialUrl) };
  const unknown = Object.keys(opts).filter((key) => !SPAWN_OPTIONS.has(key));
  if (unknown.length) throw new TypeError(`unknown spawn option(s): ${unknown.join(", ")} (DevTools/CDP has no option on this browser; AGENTS.md rule 7)`);
  if (opts.maxLifetimeMs !== undefined && (!Number.isInteger(opts.maxLifetimeMs) || opts.maxLifetimeMs < 1000 || opts.maxLifetimeMs > 24 * 3600_000)) throw new RangeError("maxLifetimeMs must be an integer 1000..86400000");
  if (opts.allowInsecureLocalhost === true && !/^https:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(normalizedOpts.initialUrl)) throw new TypeError("allowInsecureLocalhost is test-only and requires a loopback HTTPS initialUrl");
  try {
    return await spawnHeadlessInstanceOnce(normalizedOpts);
  } catch (e) {
    console.error(`[spawnHeadlessInstance] attempt ${attempt} failed: ${e.message}`);
    // A failure after the capture descriptor was announced is never retried: the caller's publisher is bound to
    // the compositor of THIS attempt, so a fresh instance would be one nobody is watching. Fail the session.
    if (e?.noRetry) throw e;
    if (shutdown || /shutdown|cancelled|persistent profile already in use/i.test(e?.message || "")) {
      await shutdown?.catch(() => {});
      throw e;
    }
    if (attempt >= 3) throw e;
    await new Promise((r) => setTimeout(r, 500 * attempt));
    return spawnHeadlessInstance(normalizedOpts, attempt + 1);
  }
}

async function spawnHeadlessInstanceOnce({ width = 1920, height = 1080, label = "", persistentProfileKey = null, initialUrl = "about:blank", allowInsecureLocalhost = false, beforeChromium = null, onCaptureReady = null, softwareRender = false, usExitProxy = null, addressAutofill = null, profileSetup = null, blockTrackers = undefined, maxLifetimeMs = MAX_LIFETIME_MS.default } = {}) {
  const id = randomUUID().slice(0, 8);
  const baseRuntimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const profileDir = persistentProfileKey
    ? persistentProfileDir(persistentProfileKey)
    : path.join(os.tmpdir(), `computer-use-headless-${id}`, "chromium-profile");
  if (persistentProfileKey && activePersistentProfiles.has(profileDir)) {
    throw new Error(`persistent profile already in use: ${persistentProfileKey}`);
  }
  if (persistentProfileKey) activePersistentProfiles.add(profileDir);
  const partialHandle = {
    id,
    runtimeDir: path.join(baseRuntimeDir, `computer-use-headless-${id}`),
    workDir: path.join(os.tmpdir(), `computer-use-headless-${id}`),
    profileDir,
    persistentProfileKey,
  };
  let resolveStartupDone;
  const startupDone = new Promise((resolve) => { resolveStartupDone = resolve; });
  const owner = { id, ownerPid: process.pid, ownerStart: startTimeOf(process.pid), label, startedAt: Date.now(), maxLifetimeMs };
  let expire;
  partialHandle.expired = new Promise((resolve) => { expire = resolve; });
  // Max lifetime (safety net): past it the instance is torn down whatever its job is doing, and `expired` resolves.
  const lifetimeTimer = setTimeout(() => {
    console.error(`[${label || id}] max lifetime ${Math.round(maxLifetimeMs / 1000)}s exceeded — tearing down`);
    expire({ reason: "max_lifetime_exceeded" });
    teardownHeadlessInstance(partialHandle).catch((e) => console.error(`[${label || id}] max-lifetime teardown reported ${e?.message || e}`));
  }, maxLifetimeMs);
  lifetimeTimer.unref();
  registry.set(partialHandle, { closing: null, hooks: [], cancelled: false, startupDone, resolveStartupDone, startupResolved: false, sway: null, chromium: null, swayProc: null, chromiumProc: null, owner, lifetimeTimer, expire });
  installSignalHandlers();
  if (shutdown) {
    registry.delete(partialHandle);
    if (persistentProfileKey) activePersistentProfiles.delete(profileDir);
    clearTimeout(lifetimeTimer);
    if (!registry.size) removeSignalHandlers();
    throw new Error("headless instance spawn refused during shutdown");
  }
  const { runtimeDir, workDir } = partialHandle;
  try {
    assertStartupOwned(partialHandle);
    await phaseGate("runtime-mkdir", partialHandle);
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    assertStartupOwned(partialHandle);
    // A disposable profile is nested below workDir and used to create this
    // parent as a side effect. Persistent profiles live elsewhere, so the
    // lifecycle directory must be created explicitly for both modes.
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    writeOwnerRecord(partialHandle);
    assertStartupOwned(partialHandle);
    if (persistentProfileKey) {
      // rev 16: a persistent profile whose ledger says its last session hit a
      // challenge (or an application error on ground it had covered before)
      // is set aside — renamed, never deleted — and this key starts fresh.
      const decision = profileQuarantineDecision(await readProfileLedger(profileDir));
      if (decision.quarantine) {
        const aside = await renameProfileAside(profileDir, new Date());
        if (aside) console.error(`[headless] quarantined persistent profile ${persistentProfileKey} (${decision.reason}) -> ${path.basename(aside)}`);
      }
    }
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    if (persistentProfileKey) await chmod(profileDir, 0o700);
    // addressAutofill: Chromium's ADDRESS autofill setting on for this persistent profile (cards stay off).
    // profileSetup(profileDir): the caller's own preparation of the profile before Chromium starts and locks its files
    // (e.g. saving an address into the profile's autofill store). Persistent profiles only; a failure is logged, never fatal.
    const autofillOn = !!addressAutofill && !!persistentProfileKey;
    await seedChromiumPreferences(profileDir, { addressAutofill: autofillOn });
    if (typeof profileSetup === "function" && persistentProfileKey) {
      try { await profileSetup(profileDir); } catch (e) { console.error(`[headless] profileSetup failed: ${String(e?.message || e).slice(0, 200)}`); }
    }

  const configPath = path.join(workDir, "sway.conf");
  assertStartupOwned(partialHandle);
  await writeFile(configPath, visibleInstances() ? visibleSwayConfig() : swayConfig(width, height));

  // Something on this machine (root-owned; not yet identified) SIGKILLs any
  // process executed from the literal path /usr/bin/sway within ~100ms of
  // exec. Confirmed by direct experiment (2026-08-28, idle fresh-boot
  // system): /usr/bin/sway dies every time; the byte-identical binary copied
  // to any other path — even still named "sway" — runs a fully working
  // headless compositor indefinitely. A sleep binary renamed "sway" is NOT
  // killed, so the matcher is the exe path, not the process name. This, not
  // load contention, was the real cause of the "headless spawn instability
  // under sustained load" that blocked earlier sessions (the retries only
  // ever succeeded when they raced the killer's ~100ms window). Running a
  // private per-instance copy sidesteps it entirely.
  const swayBin = path.join(workDir, "sway");
  assertStartupOwned(partialHandle);
  await phaseGate("binary-copy", partialHandle);
  await copyFile("/usr/bin/sway", swayBin);
  await chmod(swayBin, 0o755);

  const swayEnv = { ...process.env, XDG_RUNTIME_DIR: runtimeDir, WLR_BACKENDS: visibleInstances() ? "wayland" : "headless" };
  delete swayEnv.WAYLAND_DISPLAY;
  // A visible instance connects to the desktop compositor by absolute socket path (its own runtime dir stays isolated).
  if (visibleInstances()) swayEnv.WAYLAND_DISPLAY = path.join(process.env.DESKTOP_XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, process.env.DESKTOP_WAYLAND_DISPLAY || "wayland-1");
  // The private copy avoids the machine's /usr/bin/sway killer. Launch it
  // directly: detached:true makes this PID the truthful group/session leader;
  // wrapping it in setsid forks and loses ownership during partial startup.
  // --unsupported-gpu: a VISIBLE instance otherwise shows sway's red "proprietary GPU drivers are not supported" bar
  // across every agent window on this machine's GPU. Headless instances are launched exactly as before.
  const swayProc = spawn(swayBin, visibleInstances() ? ["--unsupported-gpu", "-c", configPath] : ["-c", configPath], {
    env: swayEnv,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  swayProc.unref();
  // A visible demo places each window in its grid slot the moment it maps: say which one it is right away (the
  // compositor's pid), not after the browser is up.
  if (visibleInstances() && process.env.COMPUTER_USE_ANNOUNCE_WINDOW === "1") console.log(`[window] ${String(label).replace(/^cartprep-/, "")} ${swayProc.pid}`);
  partialHandle.priority = { level: headlessNiceLevel(), sway: null, chromium: null };
  partialHandle.priority.sway = await lowerTreePriority(swayProc.pid, partialHandle.priority.level);
  if (partialHandle.priority.sway.errors.length) console.error(`[headless] sway priority not fully applied (instance ${id}): ${partialHandle.priority.sway.errors.join("; ")}`);

  registry.get(partialHandle).swayProc = swayProc;
  registry.get(partialHandle).sway = await captureFingerprint(swayProc.pid, id, swayBin);
  partialHandle.swayPid = swayProc.pid;
  writeOwnerRecord(partialHandle);
  await phaseGate("post-sway-fingerprint", partialHandle);
  assertNotShuttingDown();

  let waylandDisplay, swaySock, swayPid, chromiumPid, chromiumProc;
  // Once the capture descriptor has been announced (onCaptureReady, before the window maps), a later failure
  // must NOT be retried: the caller has already started the publisher against THIS compositor, and a retry
  // would spawn a different instance the publisher is not watching. Such a failure fails the session instead.
  let captureAnnounced = false;
  try {
    // Wait for sway to claim its socket in this instance's isolated runtime dir.
    waylandDisplay = await waitFor(
      async () => {
        const entries = await readdir(runtimeDir).catch(() => []);
        return entries.find((f) => /^wayland-\d+$/.test(f));
      },
      { timeoutMs: 8000, label: `sway socket for instance ${id}` }
    );

    swaySock = await waitFor(
      async () => {
        const entries = await readdir(runtimeDir).catch(() => []);
        const name = entries.find((f) => f.startsWith("sway-ipc."));
        return name ? path.join(runtimeDir, name) : null;
      },
      { timeoutMs: 8000, label: `sway IPC socket for instance ${id}` }
    );
    swayPid = parseInt(path.basename(swaySock).match(/sway-ipc\.\d+\.(\d+)\.sock$/)?.[1], 10) || swayProc.pid;
    // The IPC PID must match the directly spawned leader, not an unrelated
    // window process.
    if (swayPid !== swayProc.pid) throw new Error(`sway PID ${swayPid} differs from spawned PID ${swayProc.pid}`);
    partialHandle.swayPid = swayPid;

    // The wayland socket FILE appearing (detected above via readdir) isn't
    // proof sway is actually listening yet -- bind() creates the visible
    // file before listen() is necessarily ready to accept, and under load
    // that gap is real: caught live via a manual reproduction with
    // Chromium's stderr captured (normally discarded), which showed
    // "Failed to connect to Wayland display: Connection refused (111)"
    // even though the socket file already existed. Probe an actual connect()
    // until it is accepting -- the exact condition, measured, instead of a
    // fixed settle guess (which was both wasteful idle and unsafe if the gap
    // ever exceeded it). Bounded by the same 8s/label cap as the file waits.
    await probeSocketAccepting(path.join(runtimeDir, waylandDisplay), { label: `wayland socket for instance ${id}` });
    assertNotShuttingDown();

    // A gate the caller runs while the compositor was coming up, resolved before Chromium (which loads the
    // store the instant it spawns) is launched: the manual worker passes its VPN/US-exit preflight here so the
    // check overlaps the compositor launch instead of preceding the whole spawn. The store still never loads
    // over an unproven exit — Chromium waits for this to resolve.
    if (beforeChromium) { await beforeChromium(); assertNotShuttingDown(); }

    // One keyboard for the instance's whole life, up BEFORE Chromium (startKeyboardHolder: the xkb SIGSEGV root cause)
    const holder = await startKeyboardHolder({ env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir, WAYLAND_DISPLAY: waylandDisplay } });
    registry.get(partialHandle).keyboardHolder = holder.proc;
    if (!holder.proc) console.error(`[headless] keyboard holder not started (instance ${id}): ${holder.why}; keyboard devices may come and go under Chromium`);
    assertNotShuttingDown();

    // Launch Chromium into it. --force-renderer-accessibility/--lang are also
    // set globally in ~/.config/chromium-flags.conf, but this instance doesn't
    // share that profile so they're passed explicitly here too.
    // --accept-lang (not just --lang) is the one that actually matters for
    // site content locale — it sets the Accept-Language HTTP header, which
    // is what a site like Nike uses server-side to decide English vs
    // Spanish content. Missing it here (caught live: a fresh headless
    // profile loaded Nike in Spanish) is a different bug from --lang, which
    // only affects Chromium's own UI strings. Also force LANG/LC_ALL so
    // nothing falls through to whatever locale this process inherited.
    // Tracker blocking goes through the loopback blocking proxy (tracker_block_proxy.mjs), in the proxy ENVIRONMENT
    // like the US exit: no command-line flag, so no "unsupported command-line flag" bar. A US-exit store keeps its exit.
    const block = (blockTrackers ?? process.env.COMPUTER_USE_BLOCK_TRACKERS === "1") && usExitProxy == null;
    const proxy = block ? await blockingProxy(BLOCKED_TRACKER_HOSTS).ready : usExitProxy;
    const chromiumEnv = chromiumEnvFor({ base: process.env, runtimeDir, waylandDisplay, usExitProxy: proxy });
    chromiumProc = spawn(
      "chromium",
      chromiumArgv({ profileDir, cacheDir: persistentProfileKey ? persistentCacheDir(persistentProfileKey) : path.join(workDir, "chromium-cache"), instanceDir: workDir, initialUrl, allowInsecureLocalhost, softwareRender }),
      // stderr is PIPED so the browser's own account of its death can be
      // classified. It is drained immediately into a bounded in-memory ring —
      // draining is what keeps a pipe from ever blocking the browser — and the
      // stream is unref'd so it cannot hold this process's event loop open
      // alongside the detached child. No captured byte is ever written to disk.
      { env: chromiumEnv, stdio: ["ignore", "ignore", "pipe"], detached: true }
    );
    chromiumProc.unref();
    partialHandle.priority.chromium = await lowerTreePriority(chromiumProc.pid, partialHandle.priority.level);
    if (partialHandle.priority.chromium.errors.length) console.error(`[headless] chromium priority not fully applied (instance ${id}): ${partialHandle.priority.chromium.errors.join("; ")}`);
    const exitRecorder = attachExitRecorder(partialHandle, chromiumProc, workDir);
    // Barrier: the record exists (or its failure is recorded) before this
    // handle can be used, so an observer never races the first write. A failed
    // precreate NEVER fails the browser spawn — this is a diagnostic — but the
    // outcome is carried on the handle so the observer can say truthfully that
    // no record was ever created, instead of reporting it as merely missing.
    partialHandle.exitRecorderReady = (await exitRecorder.ready).ok === true;
    // Recorded before the window is discovered: a signal arriving in the gap
    // must still be able to reap the browser.
    registry.get(partialHandle).chromiumProc = chromiumProc;
    registry.get(partialHandle).chromium = await captureFingerprint(chromiumProc.pid, id, "chromium");
    partialHandle.chromiumPid = chromiumProc.pid;
    writeOwnerRecord(partialHandle);
    await phaseGate("post-chromium-fingerprint", partialHandle);

    // The capture descriptor is complete now — the compositor is up and Chromium is launched into it — so a
    // caller that streams the instance (the manual session) can start the publisher HERE and let the customer
    // watch the browser open and the store paint, instead of waiting for the window to map (the retailer's
    // first paint, the bulk of the ~4 s). It is announced at most once; the window-map wait below still gates
    // the resolved handle (worker hold), and a window that never maps fails the session (see captureAnnounced).
    if (onCaptureReady) {
      captureAnnounced = true;
      await onCaptureReady(Object.freeze({ instance_id: id, runtime_dir: runtimeDir, wayland_display: waylandDisplay, width, height }));
    }

    // Wait for the window to actually map in sway, then read its PID back via
    // swaymsg (more reliable than trusting spawn()'s own PID — chromium
    // re-execs through a zygote, so the process we spawned isn't always the
    // one that ends up owning the window).
    chromiumPid = await waitFor(
      async () => {
        const tree = JSON.parse(await run("swaymsg", ["-t", "get_tree"], { env: { ...process.env, SWAYSOCK: swaySock } }));
        return findChromiumPid(tree) || null;
      },
      { timeoutMs: 15000, label: `chromium window for instance ${id}` }
    );
    registry.get(partialHandle).chromium = refreshChromiumFingerprint(registry.get(partialHandle).chromium, id, chromiumProc.pid);
    writeOwnerRecord(partialHandle);
    assertNotShuttingDown();
  } catch (e) {
    // Partial startup failure — clean up whatever did start before propagating.
    // Registered before allocation and process creation, so the partial-startup path cleans up
    // through the same owned route as everything else. Passing an unregistered
    // ad-hoc handle here would now be a silent no-op and leak the instance.
    if (captureAnnounced && e && typeof e === "object") e.noRetry = true; // window never mapped after the descriptor went out — fail, don't respawn
    resolveStartup(partialHandle);
    if (!registry.get(partialHandle)?.cancelled) await teardownHeadlessInstance(partialHandle);
    throw e;
  }

  // The instance was registered as soon as its processes existed (see
  // partialHandle above); this promotes that same object to the full handle so
  // there is exactly ONE registry entry per instance, owned end to end.
  Object.assign(partialHandle, { label, waylandDisplay, swaySock, swayPid, chromiumPid, width, height, initialUrl });
  resolveStartup(partialHandle);
  // NOTE the deliberate asymmetry: `chromiumPid` is the WINDOW pid AT-SPI talks
  // to, discovered via swaymsg. The fingerprint used for group teardown stays
  // the one recorded for the process we actually SPAWNED — overwriting it here
  // would target a pid we never launched and whose group we never verified.
  return partialHandle;
  } catch (e) {
    resolveStartup(partialHandle);
    if (!registry.get(partialHandle)?.cancelled) await teardownHeadlessInstance(partialHandle).catch(() => {});
    throw e;
  }
}

function assertNotShuttingDown() {
  if (shutdown) throw new Error("headless instance spawn interrupted by shutdown");
}

function assertStartupOwned(handle) {
  const entry = registry.get(handle);
  if (!entry || entry.cancelled || shutdown) throw new Error("headless startup cancelled");
}

function resolveStartup(handle) {
  const entry = registry.get(handle);
  if (entry && !entry.startupResolved) {
    entry.startupResolved = true;
    entry.resolveStartupDone();
  }
}

async function captureFingerprint(pid, idToken, expectedExe) {
  return waitFor(() => procFingerprint(pid, idToken, expectedExe), { timeoutMs: 1000, intervalMs: 50, label: `owned process fingerprint ${pid}` });
}

function refreshChromiumFingerprint(recorded, idToken, pid) {
  const current = procRecord(pid);
  const changed = [];
  if (!recorded || !current) throw new Error(`chromium settled identity unavailable: ${JSON.stringify({ recorded, current })}`);
  if (current.pid !== recorded.pid) changed.push("pid");
  if (current.starttime !== recorded.starttime) changed.push("starttime");
  if (current.pgrp !== recorded.pgrp) changed.push("pgrp");
  if (current.session !== recorded.session) changed.push("session");
  if (!current.cmdline || !current.cmdline.includes(idToken)) changed.push("cmdline-token");
  const approvedExe = current.exe === recorded.exe || current.exe === CHROMIUM_CANONICAL_EXE;
  if (!approvedExe) changed.push("exe");
  if (changed.length) throw new Error(`chromium settled identity mismatch: ${JSON.stringify({ changed, recorded, current, approvedTransition: [recorded.exe, current.exe] })}`);
  return { ...recorded, ...current, expectedExe: "chromium" };
}

// Disabled by default. The dedicated race harness sets this explicit directory
// and releases each named gate after signalling the child externally.
async function phaseGate(name, handle) {
  const dir = process.env.HEADLESS_TEST_PHASE_DIR;
  if (!dir || process.env.HEADLESS_TEST_PHASE !== name) return;
  const fs = await import("node:fs/promises");
  await fs.mkdir(dir, { recursive: true });
  const phase = path.join(dir, `PHASE-${name}`);
  const release = path.join(dir, `RELEASE-${name}`);
  const entry = registry.get(handle);
  await fs.writeFile(phase, JSON.stringify({ pid: process.pid, id: handle.id, workDir: handle.workDir, runtimeDir: handle.runtimeDir,
    swayPid: handle.swayPid || null, chromiumPid: handle.chromiumPid || null,
    sway: entry?.sway || null, chromium: entry?.chromium || null }));
  await waitFor(() => fs.access(release).then(() => true, () => false), { timeoutMs: 30000, intervalMs: 25, label: `test phase release ${name}` });
}

/** Env vars to pass when spawning the MCP server subprocess for this instance. */
export function instanceEnv(handle) {
  return {
    AUTOMATION_BACKEND: "headless",
    XDG_RUNTIME_DIR: handle.runtimeDir,
    WAYLAND_DISPLAY: handle.waylandDisplay,
    HEADLESS_CHROMIUM_PID: String(handle.chromiumPid),
    // DIAGNOSTIC ONLY. The chromium PID above is frozen at spawn and nothing
    // re-resolves it; this lets the server ask THIS instance's compositor what
    // PID owns the window NOW, but only to explain a failed AT-SPI lookup. It
    // is deliberately the instance's own socket, never the ambient SWAYSOCK.
    HEADLESS_SWAYSOCK: handle.swaySock || "",
    // DIAGNOSTIC ONLY, read solely when an AT-SPI app lookup misses. Holds a
    // bounded, text-free record of how this instance's browser ended; it never
    // contains captured stderr, and it dies with workDir at teardown.
    HEADLESS_WORK_DIR: handle.workDir || "",
    // Bounded readiness flag, not an error string: "0" means the record was
    // never created, so the observer reports that fact rather than guessing
    // from an absent file.
    HEADLESS_EXIT_LOG_READY: handle.exitRecorderReady === true ? "1" : "0",
    HEADLESS_EXIT_LOG: handle.workDir ? path.join(handle.workDir, EXIT_LOG_BASENAME) : "",
    HEADLESS_WIDTH: String(handle.width),
    HEADLESS_HEIGHT: String(handle.height),
    HEADLESS_INITIAL_URL: handle.initialUrl || "about:blank",
  };
}

/** An immutable-enough identity for a process, captured at spawn.
 * PIDs are RECYCLED. `kill(pid, 0)` succeeding proves only that SOMETHING holds
 * that number now — after reuse it can be an unrelated process, and signalling
 * it would kill a stranger. starttime is monotonic per boot and never reused
 * with the same pid; cmdline carries this instance's own id; pgrp/session pin
 * the group we are allowed to address. */
function procFingerprint(pid, idToken, expectedExe = null) {
  if (!pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces and parentheses, so split after the LAST ')'.
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cmdline = readCmdline(pid);
    const exe = readExe(pid);
    const pgrp = Number(f[2]), session = Number(f[3]), starttime = f[19];
    if (!starttime || !Number.isInteger(pgrp) || pgrp <= 0 || !Number.isInteger(session) || session <= 0 || !cmdline || !exe) return null;
    if (idToken && !cmdline.includes(idToken)) return null;
    if (expectedExe && path.basename(exe) !== path.basename(expectedExe)) return null;
    return {
      pid,
      pgrp,                       // field 5
      session,                    // field 6
      starttime,                  // field 22 — monotonic per boot, never reused with the same pid
      idToken,                    // this instance's id, expected to appear in the command line
      cmdline,
      exe,
      expectedExe,
    };
  } catch { return null; }
}

function readCmdline(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); }
  catch { return ""; }
}

function readExe(pid) {
  try { return readlinkSync(`/proc/${pid}/exe`); } catch { return ""; }
}

/** Is the process still the EXACT one we recorded? Compared on starttime,
 * group, session and command line — not merely "a process with this pid is
 * alive", which is what the previous version checked while its comment claimed
 * ownership it had not established. */
function stillOwned(recorded) {
  return ownershipDiagnostic(recorded).owned;
}

function procRecord(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, pgrp: Number(f[2]), session: Number(f[3]), starttime: f[19], cmdline: readCmdline(pid), exe: readExe(pid) };
  } catch { return null; }
}

function ownershipDiagnostic(recorded) {
  if (!recorded) return { owned: false, reason: "no-recorded-fingerprint", recorded, current: null, changed: ["record"] };
  const current = procRecord(recorded.pid);
  if (!current) return { owned: false, reason: "process-missing", recorded, current: null, changed: ["process"] };
  const changed = [];
  if (current.starttime !== recorded.starttime) changed.push("starttime");
  if (current.pgrp !== recorded.pgrp) changed.push("pgrp");
  if (current.session !== recorded.session) changed.push("session");
  if (!current.cmdline || (recorded.idToken && !current.cmdline.includes(recorded.idToken))) changed.push("cmdline-token");
  if (!current.exe || current.exe !== recorded.exe) changed.push("exe");
  return { owned: changed.length === 0, reason: changed.length ? "identity-mismatch" : "owned", recorded, current, changed };
}

/** Test/debug evidence only: reports identity values for an owned handle and
 * never signals or returns a target beyond the handle's recorded PID. */
export function inspectProcessIdentity(handle, label) {
  const entry = registry.get(handle);
  if (!entry) return { error: "unknown-or-completed-handle" };
  const recorded = entry[label === "sway" ? "sway" : "chromium"];
  return ownershipDiagnostic(recorded);
}

function ownedGroupMembers(recorded) {
  if (!recorded?.pgrp || !recorded.session) return [];
  const members = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const m = procRecord(Number(name));
    if (!m || m.pgrp !== recorded.pgrp || m.session !== recorded.session) continue;
    // The leader's executable/cmdline marker is the ownership anchor. Child
    // processes may rewrite argv, but must remain in the exact validated
    // session/group; an unrelated process joining a reused PGID has no marker.
    if (m.pid === recorded.pid || m.cmdline.includes(recorded.idToken) || m.exe === recorded.exe) members.push(m);
  }
  return members;
}

/** Is the recorded process GROUP still present? */
function groupPresent(pgrp) {
  if (!pgrp) return false;
  try { process.kill(-pgrp, 0); return true; } catch { return false; }
}

/** Terminate the RECORDED process group. Validates ownership first, targets the
 * recorded PGID (not an assumption that the window pid leads the group), polls
 * the GROUP rather than just the leader — grandchildren can hold a group open
 * after its leader exits — and escalates to KILL only while still owned.
 * Returns a problem string, or null on success. */
async function endGroup(recorded, label) {
  if (!recorded) return null;
  if (!stillOwned(recorded)) {
    // Either already gone (fine) or the pid now belongs to someone else (must
    // NOT be signalled). Both mean: do not touch it.
    const diagnostic = ownershipDiagnostic(recorded);
    return groupPresent(recorded.pgrp) && diagnostic.current
      ? `${label}: refusing to signal (${diagnostic.reason}; changed=${diagnostic.changed.join(",")}; identity=${JSON.stringify(diagnostic)})`
      : null;
  }
  const pgrp = recorded.pgrp;
  if (!ownedGroupMembers(recorded).length) return `${label}: no owned members in validated process group — refusing to signal`;
  try { teardownStats.kills++; process.kill(-pgrp, "SIGTERM"); } catch { return null; }
  for (let i = 0; i < 15; i++) {                    // ~1.5s of grace
    await new Promise((r) => setTimeout(r, 100));
    if (!ownedGroupMembers(recorded).length) return groupPresent(pgrp)
      ? `${label}: group contains no verifiable owned members after SIGTERM`
      : null;
  }
  // The leader may have exited. Escalate only while verifiable members of the
  // exact prevalidated PGID/SID still remain; never require the leader itself.
  if (!ownedGroupMembers(recorded).length) return groupPresent(pgrp)
    ? `${label}: no verifiable owned members remain before SIGKILL`
    : null;
  try { teardownStats.kills++; process.kill(-pgrp, "SIGKILL"); } catch {}
  // A SIGKILL survivor is a D-state process the kernel reaps only when its blocking ioctl returns (a GPU/DRM call,
  // in the case that once wedged the host compositor). Poll to a hard timeout — long enough to recover the common
  // case, bounded so teardown can never hang. Only when it OUTLASTS the bound is the group truly wedged.
  if (await pollUntilGone(() => !ownedGroupMembers(recorded).length, { timeoutMs: WEDGE_TIMEOUT_MS, intervalMs: 250 })) {
    return groupPresent(pgrp) ? `${label}: unverified process remains in group after SIGKILL` : null;
  }
  return `${label}: process group ${pgrp} survived SIGKILL after ${WEDGE_TIMEOUT_MS}ms`;
}

/** Kill everything belonging to one instance and remove BOTH of its scratch
 * dirs. Safe to call repeatedly and from several paths at once: the first call
 * owns the work and every later caller awaits that same promise.
 *
 * A COMPLETED teardown is a hard no-op. Without that, a second sequential call
 * would rebuild the work from a handle that is no longer registered and signal
 * the old pids again — and if either has been RECYCLED, that kills a stranger.
 * "It did not throw" is not the same as "it did nothing", which is why the
 * regression counts kill attempts rather than watching for an exception. */
export async function teardownHeadlessInstance(handle) {
  const entry = registry.get(handle);
  if (!entry) return;                                 // already done, or never owned
  if (entry.closing) return entry.closing;            // join the work in flight
  // Startup checks this flag before every resource-creating phase. Keep the
  // registry entry until startup has observed cancellation and unwound.
  entry.cancelled = true;
  clearTimeout(entry.lifetimeTimer);

  const work = (async () => {
    const problems = [];
    // Startup owns all resource creation until this barrier resolves. Waiting
    // here prevents mkdir/copy/spawn continuations from racing directory rm or
    // registry deletion after a signal.
    await entry.startupDone;
    // Suite-owned restore hooks run FIRST, while the instance still exists, and
    // are awaited. A throwing hook is reported but must never prevent the
    // process/directory cleanup below.
    for (const hook of entry.hooks) {
      try { teardownStats.hooks++; await hook(); } catch (e) { problems.push(`cleanup hook failed: ${e?.message || e}`); }
    }
    // A process whose full /proc fingerprint was not captured is only ever
    // terminated through the ChildProcess handle during startup cancellation;
    // never synthesize a PGID and never signal a recycled PID by number.
    // the keyboard holder goes with the browser (before the compositor it is a client of)
    await stopKeyboardHolder(entry.keyboardHolder).catch(() => {});
    for (const [label, rec, child] of [["sway", entry.sway, entry.swayProc], ["chromium", entry.chromium, entry.chromiumProc]]) {
      if (!rec && child?.pid) {
        try { teardownStats.kills++; child.kill("SIGTERM"); } catch (e) { problems.push(`${label}: startup abort failed: ${e?.message || e}`); }
      }
    }
    for (const [label, rec] of [["chromium", entry.chromium], ["sway", entry.sway]]) {
      teardownStats.groups[label]++;
      try { const p = await endGroup(rec, label); if (p) problems.push(p); }
      catch (e) { problems.push(`${label}: ${e?.message || e}`); }
    }

    // Auxiliary services (at-spi2 registry, dconf, pulse) can still be shutting
    // down right after the kill, which occasionally makes the first rm fail on a
    // busy socket and leave an empty-but-undeleted directory behind. One retry
    // after a beat clears it — and then the ABSENCE IS VERIFIED, because a
    // swallowed rm failure would let teardown resolve successfully with the
    // directory still on disk.
    const removeVerified = async (name, dir) => {
      if (!dir) return;
      const fs = await import("node:fs/promises");
      const gone = async () => fs.access(dir).then(() => false, () => true);
      teardownStats.rms++; await rm(dir, { recursive: true, force: true }).catch(() => {});
      if (await gone()) return;
      await new Promise((r) => setTimeout(r, 500));
      teardownStats.rms++; await rm(dir, { recursive: true, force: true }).catch((e) => problems.push(`${name}: ${e?.message || e}`));
      if (!(await gone())) problems.push(`${name}: ${dir} still present after retry`);
    };
    // BOTH directories. Removing only the workDir leaves the runtimeDir behind
    // forever — measured: seven such half-cleaned instances accumulated before
    // anyone noticed, because the check only ever looked at /tmp.
    await removeVerified("runtimeDir", handle.runtimeDir);
    // Stop the exit recorder BEFORE the directory goes, so a late exit/close
    // event cannot recreate a file under a path that is about to be removed —
    // which would leave an orphaned directory behind after a verified removal.
    await stopExitRecorder(handle);
    await removeVerified("workDir", handle.workDir);
    if (problems.length) {
      const err = new Error(problems.join("; "));
      // A wedged process group (survived SIGKILL past the hard timeout) is a distinct, dangerous condition: it
      // usually means a device (GPU/DRM) is stuck, so the caller must STOP rather than spawn another instance on
      // top of it (that is what compounded a harvest teardown into a host-compositor crash). Flag it typed.
      if (problems.some((p) => /survived SIGKILL/.test(p))) err.wedged = true;
      throw err;
    }
  })();

  entry.closing = work;
  try {
    await work;
  } finally {
    // Deregister only once everything owned has settled — including the hooks.
    registry.delete(handle);
    if (handle.persistentProfileKey) activePersistentProfiles.delete(handle.profileDir);
    // Merely importing this module must not permanently change the process's
    // signal behaviour: once nothing is owned, the listeners come off again.
    if (registry.size === 0) removeSignalHandlers();
  }
}
