#!/usr/bin/env node
// Computer-use MCP server for Omarchy (Hyprland/Wayland).
//
// Drives the real desktop the same way a human would: screenshots via grim,
// mouse/keyboard via kernel-level uinput (ydotool) and the Wayland virtual
// keyboard protocol (wtype). No browser automation protocol (no CDP, no
// webdriver) is ever attached, so whatever browser window is on screen stays
// a completely ordinary browser session as far as any site is concerned.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isSubmitSafe, isOmniboxTarget, omniboxAutocompleteDeletion } from "./submit_safety.js";
import { observePageEpoch, postNavigationRefSwapEligible, refFromEarlierEpoch, sameControlIn } from "./ref_epoch.js";
import { shouldPasteUrlFirst, enterValue } from "./paste_first.js";
import { typingArgvPlan } from "./typing_plan.js";
import { classifyActivation, classifyCheckable, classifyToggle } from "./action_routing.js";
import { isPurchaseControl } from "./purchase_guard.mjs";
import { invalidatesToken, classifyRecoveryEligibility, resolvesNavigation, observationsAgree,
         contentSignature, shouldAttemptRecovery, REFUSAL_TEXT, CONTENT_ROLES,
         isRefEligible, isSiteMemoryEligible, isClickAuthorized, elementCapability,
         ineligibleHandleLabel } from "./navigation_recovery.js";
import { classifyBridgeResult, classifyDocumentState, classifyTargetState, classifyDismissOutcome,
         DISMISS_REFUSAL_TEXT, classifyEscapeTarget, escapeObservationsAgree,
         classifyEscapeOutcome, ESCAPE_REFUSAL_TEXT } from "./dialog_dismissal.js";
import { diffTargetStates, TargetRemovalTracker, TARGET_REMOVED_SIGNAL,
         urlObservedUnchanged, urlObservedChanged, dialogsObservedChanged, focusObservedChanged,
         hasUsableDocGen } from "./transition_signals.js";
import { navigationReady, navigationReadyGuidance, cleanHrefReached, cleanHrefDirectEligible, productLinkCandidates, productShapedPath, storefrontRootPath, mergeReadinessElements, shouldRunLinkScan, shouldResubmitNavigation, shouldFallbackToSemanticLink, transientBrowserNavigationError, canonicalSearchRewriteReady } from "./navigation_ready.js";
import { searchPatternFromObservedUrl, searchRouteLearningQuery } from "./search_route_discovery.mjs";
import { sanitizeInline, formatPageUrlMarker } from "./text_serialization.js";
import { soleChromiumWindowPid } from "./sway_tree.js";
import { enforceSingleWindow } from "./window_guard.mjs";
import { validateExitRecord, formatExitDiagnostic, EXIT_LOG_BASENAME, MAX_EXIT_LOG_BYTES } from "./chromium_exit.js";
import * as fsp from "node:fs/promises";
import { classifyVisualOverlayRecovery } from "./visual_overlay_recovery.js";
import { diffDisclosureSignals } from "./disclosure_transition.js";
import { pasteValue } from "./clipboard.js";
import { SubmitTokenStore, canArmSubmitToken, isPlainReturn, observeSubmitTransition,
         formatSubmitTransitionNote, needsSubmitBaseline,
         formatSubmitTransitionDiagnostic } from "./submit_transition.js";
import { isUnrememberableName, scrubPrivateLocators } from "./site_memory_privacy.mjs";
import { loadPlugins } from "./plugin_loader.mjs";
import { createHeadlessPointer } from "./headless_pointer_client.mjs";
import { createHeadlessKeyboard, helperSentNothing, sendWithFallback } from "./headless_keyboard_client.mjs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink, readdir, stat, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

// MCP clients often launch stdio servers with a stripped-down "safe" env
// (no WAYLAND_DISPLAY / XDG_RUNTIME_DIR / HYPRLAND_INSTANCE_SIGNATURE), and
// HYPRLAND_INSTANCE_SIGNATURE changes every login anyway, so it can't just be
// hardcoded into the MCP server config. Auto-discover the live compositor
// socket instead, so this works regardless of how the process was launched
// and survives reboots/relogins without reconfiguration.
// AUTOMATION_BACKEND selects which desktop this server drives:
// - "hyprland" (default): the real interactive session, via hyprctl + ydotool.
// - "headless": an isolated, off-screen sway instance spawned by
//   headless_instance.mjs for parallel automation runs that must not share
//   input/screen with the real session or each other. Skips all hyprctl
//   window-management (meaningless there — there's exactly one fullscreen
//   window) and swaps ydotool (kernel uinput, real hardware, one per
//   machine) for wlrctl (Wayland-protocol-scoped to $WAYLAND_DISPLAY, so
//   many can coexist). See moveMouseRaw/clickButton/resolveWindow below.
const AUTOMATION_BACKEND = process.env.AUTOMATION_BACKEND === "headless" ? "headless" : "hyprland";

async function discoverCompositorEnv() {
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;

  if (!process.env.WAYLAND_DISPLAY) {
    const entries = await readdir(xdgRuntimeDir).catch(() => []);
    const socket = entries.find((f) => /^wayland-\d+$/.test(f));
    if (socket) process.env.WAYLAND_DISPLAY = socket;
  }

  // Headless instances have no Hyprland signature at all (they're plain
  // sway) and must never accidentally inherit/guess the real session's —
  // that would let a "headless" instance issue hyprctl commands against the
  // real desktop, exactly the collision this mode exists to prevent.
  if (AUTOMATION_BACKEND !== "headless" && !process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    const hyprDir = path.join(xdgRuntimeDir, "hypr");
    const entries = await readdir(hyprDir).catch(() => []);
    let newest = null;
    for (const name of entries) {
      const full = path.join(hyprDir, name);
      const st = await stat(full).catch(() => null);
      if (st?.isDirectory() && (!newest || st.mtimeMs > newest.mtimeMs)) {
        newest = { name, mtimeMs: st.mtimeMs };
      }
    }
    if (newest) process.env.HYPRLAND_INSTANCE_SIGNATURE = newest.name;
  }

  process.env.XDG_RUNTIME_DIR = xdgRuntimeDir;
}

await discoverCompositorEnv();

// A HELPER ACTION THAT FAILED falls back to wtype ONLY when it certainly sent nothing (helperSentNothing); one that may already have
// sent its key or text is logged and NOT sent again — the caller's own check (the navigation's commit, the read-back, the re-verify
// after Delete) judges what landed (lead review of 0abbbc8: a re-send would double a Return or a Delete).
function keyFallbackAllowed(error, what) {
  if (helperSentNothing(error)) { console.error(`[headless] keyboard ${what} fell back to wtype (${error?.code || error?.name || "error"})`); return true; }
  console.error(`[headless] keyboard ${what} failed after it may have been sent (${error?.code || "error"}: ${String(error?.message || "").slice(0, 40)}); NOT re-sent`);
  return false;
}
// Text typing: attempt 1 is the ORDINARY single wtype invocation that shipped
// before (the reliable path for ordinary fields — the segmented plan broke the
// a login e-mail field when used first). The segmented, sacrificial-key
// plan (typing_plan.js) runs ONLY as the bounded retry after exact read-back
// failed, which is the one shape the local reproduction proved needs it. Delay
// per key stays the caller's choice (25 fast paths, 80 recovery paths).
async function typeWithWtype(value, delayMs, { attempt = 1 } = {}) {
  // Headless: the persistent virtual keyboard, which types every character on its real US key. wtype
  // numbers its keycodes from evdev 1 (KEY_ESC), so Chromium reported the first character as
  // code "Escape" — live Target 2026-09-26: its sign-in sheet closed on the first password keystroke.
  if (AUTOMATION_BACKEND === "headless" && (await headlessKeyboard.available())) {
    try { await headlessKeyboard.type(value); return; }
    catch (error) { if (!keyFallbackAllowed(error, "type")) return; }
  }
  for (const args of typingArgvPlan(value, { attempt, delayMs })) await run("wtype", args);
}

// Ctrl+<letter> (A: select the field's text before replacing it; L: focus the address bar), on the same
// keyboard as typing, so the letter rides its real key.
async function ctrlKey(letter) {
  if (AUTOMATION_BACKEND === "headless" && (await headlessKeyboard.available())) {
    try { await headlessKeyboard.key(letter, ["ctrl"]); return; }
    catch (error) { if (!keyFallbackAllowed(error, `ctrl+${letter}`)) return; }
  }
  await run("wtype", ["-s", "100", "-M", "ctrl", "-k", letter, "-m", "ctrl"]);
}
const selectAllKeys = () => ctrlKey("a");
// Browser processes whose omnibox has had its second grab_focus (type_into_element: the first never takes keyboard focus).
const omniboxFocusedOnce = new Set();
// Toggles left pressed because they already were (see the toggle branch): pid:role:name -> when.
const keptPressed = new Map();

// A link into the store's cart or checkout ("Checkout", "View cart", /cart, /checkouts/…) is CLICKED on the page,
// as a person does — never re-typed into the address bar. Typing it skipped the store's own click handling and
// showed an agent pasting a 225-character checkout URL (live Owala/Gymshark 2026-09-26). The link's own AT-SPI
// activation below is the click; its navigation is verified the same way.
export function isCheckoutLink(el) {
  const name = String(el?.name || "");
  let pathname = "";
  try { pathname = new URL(/^https?:/.test(el?.href || "") ? el.href : `https://${el?.href || ""}`).pathname; } catch { /* no path */ }
  return /\/(?:cart|carts|checkout|checkouts|bag|basket|shopping-?bag)(?:\/|$)/i.test(pathname)
    || /\b(?:check ?out|checkout|view (?:my )?(?:cart|bag)|go to (?:cart|bag)|continue to checkout|proceed to checkout)\b/i.test(name);
}

/** PURE. A checkout STEP button whose effect can take seconds to show (live Sephora 2026-09-27: "Checkout" opens
 * its sign-in sheet ~5 s later, "Check Out as a Guest" navigates ~5.5 s later; at 2 s both read as UNVERIFIED and
 * the agent re-read and re-pressed them). Never an order-placing button. */
export function isCheckoutStepButton(el) {
  const name = String(el?.name || "");
  if (!/^(?:button|push button)$/.test(String(el?.role || ""))) return false;
  if (/\b(?:place (?:my )?order|pay(?: now)?|submit order|complete (?:my )?(?:order|purchase)|buy now)\b/i.test(name)) return false;
  return /\b(?:check ?out|checkout|guest|continue(?: to [a-z ]+)?|use this address|save (?:and|&) continue|proceed|go to (?:billing|payment|shipping|delivery|review))\b/i.test(name);
}

async function run(cmd, args) {
  return execFileP(cmd, args, { env: process.env });
}

// --- ydotool's virtual absolute-pointer device does not necessarily use a
// 1:1 pixel range (observed 2x on this machine). Calibrate once, lazily, by
// nudging the cursor to a small known input value and reading back the real
// position via hyprctl, then derive the scale factor. Falls back to 1:1 if
// calibration ever fails.
let cursorScale = null;

async function getCursorPos() {
  const { stdout } = await run("hyprctl", ["cursorpos"]);
  const [x, y] = stdout.trim().split(",").map((s) => parseInt(s.trim(), 10));
  return { x, y };
}

async function calibrateCursorScale() {
  if (cursorScale) return cursorScale;
  try {
    const before = await getCursorPos();
    const probe = 100;
    await run("ydotool", ["mousemove", "-a", "-x", String(probe), "-y", String(probe)]);
    await new Promise((r) => setTimeout(r, 120));
    const after = await getCursorPos();
    const sx = after.x / probe;
    const sy = after.y / probe;
    cursorScale = {
      x: sx > 0.01 ? sx : 1,
      y: sy > 0.01 ? sy : 1,
    };
    // Restore roughly where the cursor was so calibration is unobtrusive.
    await moveMouseRaw(before.x, before.y);
  } catch {
    cursorScale = { x: 1, y: 1 };
  }
  return cursorScale;
}

// wlrctl's pointer is relative-only (wlr-virtual-pointer-unstable-v1 has no
// absolute-positioning request, by protocol design — it mirrors physical
// mouse semantics). Snap to the output's (0,0) corner with an
// intentionally-oversized negative move (the compositor clamps it there),
// then move by the exact target delta. Self-contained and correct
// regardless of where the cursor was before — no position tracking needed.
async function moveMouseHeadless(screenX, screenY) {
  if (await headlessPointer.available()) { await headlessPointer.move(Math.round(screenX), Math.round(screenY)); return; }
  await run("wlrctl", ["pointer", "move", "-100000", "-100000"]);
  await run("wlrctl", ["pointer", "move", String(Math.round(screenX)), String(Math.round(screenY))]);
}

// THE PERSISTENT VIRTUAL POINTER (measured 2026-09-03, headless_pointer.c): a headless
// instance's seat has no input devices, so every one-shot `wlrctl pointer …` creates a
// device, acts, and removes it — the surface's pointer focus goes with it and the next
// one-shot click presses a button with no focused surface: NO DOM pointer event ever
// reaches the page (a document-level capture listener counted zero; keys through wtype
// work because they happen inside one process lifetime). One helper per server process
// holds the pointer for the instance's life; move/click/scroll go through it. Without
// the built helper (build/headless_pointer, HEADLESS_POINTER_BIN) the one-shot path
// stays, announced once on stderr.
const headlessPointer = createHeadlessPointer({ env: process.env, log: (line) => console.error(`[headless] ${line}`) });
process.once("exit", () => { try { headlessPointer.close(); } catch { /* gone */ } });

// THE PERSISTENT VIRTUAL KEYBOARD (measured 2026-09-03 on Target, headless_keyboard.c): wtype types by
// creating a NEW virtual keyboard per call — upload a keymap, press a key, destroy the device. A
// React-controlled search box keeps only the LAST device's keystroke, so 13 per-character type_text calls
// (a human at 150 ms/key) leave one letter. One helper per server process holds ONE virtual keyboard for the
// instance's life, swapping only its keymap as new characters appear; every keystroke lands on the same seat
// keyboard the page is bound to. Without the built helper (build/headless_keyboard, HEADLESS_KEYBOARD_BIN) —
// or on a compositor without zwp_virtual_keyboard_manager_v1 — the wtype path stays, announced once on stderr.
const headlessKeyboard = createHeadlessKeyboard({ env: process.env, log: (line) => console.error(`[headless] ${line}`) });
process.once("exit", () => { try { headlessKeyboard.close(); } catch { /* gone */ } });

// TEST-ONLY input instrumentation, gated behind an explicit env var so it
// adds NO model-facing tool surface and NO counter work in ordinary runs.
// When COMPUTER_USE_TEST_INPUT_STATS=1 (set by the input-proof tests in their
// MCP server subprocess env), moveMouseRaw/clickButton bump these counts and a
// read-only get_input_stats tool is registered — letting a test
// DETERMINISTICALLY prove a code path performed no pointer input (a JS onclick
// counter can't: a synthetic click in the headless compositor raises no DOM
// mouse event here, measured).
const INPUT_STATS_ENABLED = process.env.COMPUTER_USE_TEST_INPUT_STATS === "1";
// `escapes` counts Escape keypresses sent by the navigation-focus transaction,
// so a test can prove EXACTLY how many were sent — zero on the paths that must
// never send one (an Escape could dismiss a real page modal).
// `nativeActions` counts AT-SPI actions this harness invoked, so a test can
// prove a refusal path performed ZERO of them and an acting path exactly one.
const inputStats = { moves: 0, clicks: 0, escapes: 0, nativeActions: 0 };

async function moveMouseRaw(screenX, screenY) {
  if (INPUT_STATS_ENABLED) inputStats.moves++;
  if (AUTOMATION_BACKEND === "headless") return moveMouseHeadless(screenX, screenY);
  const scale = await calibrateCursorScale();
  const ix = Math.round(screenX / scale.x);
  const iy = Math.round(screenY / scale.y);
  await run("ydotool", ["mousemove", "-a", "-x", String(ix), "-y", String(iy)]);
}

const BUTTON_CODES = {
  left: "0xC0",
  right: "0xC1",
  middle: "0xC2",
};

async function clickButton(button, clicks) {
  if (INPUT_STATS_ENABLED) inputStats.clicks++;
  if (AUTOMATION_BACKEND === "headless") {
    const name = button === "left" || button === "right" || button === "middle" ? button : "left";
    if (await headlessPointer.available()) { await headlessPointer.click(name, Math.min(3, Math.max(1, clicks))); return; }
    for (let i = 0; i < Math.max(1, clicks); i++) {
      await run("wlrctl", ["pointer", "click", name]);
      if (i < clicks - 1) await new Promise((r) => setTimeout(r, 80));
    }
    return;
  }
  const code = BUTTON_CODES[button] ?? BUTTON_CODES.left;
  const args = ["click"];
  if (clicks > 1) {
    args.push("-r", String(clicks), "-D", "80");
  }
  args.push(code);
  await run("ydotool", args);
}

// One button press OR release, for a real-time hold (manual/takeover connections: pointer_button). The headless
// helper holds the button between the two calls; the desktop uses ydotool's down (0x40|code) / up (0x80|code) flags.
// The one-shot wlrctl path cannot hold a button (its device goes away), so it refuses rather than faking a click.
const BUTTON_INDEX = { left: 0, right: 1, middle: 2 };
async function pointerButtonRaw(button, action) {
  const name = Object.hasOwn(BUTTON_INDEX, button) ? button : "left";
  if (INPUT_STATS_ENABLED && action === "press") inputStats.clicks++;
  if (AUTOMATION_BACKEND === "headless") {
    if (!(await headlessPointer.available())) throw Object.assign(new Error("hold_unsupported: the headless pointer helper is not available"), { code: "hold_unsupported" });
    await (action === "press" ? headlessPointer.press(name) : headlessPointer.release(name));
    return;
  }
  const flag = action === "press" ? 0x40 : 0x80;
  await run("ydotool", ["click", `0x${(flag | BUTTON_INDEX[name]).toString(16).toUpperCase()}`]);
}

async function screenshotToBase64(region) {
  const file = path.join(os.tmpdir(), `computer-use-${randomUUID()}.png`);
  const args = ["-t", "png"];
  // A zoomed-out demo browser (COMPUTER_USE_VISIBLE_SCALE < 1) is drawn at fewer pixels than its layout units:
  // capture at layout size so an image pixel is a click coordinate, as everywhere else.
  const visibleScale = Number(process.env.COMPUTER_USE_VISIBLE_SCALE);
  if (visibleScale > 0 && visibleScale !== 1) args.push("-s", String(1 / visibleScale));
  if (region) {
    args.push("-g", `${region.x},${region.y} ${region.width}x${region.height}`);
  }
  args.push(file);
  await run("grim", args);
  try {
    const buf = await readFile(file);
    return buf.toString("base64");
  } finally {
    await unlink(file).catch(() => {});
  }
}

export function validCaptureRegion(region) {
  return !region || (Number.isInteger(region.x) && Number.isInteger(region.y) &&
    Number.isInteger(region.width) && region.width > 0 &&
    Number.isInteger(region.height) && region.height > 0);
}

// Screenshot crops use image-local coordinates while pointer tools use the
// compositor's absolute screen coordinates. Keep this conversion explicit and
// pure so callers cannot accidentally pass a crop-local point to click/move.
export function screenshotPointToScreen(region, x, y) {
  if (!validCaptureRegion(region) || !Number.isInteger(x) || !Number.isInteger(y)) throw new TypeError("invalid screenshot point");
  if (region && (x < 0 || y < 0 || x >= region.width || y >= region.height)) throw new RangeError("screenshot point is outside captured region");
  return { x: (region?.x || 0) + x, y: (region?.y || 0) + y };
}

export function focusedPageEditableMatches(target, focused) {
  if (!target || !focused || focused.editable !== true || focused.doc_class !== "page") return false;
  if (target.obj_path && focused.obj_path) return target.obj_path === focused.obj_path;
  return target.role === focused.role && target.name === focused.name;
}

// rev 27b.1: the coordinate fallback is judged on the PRE-FOCUS identity and
// the caller's intent, never on a live handle that focusing may have
// destroyed. Live 2026-09-03 (test_focus_recovery case2d/case12): a
// focus-expanding combo box UNMOUNTS on grab_focus, the live element reads
// back as role "invalid"/no name, the combo exemption no longer matched, and
// the fallback clicked the dead trigger's old coordinates — the exact hazard
// the comment above the primary call site describes. `priorRole` is the role
// the caller resolved BEFORE focusing (origSig); `recovery` is the caller's
// focus-recovery intent (a combo-box target). An invalidated live target has
// no trustworthy coordinates at all.
const COMBO_ROLES = new Set(["combo box", "combobox"]);
export function plainEditableFocusDecision(target, focused, { fallbackUsed = false, omnibox = false, priorRole = null, recovery = false } = {}) {
  const liveRole = String(target?.role || "").toLowerCase();
  const invalidated = liveRole === "invalid" || !target?.name;
  if (COMBO_ROLES.has(liveRole) || COMBO_ROLES.has(String(priorRole || "").toLowerCase()) || recovery || invalidated || omnibox || target?.capability === "omnibox") return { allow: true, fallback: false };
  if (focusedPageEditableMatches(target, focused)) return { allow: true, fallback: false };
  if (fallbackUsed) return { allow: false, fallback: false };
  return { allow: false, fallback: true };
}

let latestScreenshotContext = null;

// Headless instances have exactly one window (the browser, always fullscreen
// on the instance's own virtual output) and no window manager worth talking
// to — so every window-management function below returns a small synthetic
// stand-in instead of shelling out to hyprctl (which isn't even running
// there). This is deliberately shaped like a real hyprctl client entry so
// fast_agent.mjs's window pre-resolution logic (list_windows -> find the
// chromium entry -> ...) works completely unchanged against either backend.
function headlessWindowStub() {
  const pid = parseInt(process.env.HEADLESS_CHROMIUM_PID || "0", 10);
  const width = parseInt(process.env.HEADLESS_WIDTH || "1920", 10);
  const height = parseInt(process.env.HEADLESS_HEIGHT || "1080", 10);
  return { address: "headless", class: "chromium", title: "", pid, workspace: "1", at: [0, 0], size: [width, height], focused: true };
}

async function listWindows() {
  if (AUTOMATION_BACKEND === "headless") return [headlessWindowStub()];
  const { stdout } = await run("hyprctl", ["clients", "-j"]);
  const clients = JSON.parse(stdout);
  return clients.map((c) => ({
    address: c.address,
    class: c.class,
    title: c.title,
    pid: c.pid,
    workspace: c.workspace?.name,
    at: c.at,
    size: c.size,
    focused: c.focusHistoryID === 0,
  }));
}

async function focusWindowByAddress(address) {
  if (AUTOMATION_BACKEND === "headless") return; // only one window; always focused
  const lua = `return hl.dispatch(hl.dsp.focus({ window = "address:${address}" }))`;
  await run("hyprctl", ["repl", lua]);
}

async function getActiveWorkspaceId() {
  if (AUTOMATION_BACKEND === "headless") return 1; // not a meaningful concept here
  const { stdout } = await run("hyprctl", ["-j", "activeworkspace"]);
  return JSON.parse(stdout).id;
}

// Focuses the window, then moves it to the target workspace with the view
// following along — i.e. both "put this window over there" and "switch to
// looking at it" in one step. Used to isolate the automation browser on its
// own workspace, and to move it (and the view) back afterward.
async function moveWindowToWorkspace(address, workspace) {
  if (AUTOMATION_BACKEND === "headless") return; // nothing to move; already isolated by construction
  await focusWindowByAddress(address);
  const lua = `return hl.dispatch(hl.dsp.window.move({ workspace = "${workspace}", follow = true }))`;
  await run("hyprctl", ["repl", lua]);
}

async function getActiveWindow() {
  if (AUTOMATION_BACKEND === "headless") return headlessWindowStub();
  const { stdout } = await run("hyprctl", ["activewindow", "-j"]);
  const c = JSON.parse(stdout);
  return {
    address: c.address,
    class: c.class,
    title: c.title,
    pid: c.pid,
    at: c.at,
    size: c.size,
  };
}

// --- AT-SPI structured perception -----------------------------------------
// This is the actual efficiency win: instead of a screenshot + vision pass
// for every step, ask the Linux accessibility tree (the same API screen
// readers use) directly for every interactive element's role, name, and
// exact screen coordinates. It's cheap (a few KB of JSON, not an image) and
// exact (no coordinate guessing from pixels): the same information assistive
// technology relies on. Screenshots stay available as a fallback for canvas
// and images.

// The accessibility tree uses AT-SPI role names AS THIS at-spi2-core
// REPORTS THEM — verified against Atspi.role_get_name() on 2.60.6
// (2026-08-28): buttons are "button" (upstream renamed "push button" →
// "button" in atk 2.46), tabs are "page tab", text fields are "entry" not
// "textbox". The original vocabulary here said "push button", which NEVER
// matched on this system — every button on every page was invisible to
// read_page and unfindable by click_element/wait_for_element, and
// validateRole actively steered callers AWAY from the name that worked.
// If roles ever look wrong again, verify against role_get_name() directly,
// not docs. Passing a wrong-but-plausible role silently matches nothing,
// which is cheap for read_page but catastrophically expensive for
// wait_for_element (polls the full timeout for a role that can never
// appear). Fail fast with a suggestion instead.
const KNOWN_ROLES = new Set([
  "button", "toggle button", "link", "entry", "password text", "combo box",
  "check box", "radio button", "menu item", "check menu item", "radio menu item",
  "page tab", "slider", "spin button", "heading", "image", "static", "paragraph",
  "section", "list item", "frame", "panel", "document web", "document frame",
  "table", "table cell", "row header", "column header", "list", "menu",
  "tool bar", "dialog", "alert", "separator", "scroll bar", "notification",
  "landmark", "article", "label",
]);
// Legacy/older-at-spi names, silently accepted and mapped to what this
// system actually reports (old site-memory files and habits still say
// "push button").
const ROLE_ALIASES = {
  "push button": "button",
  tab: "page tab",
};
const ROLE_SUGGESTIONS = {
  btn: "button", textbox: "entry", "text box": "entry",
  input: "entry", text: "entry", field: "entry", select: "combo box",
  dropdown: "combo box", checkbox: "check box", radio: "radio button",
  anchor: "link", a: "link", img: "image", h1: "heading", h2: "heading",
  div: "panel", span: "static", li: "list item", modal: "dialog", popup: "dialog",
};

function normalizeRole(role) {
  if (!role) return role;
  return ROLE_ALIASES[role] || role;
}

function validateRole(role) {
  if (!role) return null;
  // several roles in one read ("entry|combo box|button"): each must be a role the tree reports
  if (role.includes("|")) { for (const part of role.split("|").map((r) => r.trim()).filter(Boolean)) { const e = validateRole(part); if (e) return e; } return null; }
  if (KNOWN_ROLES.has(normalizeRole(role))) return null;
  const suggestion = ROLE_SUGGESTIONS[role.toLowerCase()];
  return (
    `"${role}" is not a role this accessibility tree reports.` +
    (suggestion ? ` Did you mean "${suggestion}"?` : "") +
    ` Common roles: button, link, entry, combo box, check box, radio button, heading, image, menu item, dialog.`
  );
}

// The one error shape this enrichment answers to, matched EXACTLY so no other
// bridge failure can trigger a compositor query.
const APP_NOT_FOUND = /^no AT-SPI application found for pid (\d+)$/;

/** Pure: turn the registry stats and the compositor's answer into ONE bounded
 * line of numbers. No application names, no window titles, no page-controlled
 * text of any kind — only pids and counts. It states what was observed and
 * draws no conclusion: it never says crashed, recovered, or closed. */
export function formatAppLostDiagnostic(expectedPid, registry, windowProbe) {
  const parts = [`expected_pid=${expectedPid}`];
  if (!windowProbe || windowProbe.available !== true) {
    parts.push(`current_window_pid=diagnostic-unavailable(${windowProbe?.reason || "not attempted"})`);
  } else if (windowProbe.state === "one") {
    parts.push(`current_window_pid=${windowProbe.pid}`, `window_pid_changed=${windowProbe.pid !== expectedPid}`);
  } else if (windowProbe.state === "absent") {
    parts.push("current_window_pid=absent (the compositor reports no chromium window)");
  } else {
    parts.push(`current_window_pid=ambiguous(${windowProbe.count} chromium windows)`);
  }
  if (registry && typeof registry === "object") {
    const pids = Array.isArray(registry.chromium_like_pids) ? registry.chromium_like_pids.join(",") : "";
    parts.push(
      `target_pid_alive=${registry.target_pid_alive}`,
      `desktop_child_count=${registry.desktop_child_count}`,
      `readable_pid_count=${registry.readable_pid_count}`,
      `pid_probe_error_count=${registry.pid_probe_error_count}`,
      `chromium_like_app_pids=[${pids}]`,
    );
  }
  return `[app-lookup diagnostic: ${parts.join(" ")}]`;
}

/** Ask THIS instance's compositor which pid owns the chromium window now.
 * Diagnostic only: it never mutates the frozen pid, never retries the bridge
 * call and never clears refs. Any failure is reported as unavailable rather
 * than guessed at. */
/** Pure gate: does THIS bridge result warrant a compositor query? Returns the
 * expected pid, or null. Exact match on the one error shape, and headless only
 * — every other failure, every success, and every hyprland call must never
 * reach the compositor. */
export function appLostPid(result, backend) {
  if (backend !== "headless") return null;
  if (typeof result?.error !== "string") return null;
  const match = APP_NOT_FOUND.exec(result.error);
  return match ? Number(match[1]) : null;
}

export async function probeCurrentWindowPid(deps = {}) {
  const swaysock = deps.swaysock ?? process.env.HEADLESS_SWAYSOCK;
  if (!swaysock) return { available: false, reason: "no HEADLESS_SWAYSOCK" };
  const query = deps.querySwayTree || (async (sock) =>
    (await execFileP("swaymsg", ["-t", "get_tree"], { env: { ...process.env, SWAYSOCK: sock } })).stdout);
  let tree;
  try {
    tree = JSON.parse(await query(swaysock));
  } catch {
    return { available: false, reason: "sway query failed" };
  }
  return { available: true, ...soleChromiumWindowPid(tree) };
}

/** Read the instance's bounded exit record, if one exists. Diagnostics only,
 * and read ONLY when the app-not-found gate has already fired.
 *
 * Fails closed on every irregularity, because this file is consulted only when
 * something has already gone wrong and a malformed record must not become a
 * confident claim. The path is checked before it is opened (absolute, and the
 * exact expected basename), and the file is size-capped BEFORE parsing. */
export async function readChromiumExitRecord(deps = {}) {
  const logPath = deps.logPath ?? process.env.HEADLESS_EXIT_LOG;
  const workDir = deps.workDir ?? process.env.HEADLESS_WORK_DIR;
  if (!logPath) return { ok: false, reason: "no HEADLESS_EXIT_LOG" };
  // BOUND TO THE TRUSTED INSTANCE DIRECTORY. Absolute-plus-basename alone would
  // accept /anywhere/chromium-exit.json; the path must be exactly the file this
  // instance owns. path.resolve normalises, so traversal (".." segments) cannot
  // sneak past the comparison. Checked BEFORE any filesystem call.
  if (!workDir || !path.isAbsolute(workDir)) return { ok: false, reason: "no HEADLESS_WORK_DIR" };
  // The recorder reports whether its first write actually succeeded. "Never
  // created" and "created then lost" are different facts, and only the second
  // would justify wondering what removed it — so say which one it is, from a
  // bounded flag rather than an error string or a path.
  const ready = deps.ready ?? process.env.HEADLESS_EXIT_LOG_READY;
  if (ready === "0") return { ok: false, reason: "exit record was never created" };
  if (path.resolve(logPath) !== path.join(path.resolve(workDir), EXIT_LOG_BASENAME)) {
    return { ok: false, reason: "unexpected exit-log path" };
  }
  const stat = deps.stat || ((p) => fsp.stat(p));
  const readFile = deps.readFile || ((p) => fsp.readFile(p, "utf8"));
  let size;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return { ok: false, reason: "no exit record" };
  }
  if (!(size <= MAX_EXIT_LOG_BYTES)) return { ok: false, reason: "exit record too large" };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(logPath));
  } catch {
    return { ok: false, reason: "unreadable exit record" };
  }
  return validateExitRecord(parsed);
}

/** Is that pid held right now? Deliberately weak and reported as its own field:
 * pids are recycled, and the SPAWNED LEADER is not necessarily the process that
 * owns the window, so a live leader is never evidence of a healthy browser. */
export function probeLeaderAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === "ESRCH") return false;
    if (e && e.code === "EPERM") return true;
    return null;
  }
}

async function atspiBridge(cmd) {
  // CU_BRIDGE_TIMING=1: one stderr line per bridge call (action + ms), for measuring a tool's cost. Off by default.
  const timingStart = process.env.CU_BRIDGE_TIMING ? Date.now() : 0;
  try { return await atspiBridgeCall(cmd); }
  finally { if (timingStart) console.error(`[bridge] ${cmd?.action || "snapshot"} ${Date.now() - timingStart}ms`); }
}

async function atspiBridgeCall(cmd) {
  const scriptPath = path.join(import.meta.dirname, "atspi_bridge.py");
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn("python3", [scriptPath], { env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`atspi_bridge.py exited ${code}: ${err}`));
      else resolve(out);
    });
    child.stdin.write(JSON.stringify(cmd));
    child.stdin.end();
  });
  const result = JSON.parse(stdout);
  // CENTRALISED so every caller agrees — read_page, click_element, the
  // transition probes. Triggers ONLY on the exact app-not-found error and only
  // on the headless backend, so no other failure and no hyprland call ever
  // reaches the compositor. At most one compositor query per bridge call.
  return enrichBridgeResult(result, AUTOMATION_BACKEND);
}

/** The whole diagnostic side-path, with its dependencies injectable so the
 * "how many times is anything read" question is answered by counting rather
 * than by reading the source. Returns the result unchanged unless the exact
 * app-not-found gate fires on the headless backend. */
export async function enrichBridgeResult(result, backend, deps = {}) {
  const lostPid = appLostPid(result, backend);
  if (lostPid === null) return result;
  const probeWindow = deps.probeCurrentWindowPid || probeCurrentWindowPid;
  const readExit = deps.readChromiumExitRecord || readChromiumExitRecord;
  const probeAlive = deps.probeLeaderAlive || probeLeaderAlive;
  const probe = await probeWindow();
  const exitRecord = await readExit();
  const leaderAlive = exitRecord?.ok ? probeAlive(exitRecord.record.leader_pid) : null;
  result.error = `${result.error} ${formatAppLostDiagnostic(lostPid, result.app_lookup, probe)}`
    + ` ${formatExitDiagnostic(exitRecord, leaderAlive)}`;
  return result;
}

async function resolveWindow(windowAddress) {
  if (windowAddress) {
    const win = (await listWindows()).find((w) => w.address === windowAddress);
    if (!win) throw new Error(`No window with address ${windowAddress}`);
    return win;
  }
  return getActiveWindow();
}

// Cache of elements seen so far this page view, keyed by pid, so click/type
// by ref can skip re-querying AT-SPI entirely. Refs must stay valid across
// multiple read_page/click_element calls within the same turn (a model often
// issues several ref-based actions from one earlier read_page batch), so this
// merges new snapshots in rather than replacing the map — and mints globally
// unique refs per window, since the bridge script numbers "e1,e2,..." fresh
// on every single invocation and those would otherwise collide across calls.
// COMPUTER_USE_LINK_CLICKS=activate: click_element ACTIVATES a link (the page's own click, with its referrer and
// same-site request) instead of typing its href into the address bar. The search benchmark's find step uses it:
// Best Buy answered a typed product address from its results page with a browser error page (2026-09-27) — a
// shopper clicks the result.
// The close control of a pop-up that covers a control the model wants ("Close Dialog", "Close", "×", "No thanks").
const COVER_CLOSE_NAME = /^(?:close(?: (?:dialog|modal|popup|pop-up|window|this dialog|overlay))?|dismiss|no,? thanks?|no thank you|×|x|cerrar)$/i;
const LINK_CLICKS_ACTIVATE = process.env.COMPUTER_USE_LINK_CLICKS === "activate";
const snapshotCache = new Map(); // pid -> Map(ref -> element)
const refCounters = new Map(); // pid -> next ref number
// NAVIGATION EPOCHS (ref_epoch.js): pid -> { seq, uri, at }. Every snapshot that
// carries the page URI observes it; a change since the last observation is an
// epoch, and refs minted by that snapshot are stamped { page_epoch, minted_at }
// so type_into_element can tell a ref found in the unsettled moment right after
// a page navigation from one found on a settled page.
const pageEpochs = new Map();

async function snapshotWindow(win, { includeText, textFilter, roleFilter, stateFilter, limit, pageInfo, dialogContents, looseRoles, startPath } = {}) {
  const result = await atspiBridge({
    pid: win.pid,
    offset_x: win.at[0],
    offset_y: win.at[1],
    include_text: !!includeText,
    text_filter: textFilter || null,
    role_filter: roleFilter || null,
    state_filter: stateFilter || null,
    limit: limit || 150,
    page_info: !!pageInfo,
    dialog_contents: !!dialogContents,
    loose_roles: !!looseRoles,
    ...(startPath ? { start_path: startPath } : {}),
  });
  if (result.error) throw new Error(result.error);
  return ingestSnapshot(win, result);
}

// What every snapshot does to the tool's state: page-epoch tracking and ref minting. Shared with the one-call
// transition probe (captureSignals) so that probe leaves exactly what a snapshot would.
function ingestSnapshot(win, result) {
  let map = snapshotCache.get(win.pid);
  if (!map) {
    map = new Map();
    snapshotCache.set(win.pid, map);
  }
  const epochRecord = observePageEpoch(pageEpochs, win.pid, result.page?.url).record;
  const stamp = epochRecord ? { page_epoch: epochRecord.seq, minted_at: Date.now() } : null;
  let next = assignRefs(result.elements, refCounters.get(win.pid) || 1, map, stamp);
  refCounters.set(win.pid, next);

  return result;
}

/** Mint actionable refs for eligible nodes and STRIP the bridge-supplied ref
 * from everything else, then record the eligible ones in the ref cache.
 *
 * Exported so the real path — clearing plus rendering — is provable by
 * execution: testing the label helper alone would not show that an ineligible
 * node actually loses its handle. */
export function assignRefs(elements, startAt = 1, map = null, stamp = null) {
  let next = startAt;
  for (const el of elements) {
    // A node inside the browser's own WebUI (the omnibox dropdown) is shown for
    // diagnosis but gets NO ref: a ref is an actionable handle, and offering one
    // would invite a caller to click browser UI believing it to be page content.
    if (!isRefEligible(el)) {
      // The BRIDGE pre-populates a `ref` field on every entry, so merely
      // skipping the assignment here would leave that one in place and hand the
      // caller an actionable-looking handle for browser UI. Clear it.
      delete el.ref;
      continue;
    }
    el.ref = `e${next++}`;
    if (stamp) Object.assign(el, stamp); // navigation-epoch provenance (ref_epoch.js)
    map?.set(el.ref, el);
  }
  return next;
}

export function formatElements(elements) {
  if (elements.length === 0) return "(no matching elements)";
  return elements
    .map((el) => {
      const extra = [];
      if (el.value !== undefined) extra.push(`value=${JSON.stringify(el.value)}`);
      if (el.states?.length) extra.push(el.states.join(","));
      // A modal covering the page is the single most useful thing to surface,
      // and the marker comes from the bridge's structural stamp rather than the
      // role text — an unnamed or unmapped dialog root still gets marked.
      if (el.dialog_root) extra.push("DIALOG-ROOT");
      else if (el.in_dialog) extra.push("in-dialog");
      const suffix = extra.length ? ` [${extra.join(" ")}]` : "";
      // name and href are PAGE-CONTROLLED: sanitizeInline keeps one element to
      // exactly one line so a crafted accessible name can never mint a fake
      // header or ref row for the line-oriented parsers downstream.
      const href = el.href ? ` -> ${sanitizeInline(el.href.replace(/^https?:\/\//, ""))}${el.off_site ? " [OFF-SITE REDIRECT]" : ""}` : "";
      // href_full keeps the query string (Gap-style ?pid= product ids) for the catalog harvester ONLY. It is a
      // SEPARATE marker after the "->" href so direct-navigation and the agent's " -> <href>" parse (which stops
      // at whitespace) are unaffected — they keep using the clean, query-free href.
      const hrefFull = el.href_full ? ` [full: ${sanitizeInline(el.href_full.replace(/^https?:\/\//, ""))}]` : "";
      // An ineligible node is shown for diagnosis but carries NO ref — the
      // marker is deliberately not e-prefixed so it cannot be mistaken for, or
      // passed as, an actionable page ref. Browser UI and an UNVERIFIED surface
      // are labelled differently: the first is a known browser control, the
      // second means the surface could not be established at all, and calling
      // that "browser-ui" would assert something unproven.
      const handle = el.ref ?? ineligibleHandleLabel(el);

      return `${handle}\t${el.role}\t"${sanitizeInline(el.name)}"\t@${el.cx},${el.cy}${suffix}${href}${hrefFull}`;
    })
    .join("\n");
}

// AT-SPI's own scroll-into-view action (bypasses simulated wheel/keyboard
// scrolling entirely — far more reliable than trying to guess whether a page
// will respond to Page_Down or a wheel event, which several real sites
// silently ignore for parts of the page, e.g. pinned image galleries).
//
// Scrolls to the target AND reads back its authoritative post-scroll bounds
// in ONE atspi_bridge.py invocation, holding the SAME live AT-SPI object
// handle across the settle wait (done in-process, in Python — see
// scroll_to_action). This used to be two separate calls: scroll, wait,
// then a brand new tree search by text+role to get fresh coordinates —
// which risked re-resolving to a DIFFERENT element than the one just
// scrolled to whenever duplicate markup shared the same name+role (a real,
// reproducible bug: a confirmed real product link's ref-based click landed
// on a hidden duplicate at different coordinates and never navigated).
// Object handles can't cross a process boundary, which is exactly why the
// old code re-searched — so the fix is to never leave the process at all.
async function resolveElement({ ref, text, role, win, focus = false }) {
  let targetText = text;
  let targetRole = role;
  let objPath = null; // ref identity (issue #5): D-Bus object path
  let docGen = null;  // ref identity: document generation token
  if (ref) {
    const cached = snapshotCache.get(win.pid)?.get(ref);
    if (!cached) {
      throw new Error(`ref "${ref}" not found in the last read_page snapshot for this window. Call read_page again.`);
    }
    objPath = cached.obj_path || null;
    docGen = cached.doc_gen || null;
    targetText = cached.name; // used only for a role/name SANITY check, never as identity
    targetRole = cached.role;
    // A ref MUST resolve by its stable object-path identity — never by a
    // name/coordinate search, which silently mis-targets duplicate controls
    // (issue #5). If this ref carries no object path (older snapshot, or the
    // app exposed none), fail CLOSED rather than degrade.
    if (!objPath) {
      throw new Error(`ref "${ref}" has no stable object-path identity (it may predate the latest read_page). Call read_page again and use a fresh ref.`);
    }
    // READ BEFORE THE PAGE CHANGED ADDRESS (live New Balance 2026-09-30): a size click changed the URL and re-rendered the
    // buy box; the "Add to bag" ref from the read before it was pressed, returned true, and nothing happened. Such a ref is
    // re-found as the SAME labelled control in the current page (exact role + name, exactly one) or refused as stale.
    if (refFromEarlierEpoch(cached, pageEpochs.get(win.pid))) {
      let fresh = null;
      try { fresh = sameControlIn((await snapshotWindow(win, { roleFilter: targetRole, textFilter: targetText, limit: 20 }))?.elements, { role: targetRole, name: targetText }); } catch { fresh = null; }
      if (!fresh) {
        throw new Error(`ref "${ref}" is stale — it was read before the page changed address (now ${pageEpochs.get(win.pid)?.uri || "another URL"}), and the current page has no single ${targetRole} named ${JSON.stringify(targetText)}. Call read_page again and use a fresh ref.`);
      }
      objPath = fresh.obj_path;
      docGen = fresh.doc_gen || null;
      process.stderr.write(`[ref] ${ref} was read before the page changed address; re-found the same ${targetRole} ${JSON.stringify(targetText)} in the current page\n`);
    }
  } else {
    if (!targetText) throw new Error("Provide either ref or text (this element has no accessible name — pass its ref from the MOST RECENT read_page).");
    const roleError = validateRole(targetRole);
    if (roleError) throw new Error(roleError);
  }

  let result = await atspiBridge({
    pid: win.pid,
    offset_x: win.at[0],
    offset_y: win.at[1],
    action: focus ? "focus" : "scroll_to",
    text_filter: targetText,
    role_filter: targetRole,
    ...(objPath ? { obj_path: objPath, doc_gen: docGen } : {}),
  });
  // A variant option redrawn by the page itself (live Owala 2026-09-26: picking "24oz" re-rendered the color
  // buttons, so the color click in the same turn hit a stale ref and cost a re-read). On the SAME document, a
  // toggle/radio option whose exact role and name now match exactly ONE fresh control is that control, as a
  // person sees the same labelled button redrawn. Duplicates, another document, or any other role still refuse.
  if (result.stale_ref && ref && result.status !== "stale_doc" && result.reason !== "stale_doc" && ["toggle button", "radio button"].includes(targetRole) && targetText) {
    try {
      const fresh = await snapshotWindow(win, { roleFilter: targetRole, textFilter: targetText, limit: 20 });
      const same = (fresh?.elements || []).filter((el) => el.role === targetRole && el.name === targetText && el.doc_class === "page" && el.obj_path);
      if (same.length === 1) {
        objPath = same[0].obj_path;
        docGen = same[0].doc_gen || null;
        result = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: focus ? "focus" : "scroll_to", text_filter: targetText, role_filter: targetRole, obj_path: objPath, doc_gen: docGen });
      }
    } catch { /* keep the stale refusal */ }
  }
  if (result.stale_ref) {
    throw new Error(`ref "${ref}" is stale — ${result.reason || result.status}.`);
  }
  if (result.error) {
    throw new Error(`No element found matching text ${JSON.stringify(targetText)}${targetRole ? ` (role=${targetRole})` : ""}.`);
  }

  let map = snapshotCache.get(win.pid);
  if (!map) {
    map = new Map();
    snapshotCache.set(win.pid, map);
  }
  let next = refCounters.get(win.pid) || 1;
  const elRef = `e${next++}`;
  refCounters.set(win.pid, next);
  const element = {
    ref: elRef,
    role: result.role,
    name: result.name,
    x: result.x,
    y: result.y,
    w: result.w,
    h: result.h,
    cx: result.cx,
    cy: result.cy,
  };
  if (result.href) element.href = result.href;
  if (result.href_full) element.href_full = result.href_full;
  if (result.off_site) element.off_site = true;
  if (focus) element.focused = !!result.focused;
  // The page's focused editable as read by the focus call itself: used ONCE as the first focus proof.
  if (focus && result.focused_now !== undefined) element.focusedNow = result.focused_now;
  if (result.in_doc !== undefined) element.in_doc = !!result.in_doc;
  // Provenance from the resolved node itself (the bridge stamps it on both the
  // focus and scroll_to paths). A text-based resolve has no cache entry to
  // inherit from, so without this the act gate below would read undefined and
  // fail OPEN on exactly the chrome controls it exists to refuse.
  if (result.doc_class !== undefined) element.doc_class = result.doc_class;
  // Whether a scroll ACTUALLY happened. The bridge scrolls only a positively
  // page surface, so this is false for chrome, browser UI and any unproven
  // surface — and scroll_to_element must not report success without it.
  if (result.scrolled !== undefined) element.scrolled = !!result.scrolled;
  if (result.landmark !== undefined) element.landmark = result.landmark;
  // Stamp the MINTED ref with the RESOLVED node's identity (issue #5) so a
  // later ref-based call on it — even one minted from a text-based resolve like
  // scroll_to_element — resolves by object path, not name. We DON'T return
  // result.obj_path as the active identity for THIS call: a text-based call must
  // keep resolving/refusing by name (returning objPath here is only the INPUT,
  // i.e. non-null solely for genuine ref calls), so text-based ambiguity still
  // refuses.
  const mintedObjPath = result.obj_path || objPath || null;
  const mintedDocGen = result.doc_gen || docGen || null;
  if (mintedObjPath) { element.obj_path = mintedObjPath; element.doc_gen = mintedDocGen; }
  // Navigation-epoch provenance for the node THIS resolution produced
  // (ref_epoch.js): a text-addressed type_into_element is judged by this
  // stamp — minted by the current resolution in the current epoch.
  const epochRecord = pageEpochs.get(win.pid);
  if (epochRecord) { element.page_epoch = epochRecord.seq; element.minted_at = Date.now(); }
  // A text resolve must not smuggle an ineligible node into the ref cache: that
  // would hand out an actionable handle for a surface read_page deliberately
  // refuses to hand out. The element is still RETURNED, so callers with their
  // own trusted path (type_into_element's omnibox) keep working, and the act
  // gate decides what may be done with it.
  if (isRefEligible(element)) map.set(elRef, element);
  else delete element.ref;

  return { element, matchCount: result.match_count, matchedText: targetText, objPath, docGen };
}

/** The click provenance decision, as a pure function so the refusal is testable
 * by execution rather than by reading where it sits.
 *
 * Returns the refusal text, or null when the element is a legitimate page
 * target. Measured cost of not having this (REI, 07e180c): a click on the
 * BROWSER WINDOW's own Close button was accepted as page content and activated,
 * and Chromium exited code 0 at 18.5s because the window it closed was the only
 * one. The check is on the RESOLVED element's provenance, never on its name, so
 * a localized or duplicated "Close" cannot slip past it. */
/** THE authorization boundary click_element crosses. Every action the tool can
 * take — direct-href navigation, semantic activation, the coordinate/pointer
 * fallback, state mutation and the transition probes — lives inside `proceed`,
 * so a refusal cannot be followed by an action even by accident. Exported so a
 * test can COUNT what ran instead of reasoning about where the check sits. */
export async function authorizeClick(element, proceed) {
  const refusal = clickRefusalFor(element);
  if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
  return proceed();
}

/** scroll_to_element's truthful outcome check. Requires BOTH positive page
 * provenance and evidence that a scroll actually happened, so the tool can
 * never claim to have scrolled a surface the bridge deliberately did not touch.
 * Deliberately offers no Escape workaround: Escape is Chromium's stop-loading
 * shortcut and is gated elsewhere for that reason. */
export function scrollRefusalFor(element) {
  if (!isClickAuthorized(element)) {
    const surface = element?.doc_class === "chrome"
      ? "browser chrome, not page content"
      : element?.doc_class === "browser_internal"
      ? "the browser's own UI"
      : "a surface whose document could not be established";
    return `Refused: ${element?.role ?? "element"} ${JSON.stringify(element?.name ?? "")} is ${surface}, so it was NOT scrolled. `
      + "Scrolling is only performed on page content. Call read_page and target an element from the page itself.";
  }
  if (element?.scrolled !== true) {
    return `Not scrolled: ${element?.role ?? "element"} ${JSON.stringify(element?.name ?? "")} is page content, but the accessibility `
      + "layer reported no scroll, so its position may be unchanged. Call read_page to see the current layout before relying on its coordinates.";
  }
  return null;
}

/** PURE. press_element's gate (2026-09-29, variant reader): a READ-ONLY press opens an option list (a size
 * dropdown, a "Select size" button, a tab) so its values can be read. Same page-provenance gate as click_element,
 * and on top of it: only opener roles (never a link: navigation stays click_element's, with its verification), and
 * never a control that changes the cart or the order, whatever the role. Returns the refusal text or null. */
export const PRESS_ROLES = new Set(["push button", "button", "toggle button", "combo box", "page tab", "tab"]);
export function pressRefusalFor(element) {
  const refusal = clickRefusalFor(element);
  if (refusal) return refusal.replace("click_element will not activate it", "press_element will not press it");
  const what = `${element?.role ?? "element"} ${JSON.stringify(element?.name ?? "")}`;
  if (!PRESS_ROLES.has(String(element?.role || ""))) {
    return `Refused: ${what} is not an option opener (press_element presses only ${[...PRESS_ROLES].join(", ")}). NOTHING was pressed. Use click_element for links and other controls.`;
  }
  const name = String(element?.name || "");
  if (isPurchaseControl(name) || isCheckoutStepButton(element) || isCheckoutLink(element)
      || /\b(?:add(?:ing)? (?:it )?to (?:my )?(?:cart|bag|basket|box|registry|wish ?list)|remove|delete|sign ?in|log ?in|sign ?up|subscribe|notify me)\b/i.test(name)) {
    return `Refused: ${what} changes the cart, the order or the account — press_element is read-only and only opens option lists. NOTHING was pressed.`;
  }
  return null;
}

export function clickRefusalFor(element) {
  if (isClickAuthorized(element)) return null;
  const capability = elementCapability(element);
  const surface = capability === "omnibox"
    ? "the browser's address bar"
    : element?.doc_class === "chrome"
    ? "a browser window control, not page content"
    : element?.doc_class === "browser_internal"
    ? "the browser's own UI"
    : "a surface whose document could not be established";
  return `Refused: ${element?.role ?? "element"} ${JSON.stringify(element?.name ?? "")} is ${surface}, so click_element will not activate it. `
    + "NOTHING was clicked, navigated or activated. Browser-level actions are not click targets — use key_press for browser "
    + "navigation shortcuts (F5 or ctrl+r to reload, alt+Left to go back), and type_into_element for the address bar. "
    // Deliberately NOT suggesting Escape: it is also Chromium's stop-loading
    // shortcut, and this harness gates it behind the recovery token for exactly
    // that reason (see navigation_recovery.js). Advertising it here would steer
    // a model around that gate.
    + "For a page overlay, do a fresh read_page and use dismiss_dialog or a proven in-page control — do not press Escape to dismiss it. "
    + "If you meant an in-page control, call read_page and act on a ref from the page itself.";
}

// Controls whose OWN AT-SPI action should be preferred over a coordinate
// click (gh issue #4). Links keep their clean-href direct-navigation path.
const ACTIVATABLE_ROLES = new Set(["button", "toggle button", "menu item", "check menu item", "radio menu item", "radio button", "check box"]);

// Controls whose click is a STATE CHANGE, not a mere activation (issue #6).
// These take a different path: the bridge derives the desired state, invokes the
// matching action, and verifies the exact node reached that state — a size
// selector that reports "clicked" without becoming selected is the bug this
// exists to eliminate. NOT included: toggle button, whose aria-pressed is
// MEASURED not to surface as the CHECKED state on this Chromium (it reports
// checked=false while its action name flips), so its postcondition could never
// verify; and check/radio MENU items, which were not measured.
const CHECKABLE_ROLES = new Set(["check box", "radio button"]);
// A stateful toggle (aria-pressed) is routed SEPARATELY from checkables, not
// added to the set above: it carries `pressed` rather than `checked`, and it
// declares no group, so it must not inherit the checkable path's peer policy.
const TOGGLE_ROLES = new Set(["toggle button"]);

// --- Recovery token (read-time omnibox-popup recovery) -----------------------
// Escape dismisses the omnibox dropdown, but it is ALSO Chromium's stop-loading
// shortcut, and this build exposes no signal that a navigation finished. So the
// only thing that may license that keystroke is POSITIVE evidence that a
// navigation THIS harness started has already completed.
//
// Keyed to the concrete browser identity (window address + pid), never a generic
// "headless" label, which could be reused by a different instance after teardown.
// ONE-SHOT: the token is consumed BEFORE the keystroke is sent, so a second read
// can never spend the same evidence twice.
const recoveryTokens = new Map();
const tokenKey = (win) => `${win.address}|${win.pid}`;

function createPendingToken(win, requestedUrl, prevPage) {
  recoveryTokens.set(tokenKey(win), {
    state: "pending", requestedUrl, prevPage, createdAt: Date.now(),
  });
}
function resolveTokenIfNavigated(win, observedPageUri) {
  const t = recoveryTokens.get(tokenKey(win));
  if (!resolvesNavigation(t, observedPageUri)) return false;
  recoveryTokens.set(tokenKey(win), {
    ...t, state: "resolved", resolvedPageUri: observedPageUri, resolvedAt: Date.now(),
    evidence: `page document URI changed from ${t.prevPage?.state === "known" ? t.prevPage.uri : `(${t.prevPage?.state ?? "unknown"})`} to ${observedPageUri}`,
  });
  return true;
}
// Any action that synthesizes input or activates a control could itself have
// navigated, so the earlier evidence no longer describes the current page.
function invalidateTokenFor(win, why) {
  const k = tokenKey(win);
  const t = recoveryTokens.get(k);
  if (t && t.state !== "invalidated") recoveryTokens.set(k, { ...t, state: "invalidated", invalidatedBy: why });
}
// Consume BEFORE acting, so a thrown error or a failed recovery still spends it.
function consumeToken(win, why) {
  const k = tokenKey(win);
  const t = recoveryTokens.get(k);
  if (t) recoveryTokens.set(k, { ...t, state: "consumed", consumedBy: why, consumedAt: Date.now() });
  return t;
}
const getToken = (win) => recoveryTokens.get(tokenKey(win));

// SUBMIT-TRANSITION TOKENS are a SEPARATE, narrower thing from the recovery
// token above. A recovery token licenses a keystroke; this one licenses nothing
// at all — it only records that the very next plain Return was preceded by a
// verified in-page type, so the harness knows that Return is worth spending a
// bounded look at afterwards. It can never cause an action.
const submitTokens = new SubmitTokenStore();

/** The ONE production consumer of an observation's spend record.
 *
 * stdout is the MCP protocol channel, so this writes to stderr and only ever
 * one line: the fixed, page-free schema from submit_transition.js. It exists so
 * a late commit can be attributed after the fact instead of reconstructed from
 * turn counts — which is what forced the last diagnosis to guess.
 *
 * ISOLATED FROM THE TOOL. A diagnostic that can change an outcome is worse than
 * no diagnostic, so every failure here — a broken stream, a serialization
 * error, a throwing injected writer — is swallowed. The observation has already
 * been classified by the time this runs and this never touches it.
 * `write` is injected so the emission can be counted rather than assumed. */
export function emitSubmitTransitionDiagnostic(result, deps = {}) {
  const write = deps.write || ((line) => process.stderr.write(`${line}\n`));
  try {
    const line = formatSubmitTransitionDiagnostic(result);
    if (line) write(line);
  } catch {
    // Deliberately empty: see above.
  }
}

/** The ONE bridge command for a URI-only page read, so both callers that want
 * nothing but the page document's URI issue the identical request by
 * construction rather than by two hand-written literals staying in step.
 *
 * `page_document_uri` is a single truncated traversal that stops at the first
 * page document; navigation_focus would pay for two full-tree walks — a focus
 * search these callers discard, and a document collection that descends through
 * the whole content subtree — to produce the same field. Probe cost is what
 * decides how many samples fit inside TRANSITION_BUDGET_MS, so this is not a
 * micro-optimisation: an expensive read makes a late commit LESS observable. */
export function pageUriBridgeCommand(win) {
  return { pid: win.pid, action: "page_document_uri" };
}

// The page document URI, read as ONE bridge call. Returns null on any failure,
// which the classifier treats as "unobservable" rather than as evidence.
async function readPageDocumentUri(win) {
  try {
    const nav = await atspiBridge(pageUriBridgeCommand(win));
    return nav?.page_document_uri_raw || null;
  } catch {
    return null;
  }
}

// ── Clean-href direct navigation: observation (rev 21, cut 1) ────────────────
// Live cost that motivated this (Best Buy sessions edb30f7e / 33ad2f9f): after
// the address-bar submission the destination PDP was loading for the whole
// window, every poll read an EMPTY page URI, and the tool treated that as "not
// reached": a full accessibility snapshot per poll, then an error-page snapshot,
// then a NOT VERIFIED answer at 9–13 s — and the model spent a whole extra turn
// to learn the page had in fact landed. Rules now:
//   * the URI is read with the ONE-call page_document_uri probe (the same
//     command the submit-transition poll issues), feeding the page-epoch record
//     exactly as a snapshot poll did;
//   * an EMPTY reading means the document is being replaced — still navigating,
//     never evidence — and is waited on within ONE shared budget, the one
//     read_after_navigation already has (NAVIGATION_READY_BUDGET_MS);
//   * the resubmission rule is unchanged (shouldResubmitNavigation: only a
//     readable, positively unchanged page URL at the first-window decision
//     point buys the one extra submission);
//   * the error-page classification runs once on any unverified outcome (a
//     chrome-error document also reads as an empty URI); the semantic-link
//     fallback applies only to a READABLE URI parked on the pre-submit page.
export const NAVIGATION_READY_BUDGET_MS = 6000;    // read_after_navigation's default budget, shared here
export const DIRECT_NAV_FIRST_WINDOW_MS = 2500;    // unchanged: the resubmission decision point
export const DIRECT_NAV_POLL_MS = 200;             // unchanged first-window cadence
export const DIRECT_NAV_GRACE_POLL_MS = 250;       // unchanged cadence after the decision point
export const SEMANTIC_FALLBACK_DEADLINE_MS = 4000; // unchanged

// The page document URI via the one-call probe, feeding the page-epoch record
// exactly as a snapshot poll did (ref identity depends on that observation).
// "" when unreadable: the document is being replaced, or nothing could be read.
async function observePageUri(win) {
  const uri = await readPageDocumentUri(win);
  if (uri) observePageEpoch(pageEpochs, win.pid, uri);
  return uri || "";
}

// One address-bar submission of a clean href (unchanged keystroke sequence).
async function submitAddress(href) {
  await ctrlKey("l");
  await new Promise((r) => setTimeout(r, 150));
  // Explicit select-all, not just relying on ctrl+L's own (unreliable —
  // caught live, twice now: old and new URL silently concatenated
  // instead of replacing) implicit select-on-focus. (wtype's "a" rode evdev 1, KEY_ESC: likely why.)
  await selectAllKeys();
  await new Promise((r) => setTimeout(r, 100));
  // Per-character wtype can drop punctuation under nested-compositor load
  // (caught live here: owalalife.com -> owalalifecom). Headless instances
  // own an isolated clipboard, so paste the href atomically. Keep the
  // real-desktop path clipboard-neutral.
  if (AUTOMATION_BACKEND === "headless") await pasteValue(href);
  else await typeWithWtype(href, 25);
  await new Promise((r) => setTimeout(r, 150));
  await tapKey("Return");
}

/** Submit a clean href through the address bar and observe the landing. Every
 * side effect is injectable (deps) so a scripted bridge can drive it; the
 * defaults are the real keystrokes, the URI probe and the AT-SPI activation. */
export async function directHrefNavigation({ href, element, win, beforeUrl, objPath, docGen }, deps = {}) {
  const readUri = deps.readUri || (() => observePageUri(win));
  const submit = deps.submit || (() => submitAddress(href));
  const snapshot = deps.snapshot || ((opts) => snapshotWindow(win, opts));
  const semanticActivate = deps.semanticActivate || (() => atspiBridge({
    pid: win.pid, offset_x: win.at[0], offset_y: win.at[1],
    action: "semantic_activate", text_filter: element.name,
    role_filter: element.role, obj_path: objPath, doc_gen: docGen,
  }));
  const invalidate = deps.invalidate || ((why) => invalidateTokenFor(win, why));
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const budgetMs = deps.budgetMs ?? NAVIGATION_READY_BUDGET_MS;
  let observedUrl = "";
  let submissions = 0;
  let polls = 0;
  const reached = () => cleanHrefReached(href, observedUrl);
  const poll = async (intervalMs, until) => {
    do {
      await sleep(intervalMs);
      observedUrl = await readUri();
      polls += 1;
      if (reached()) return true;
    } while (now() < until);
    return false;
  };
  const start = now();
  const budgetEnd = start + budgetMs;
  // CLICK FIRST, like a person: activate the link itself (its AT-SPI action on this exact identity — not a
  // coordinate click, so the old Amazon wrong-element failure cannot recur) and verify by the page URL. The
  // address bar is only the fallback when the click provably did not move the page (typing URLs instead of
  // clicking a link is not what a person does).
  if (objPath && deps.clickFirst !== false) {
    let clicked = false;
    try {
      const act = await semanticActivate();
      clicked = classifyActivation(act).kind === "invoked";
      if (clicked && INPUT_STATS_ENABLED) inputStats.nativeActions++;
    } catch { clicked = false; }
    if (clicked) {
      let arrived = await poll(DIRECT_NAV_POLL_MS, Math.min(start + DIRECT_NAV_FIRST_WINDOW_MS, budgetEnd));
      // The page left (or is being replaced): the click is loading it — wait, never type over it.
      if (!arrived && observedUrl !== beforeUrl) arrived = await poll(DIRECT_NAV_GRACE_POLL_MS, budgetEnd);
      if (arrived) {
        invalidate("link click navigation");
        return { text: `Clicked link ${element.ref} "${element.name}" and it opened ${href} [verified by page URL].`, verified: true, stillNavigating: false, submissions: 0, polls, observedUrl, recovery: null, semanticFallback: null, clicked: true, elapsedMs: now() - start };
      }
      // It went somewhere else (a redirect, a locale page): report where, never retype over it.
      if (observedUrl && observedUrl !== beforeUrl) {
        invalidate("link click navigation");
        return { text: `Clicked link ${element.ref} "${element.name}"; the page moved to ${observedUrl} (not exactly ${href}). Read the page before acting.`, verified: false, stillNavigating: false, submissions: 0, polls, observedUrl, recovery: null, semanticFallback: null, clicked: true, elapsedMs: now() - start };
      }
    }
  }
  submissions = 1;
  await submit();
  let verified = await poll(DIRECT_NAV_POLL_MS, Math.min(start + DIRECT_NAV_FIRST_WINDOW_MS, budgetEnd));
  // The URL the browser was showing BEFORE anything was typed is the only
  // evidence that buys a second submission: an exact, readable, unchanged web
  // page URL proves the keystrokes never landed. Anything else — moved, or
  // unreadable (empty: the document is being replaced) — leaves "still
  // loading" open, and retyping would abort the in-flight load (measured at
  // 12-20s per link on Zappos). See shouldResubmitNavigation.
  if (!verified && now() < budgetEnd && shouldResubmitNavigation(beforeUrl, observedUrl)) {
    submissions = 2;
    await submit();
    verified = await poll(DIRECT_NAV_POLL_MS, Math.min(now() + DIRECT_NAV_FIRST_WINDOW_MS, budgetEnd));
  }
  // Not proven either way: wait out the SHARED budget on this submission
  // instead of restarting it. A page URL still positively parked on the
  // pre-submit page after the second submission is not waited on — waiting
  // proves nothing more there; the semantic fallback below is its remedy.
  if (!verified && now() < budgetEnd && !(submissions === 2 && shouldResubmitNavigation(beforeUrl, observedUrl))) {
    verified = await poll(DIRECT_NAV_GRACE_POLL_MS, budgetEnd);
  }
  let recovery = null;
  let semanticFallback = null;
  let stillNavigating = false;
  if (!verified) {
    // ONE error-page read, on an empty reading too: a browser transport error
    // renders a chrome-error document, which the bridge does not count as a
    // page document (BROWSER_DOC_SCHEMES), so its URI reads as EMPTY exactly
    // like a document that is still being replaced. Only the rows tell the two
    // apart — an http2 reset (the 2026-09-02 Best Buy shape) must keep its
    // diagnosis and its "do not retry this candidate" instruction.
    const errorPage = await snapshot({ includeText: true, limit: 80, pageInfo: true });
    recovery = transientBrowserNavigationError(errorPage.elements);
    // An EMPTY reading with no error page is "still navigating": there is no
    // page to activate a link on, so the semantic fallback is never attempted
    // (shouldFallbackToSemanticLink also requires the readable pre-submit URL).
    stillNavigating = observedUrl === "" && !recovery;
    // Do not resubmit the exact URL after a browser transport error. Live
    // Best Buy evidence showed a candidate-specific HTTP/2 reset twice in
    // this internal retry, while the already-listed alternate loaded on its
    // first submission; an independent request to the same failed href also
    // reset. Retrying here paid ~7s and supplied no new evidence. Return the
    // diagnosed failure so the agent can spend its one allowed alternate.
    //
    // A clean-href optimization must not become a single point of failure.
    // Some storefront overlays repeatedly reclaim keyboard focus, so even
    // ctrl+L + an atomic paste can leave the browser positively parked on the
    // exact results URL (caught live on Skechers). In that narrowly proven
    // state, activate the ORIGINAL link identity once through AT-SPI. Never
    // do this after an unreadable/moved URL: the omnibox submission could be
    // in flight, and a second action could duplicate or race it. Likewise,
    // never degrade a stale cached ref into a name or coordinate click.
    if (!stillNavigating && shouldFallbackToSemanticLink({ href, beforeUrl, observedUrl, recovery, objPath })) {
      try {
        const act = await semanticActivate();
        const cls = classifyActivation(act);
        semanticFallback = cls.kind === "invoked"
          ? `issued AT-SPI '${act.invoked_name}' once on the original link identity`
          : `refused semantic fallback (${act?.reason || cls.reason || cls.kind})`;
        if (cls.kind === "invoked") {
          if (INPUT_STATS_ENABLED) inputStats.nativeActions++;
          verified = await poll(DIRECT_NAV_GRACE_POLL_MS, now() + SEMANTIC_FALLBACK_DEADLINE_MS);
        }
      } catch (error) {
        semanticFallback = `semantic fallback failed (${error.message})`;
      }
    }
  }
  // This navigates WITHOUT going through the verified-omnibox token
  // transaction, so it produces no evidence — and it must not silently
  // inherit the previous navigation's.
  invalidate("clean-href direct navigation");
  const times = submissions === 1 ? "once" : `${submissions} times`;
  const text = verified
    ? semanticFallback
      ? `Navigated via the original semantic link to ${href} [verified by page URL] (omnibox stayed on the prior page, then ${semanticFallback}).`
      : `Navigated directly to ${href} [verified by page URL] (was ${element.ref} ${element.role} "${element.name}" — clean href, so this is more reliable than a coordinate click).`
    : stillNavigating
      ? `Direct navigation to ${href} was submitted ${times} but NOT VERIFIED within ${budgetMs} ms: the page document URI was not readable yet (the document is still being replaced — still navigating; one error-page read found no browser error). Do not resubmit and do not claim navigation succeeded; call read_after_navigation with expected_url ${href} to confirm the landing.`
      : `Direct navigation to ${href} was submitted ${times} but NOT VERIFIED${recovery ? `: browser reported ${recovery}; do not retry this same candidate—use one already-listed relevant alternate` : `: the page is at ${observedUrl || "an unobservable URL"}`}${semanticFallback ? `; ${semanticFallback}` : ""}. Do not claim navigation succeeded.`;
  return { text, verified, stillNavigating, submissions, polls, observedUrl, recovery, semanticFallback, elapsedMs: now() - start };
}

// Invalidate EVERY token, not just the acting window's. Resolving a window here
// would cost an extra query on every call, and over-invalidating is free in
// safety terms: the only consequence is a recovery we decline to attempt, never
// a keystroke we should not have sent.
function invalidateAllTokens(why) {
  for (const [k, t] of recoveryTokens) {
    if (t.state !== "invalidated") recoveryTokens.set(k, { ...t, state: "invalidated", invalidatedBy: why });
  }
}

// Fresh, caller-agnostic signals used to detect that an activation actually
// caused a transition (do_action's boolean is never trusted as success).
//
// The target's own state snapshot is read by IDENTITY whenever the element
// carries one (issue #6): (doc_gen, obj_path) names the exact control that was
// activated, so a duplicate-named sibling can never supply the "before" or
// "after" states. This is what makes a checked/selected delta trustworthy on a
// radio/check group, where every option shares a role and options frequently
// share a name across responsive duplicates. Identity calls send NO
// text_filter, so there is structurally nothing to name-match against; the role
// travels only as a SANITY gate (a node whose role changed under a stable
// object path is fail-closed as stale_mismatch, since its states are no longer
// comparable to the baseline), never as a resolver. A lost identity comes back
// as stale:<status> and is reported, never turned into a delta. Elements with
// no identity (the gated no-objpath mode) keep the legacy unique-name-match
// behaviour.
async function captureSignals(win, element) {
  const byIdent = !!element.obj_path;
  const out = { dialogs: null, url: null, focused: null, focusedPath: null, targetStates: null,
                targetAvail: "ok", targetIdentity: byIdent ? "obj_path" : "name", targetLabel: null };
  // ONE bridge process for the dialog snapshot, the focus and the target's states (they were three, per probe,
  // and a click probes before and several times after). Each part keeps its own failure mapping below.
  let r = null;
  try {
    r = await atspiBridge({
      pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "capture_signals",
      target: byIdent
        ? { obj_path: element.obj_path, doc_gen: element.doc_gen ?? null, role_filter: element.role }
        : { text_filter: element.name, role_filter: element.role },
    });
  } catch { r = null; }
  if (r === null) { out.targetAvail = "error"; return out; }
  if (!r.error && r.snapshot && !r.snapshot.error) {
    ingestSnapshot(win, r.snapshot);
    // The bridge counts dialogs with one Collection query when it can (dialog_count); else it sent the rows.
    out.dialogs = typeof r.snapshot.dialog_count === "number" ? r.snapshot.dialog_count : r.snapshot.elements.length;
    out.url = r.snapshot.page?.url ?? null;
  }
  if (!r.focused?.error) {
    const f = r.focused || {};
    out.focused = f.focused ? `${f.focused.role}|${f.focused.name}` : "none";
    out.focusedPath = f.focused?.obj_path ?? null;
  }
  const es = r.error ? {} : r.states;
  if (!es || es.error) out.targetAvail = "error";
  else if (es.stale_ref) out.targetAvail = `stale:${es.status}`; // fail closed, no name retry
  else if (es.found && (es.identity === "obj_path" || es.match_count === 1)) {
    out.targetStates = es.states;
    out.targetLabel = `${es.role}|${es.name}`; // live label: a rename stays visible as evidence
  } else out.targetAvail = es.found ? "identity-changed" : "missing"; // never manufacture a delta
  return out;
}

// Poll (bounded) for any observed transition after an activation. Compares
// dialog count, document URL, focused node, and — where the target is still
// freshly resolvable BY ITS OWN IDENTITY (issue #6) — its own state deltas.
// Both the pre and post snapshots must come from the same identity channel, so
// a checked/selected delta is always this control's, never a same-named
// sibling's. If the target's identity no longer resolves (removed node,
// document reload) that is REPORTED (stale:<status>) and never counted as a
// transition — a vanished target is not evidence the activation worked.
export async function pollTransition(win, element, pre, intervalMs, deadlineMs, opts = {}) {
  // countTargetRemoval is opt-in and passed ONLY by the generic semantic
  // activation path. Toggle, checkable, the coordinate fallback, direct
  // navigation and dismiss_dialog keep "a vanished target is not evidence"
  // exactly as it was — for a state-setting action a disappeared control
  // genuinely proves nothing about the state it was asked to reach.
  const { countTargetRemoval = false, capture = captureSignals, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = opts;
  const removal = new TargetRemovalTracker();
  const start = now();
  // Which of the control's OWN states count as evidence lives in
  // transition_signals.js, with the reasoning for each inclusion and for the
  // deliberate exclusion of `focused`.
  //
  // Focus landing on the ACTIVATED control itself is trivial (pressing a
  // button focuses it) and is NOT evidence the action did anything — so a
  // self-focus move doesn't count as a transition. Focus moving to a
  // DIFFERENT node (e.g. a mounted search input) does count.
  // Self-focus is decided by OBJECT-PATH IDENTITY where both sides have one
  // (issue #6): comparing `role|name` strings misfires when the activation
  // makes the control relabel or change role, reporting "focus -> <the very
  // control we pressed>" as though focus had moved elsewhere. The string
  // comparison remains as the fallback for elements with no identity. A path
  // could in principle be reused by a different node after a navigation, but
  // that case already reports `url changed`, and the failure direction here is
  // to UNDER-report a focus move, never to invent one.
  const targetKey = `${element.role}|${element.name}`;
  const isSelfFocus = (post) =>
    element.obj_path && post.focusedPath
      ? post.focusedPath === element.obj_path
      : post.focused === targetKey;
  const diff = (post) => {
    const d = [];
    // Both counts must be real readings: an unreadable dialog snapshot leaves
    // null, and `null !== 0` reported a failed read as a dialog appearing.
    if (dialogsObservedChanged(pre.dialogs, post.dialogs)) d.push(`dialogs ${pre.dialogs}->${post.dialogs}`);
    // BOTH readings must exist. A URL readable on one side and not the other is
    // a failed read, not a navigation, and `!==` alone reported it as one —
    // inventing a transition out of a gap in observation.
    if (urlObservedChanged(pre.url, post.url)) d.push(`url changed`);
    // "none" is a real reading (the tree was read, nothing held focus); null is
    // a FAILED read. Comparing them manufactured `focus -> none`. The self-focus
    // exclusion below is unchanged.
    if (focusObservedChanged(pre.focused, post.focused) && !isSelfFocus(post)) d.push(`focus -> ${post.focused}`);
    // The control's OWN state deltas come from the pure, unit-tested comparison
    // (transition_signals.js) so the set of states that count as evidence
    // cannot drift away from what the tests pin.
    d.push(...diffTargetStates(
      { avail: pre.targetAvail, states: pre.targetStates },
      { avail: post.targetAvail, states: post.targetStates },
    ));
    return d;
  };
  let last = [];
  let lastAvail = pre.targetAvail;
  while (now() - start < deadlineMs) {
    await sleep(intervalMs);
    const post = await capture(win, element);
    lastAvail = post.targetAvail;
    last = diff(post);
    if (last.length) return { changed: true, summary: `Transition observed: ${last.join("; ")}.` };
    // EXACT-TARGET REMOVAL, only where the caller opted in. Checked after the
    // ordinary signals so an observable delta always wins, and gated on the
    // pure predicate + a persistence requirement so a blink cannot qualify.
    if (countTargetRemoval && removal.observe({
      preAvail: pre.targetAvail,
      postAvail: post.targetAvail,
      // Both computed by the pure helpers, so an unreadable URL or a blank
      // doc_gen fails CLOSED here rather than looking like "unchanged".
      urlObservedUnchanged: urlObservedUnchanged(pre.url, post.url),
      hadDocGen: hasUsableDocGen(element.doc_gen),
    })) {
      return { changed: true, removalOnly: true, summary: `Transition observed: ${TARGET_REMOVED_SIGNAL} (the page did not navigate).` };
    }
  }
  // "Nothing changed" and "we could not observe this control" are different
  // facts; say which one it was instead of silently reporting the former.
  const blind = pre.targetAvail !== "ok" || lastAvail !== "ok"
    ? ` (its own state was not observable: ${pre.targetAvail}/${lastAvail} — only page-level signals were compared)`
    : "";
  return { changed: false, summary: `No transition observed within ${Math.round(deadlineMs / 1000)}s${blind}.` };
}

async function captureDisclosureSignals(win, element) {
  const base = await captureSignals(win, element);
  try {
    const links = await snapshotWindow(win, { roleFilter: "link", limit: 500 });
    base.linkKeys = links.elements
      .filter((e) => e.name || e.href)
      .map((e) => `${e.name || ""}|${e.href || ""}`);
  } catch {
    base.linkKeys = [];
  }
  return base;
}

async function pollDisclosureTransition(win, element, pre, intervalMs = 150, deadlineMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const post = await captureDisclosureSignals(win, element);
    const changes = diffDisclosureSignals(pre, post);
    if (changes.length) return { changed: true, summary: `Disclosure observed: ${changes.join("; ")}.` };
  }
  return { changed: false, summary: "No expanded state or newly exposed links were observed within 2s." };
}

// --- Site memory ------------------------------------------------------------
// Persistent, per-domain knowledge that accumulates the more a site is
// visited: which nav links exist, which roles/names reliably find the search
// box or cart, and manually-recorded shortcuts (e.g. a direct search URL
// pattern) so a second visit can skip straight to acting instead of
// re-discovering the page from scratch. This is the "gets faster every visit"
// layer on top of the read_page/click_element perception layer.

// WHERE site memory lives: on the user's own machine, starting EMPTY — $COMPUTER_USE_SITEMAP_DIR, else
// $XDG_DATA_HOME/omarchy-computer-use/sites (~/.local/share/omarchy-computer-use/sites). A plugin may point it elsewhere
// (ctx.siteMemory.setDir) when the env does not name one.
let SITEMAP_DIR = process.env.COMPUTER_USE_SITEMAP_DIR
  || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "omarchy-computer-use", "sites");
// A plugin may also take over WHERE visits are recorded and where read_page's hint comes from (ctx.siteMemory.setBackend):
// { recordVisit(domain, eligibleElements, { title, url, at }) → true when it recorded the visit itself,
//   hint(domain) → { visitCount, searchUrlPattern, notes } | null }. Without one, the JSON files below are the record.
let siteMemoryBackend = null;

function domainFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function sitemapPath(domain) {
  return path.join(SITEMAP_DIR, `${domain}.json`);
}

async function loadSiteMap(domain) {
  try {
    const raw = await readFile(sitemapPath(domain), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeSiteMap(domain, map) {
  await mkdir(SITEMAP_DIR, { recursive: true });
  await writeFile(sitemapPath(domain), JSON.stringify(map, null, 2));
}

function emptySiteMap(domain) {
  return {
    domain,
    visitCount: 0,
    firstVisited: null,
    lastVisited: null,
    lastTitle: null,
    nav: {}, // "role::name" -> {role, name, seenCount, firstSeen, lastSeen}
    fields: {}, // same shape, for entry/combo box/password fields
    searchUrlPattern: null, // e.g. "https://example.com/search?q={query}" — set manually once verified
    loginUrl: null,
    notes: [],
  };
}

// Automatically called from read_page: folds whatever elements this call saw
// into the persistent map. Best-effort — never throws into the caller, since
// this is a nice-to-have layer on top of the core tool, not required for it
// to work.
async function recordVisit(win, elements, pageInfo) {
  try {
    const domain = pageInfo?.url ? domainFromUrl(pageInfo.url) : null;
    if (!domain) return;
    const now = new Date().toISOString();
    if (siteMemoryBackend?.recordVisit) {
      const eligible = elements.filter((el) => isSiteMemoryEligible(el) && !isUnrememberableName(el.name));
      try { if (await siteMemoryBackend.recordVisit(domain, eligible, { title: pageInfo.title || null, url: pageInfo.url, at: now })) return; } catch { /* fall back to the JSON record */ }
    }
    const map = scrubPrivateLocators((await loadSiteMap(domain)) || emptySiteMap(domain));
    map.visitCount += 1;
    map.firstVisited = map.firstVisited || now;
    map.lastVisited = now;
    map.lastTitle = pageInfo.title || map.lastTitle;

    for (const el of elements) {
      // Only record elements from a POSITIVELY identified page document.
      // in_doc is not enough: Chromium's omnibox dropdown is itself a
      // `document web`, so browser UI satisfies it — which is how "Ask AI Mode"
      // came to be recorded as a Victoria's Secret field and misled a debugging
      // session (gh issue #1 cleanup). The class is stamped at collection time.
      if (!isSiteMemoryEligible(el)) continue;
      if (isUnrememberableName(el.name)) continue; // a private locator, or a review control carrying a reviewer's name
      const isField = ["entry", "password text", "combo box"].includes(el.role);
      const bucket = isField ? map.fields : map.nav;
      const key = `${el.role}::${el.name}`;
      if (bucket[key]) {
        bucket[key].seenCount += 1;
        bucket[key].lastSeen = now;
      } else {
        bucket[key] = { role: el.role, name: el.name, seenCount: 1, firstSeen: now, lastSeen: now };
      }
    }
    await writeSiteMap(domain, map);
  } catch {
    // Non-critical — never let site-memory bookkeeping break a real tool call.
  }
}

// DURABLE SEARCH-ROUTE LEARNING from a navigation the browser already proved.
// Homepage HTML discovery cannot see a client-rendered search form, so sites
// like Ulta kept arriving with empty site memory and re-fought a remounting
// search widget every run. Once a SEARCH destination is verified ready, the
// observed URL is the real search route and the submitted query text is known,
// so the {query} pattern follows without any extra network request.
//
// Fail-closed on every axis: only a verified search read (the caller passes
// accept_product_link for those), never a product/detail URL, same origin as
// the destination that was actually verified, exactly one query parameter
// binding the query text (enforced in searchPatternFromObservedUrl), and never
// overwriting a pattern already in site memory.
async function learnSearchRoute(observedUrl, expectedUrl, queryText) {
  try {
    if (!observedUrl || !queryText) return;
    const observed = new URL(observedUrl);
    if (observed.origin !== new URL(expectedUrl).origin) return;
    if (productShapedPath(observed.pathname)) return;
    const pattern = searchPatternFromObservedUrl(observedUrl, queryText);
    if (!pattern || new URL(pattern.replace("{query}", "probe")).origin !== observed.origin) return;
    const domain = domainFromUrl(observedUrl);
    if (!domain) return;
    const map = (await loadSiteMap(domain)) || emptySiteMap(domain);
    if (map.searchUrlPattern) return;
    map.searchUrlPattern = pattern;
    map.notes = [...new Set([...(Array.isArray(map.notes) ? map.notes : []), "Search route learned from a verified in-browser search navigation."])];
    await writeSiteMap(domain, map);
  } catch {
    // Site memory is a nice-to-have layer; never fail a real tool call over it.
  }
}

function summarizeSiteMap(map, { full = false } = {}) {
  if (!map) return null;
  const navNames = Object.values(map.nav)
    .sort((a, b) => b.seenCount - a.seenCount)
    .map((e) => e.name);
  const fieldList = Object.values(map.fields).map((e) => `${e.role} "${e.name}"`);
  const summary = {
    domain: map.domain,
    visitCount: map.visitCount,
    lastVisited: map.lastVisited,
    lastTitle: map.lastTitle,
    searchUrlPattern: map.searchUrlPattern,
    loginUrl: map.loginUrl,
    notes: map.notes,
    knownFields: fieldList,
    knownNav: full ? navNames : navNames.slice(0, 20),
  };
  return summary;
}

const server = new McpServer({
  name: "computer-use",
  version: "0.1.0",
});

// ONE central place for the invalidation rule (review ruling): a tool that
// synthesizes input or activates a control could itself have navigated, so any
// earlier navigation evidence stops describing the current page. Observation-only
// tools never invalidate. Wrapping registration keeps this from having to be
// remembered at each call site — including tools added later.
const _registerToolRaw = server.registerTool.bind(server);
server.registerTool = (name, def, handler) =>
  _registerToolRaw(name, def, async (...args) => {
    // A crop-local raw click must consume the current screenshot context
    // inside its handler before the click invalidates it. Other actions clear
    // the context before running; raw click clears it after validation/action.
    if (invalidatesToken(name) && name !== "click") {
      invalidateAllTokens(name);
      latestScreenshotContext = null;
      // key_press is excluded ONLY here: this wrapper runs BEFORE the handler,
      // so clearing the submit token now would destroy the very token the
      // plain-Return path exists to consume. key_press invalidates it itself on
      // every path that is not that consume, so no other synthesized key can
      // leave a stale token behind.
      if (name !== "key_press") submitTokens.invalidateAll();
    }
    const result = await handler(...args);
    if (name === "click") {
      invalidateAllTokens(name);
      latestScreenshotContext = null;
      submitTokens.invalidateAll();
    }
    return result;
  });
server.registerTool(
  "screenshot",
  {
    title: "Take a screenshot",
    description:
      "Capture the real screen (or a region, or a specific window's bounds) via the Wayland compositor (grim). Returns a PNG image. " +
      "EXPENSIVE: costs image tokens and a vision pass. For interactive elements (buttons, links, form fields) use read_page/click_element/type_into_element instead — they're exact and far cheaper. " +
      "Reach for screenshot only for things the accessibility tree can't describe: canvas/WebGL content, images you need to actually look at, CAPTCHAs, or visually verifying a final result. " +
      "IMPORTANT: when a region/window crop is used, the returned image's pixel (0,0) is NOT screen (0,0) — it's the region's top-left corner. The accompanying text tells you that offset; you MUST add it to any pixel position you read off the image before passing coordinates to click/move_mouse, or you will click the wrong place.",
    inputSchema: z.object({
      region: z
        .object({
          x: z.number().int(),
          y: z.number().int(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .optional()
        .describe("Pixel region to capture. Omit to capture the whole screen."),
      window_address: z
        .string()
        .optional()
        .describe(
          "Hyprland window address (from list_windows) to crop the screenshot to instead of specifying region manually."
        ),
    }).strict(),
  },
  async ({ region, window_address }) => {
    let effectiveRegion = region;
    if (!effectiveRegion && window_address) {
      const win = (await listWindows()).find((w) => w.address === window_address);
      if (win) {
        effectiveRegion = {
          x: win.at[0],
          y: win.at[1],
          width: win.size[0],
          height: win.size[1],
        };
      }
    }
    if (!validCaptureRegion(effectiveRegion)) {
      return { content: [{ type: "text", text: "Refused screenshot: capture width and height must be positive integers." }], isError: true };
    }
    const base64 = await screenshotToBase64(effectiveRegion);
    const screenshotId = randomUUID();
    latestScreenshotContext = effectiveRegion ? Object.freeze({ id: screenshotId, region: Object.freeze({ ...effectiveRegion }) }) : null;
    const offsetNote = effectiveRegion
      ? `screenshot_id=${screenshotId}; this image's pixel (0,0) = real screen (${effectiveRegion.x},${effectiveRegion.y}). For crop-local coordinates, call click with coordinate_space="screenshot_crop" and this screenshot_id; do not add the offset yourself.`
      : "This is the full screen — image pixels ARE real screen coordinates, no offset needed.";
    return {
      content: [
        { type: "text", text: offsetNote },
        { type: "image", data: base64, mimeType: "image/png" },
      ],
    };
  }
);

// Registered ONLY under COMPUTER_USE_TEST_INPUT_STATS=1 — never part of the
// normal production tool surface.
if (INPUT_STATS_ENABLED) {
  server.registerTool(
    "get_input_stats",
    {
      title: "Get cumulative synthetic-input counts (test-only)",
      description:
        "Read-only cumulative counts of pointer moves and clicks this server has issued (moves, clicks). Test-only: a zero delta around an action proves it performed no synthetic mouse move/click.",
      inputSchema: z.object({}).strict(),
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(inputStats) }] })
  );
}

// Registered ONLY under COMPUTER_USE_MANUAL_TOOLS=1 — the manual (customer-driven)
// session worker's MCP subprocess (engine_service/manual_worker.mjs). The agent's
// model-facing tool list stays byte-identical. One bridge call (page_document_uri,
// the same probe the navigation observers use), never a tree walk: the relay's
// sandbox reads it after every input burst.
if (process.env.COMPUTER_USE_MANUAL_TOOLS === "1") {
  server.registerTool(
    "get_page_url",
    {
      title: "Get the page document URL (manual sessions only)",
      description: "Read the current page document's URL with one accessibility-bridge call. Returns {url} with null when the document is being replaced or nothing could be read.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const win = await resolveWindow(undefined);
      const url = await observePageUri(win);
      return { content: [{ type: "text", text: JSON.stringify({ url: url || null }) }] };
    }
  );
  // Grab keyboard focus on the editable at a click point (manual sessions only). A synthetic pointer
  // click can land on a store's search box without its inner input taking DOM focus, so typed text goes
  // nowhere; this focuses the field via the accessibility API (grab_focus), the way a screen reader does.
  // Best-effort: no editable at the point → {found:false}, the caller ignores it (a click on a link/button
  // is unaffected). Screen coordinates, the same space the click tool uses.
  server.registerTool(
    "focus_editable_at",
    {
      title: "Focus the editable under a point (manual sessions only)",
      description: "Grab keyboard focus on the SHOWING+ENABLED+EDITABLE element at screen (x, y), or the nearest one within a tight radius. Returns {found, focused, role, name} or {found:false}. No-op when nothing editable is there.",
      inputSchema: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
    },
    async ({ x, y }) => {
      const win = await resolveWindow(undefined);
      let result;
      try { result = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "focus_editable_at", x, y }); }
      catch { result = { found: false }; }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
  // Where keyboard focus lives, as the bridge classifies it: "page" (the store's document), "browser_internal"
  // (the omnibox and other browser UI), "chrome", "unknown" or "none". The manual worker refuses to type into
  // anything but the page. One navigation_focus bridge call.
  server.registerTool(
    "get_focus_class",
    {
      title: "Classify the keyboard focus (manual sessions only)",
      description: "Read where keyboard focus lives with one accessibility-bridge call: {doc_class, in_doc, page_url}. doc_class is page | browser_internal | chrome | unknown | none.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const win = await resolveWindow(undefined);
      const nav = await atspiBridge({ pid: win.pid, action: "navigation_focus" }).catch(() => null);
      const focused = nav?.focused ?? null;
      const docClass = !nav ? "unknown" : !focused ? "none" : (focused.in_doc === false ? "chrome" : (focused.doc_class || nav.doc_class || "unknown"));
      // role/name of the focused element: the customer-control guard (C4) refuses typing into a card field.
      return { content: [{ type: "text", text: JSON.stringify({ doc_class: docClass, in_doc: focused?.in_doc === true, page_url: nav?.page_document_uri ?? null, role: focused?.role ?? null, name: focused?.name ?? null }) }] };
    }
  );

  // A real-time press or release at a screen point (the input relay's pointer.down / pointer.up, manual and takeover
  // connections only — the agent never gets it). The customer's own hold on a store's "Press & Hold" human check
  // reaches the page as one mousedown … mouseup of the length they held. Never used to pass a human check itself.
  server.registerTool(
    "pointer_button",
    {
      title: "Press or release a mouse button at a point (manual sessions only)",
      description: "Move to screen point (x, y) and press (action \"press\") or release (action \"release\") one mouse button. A press stays down until its release.",
      inputSchema: z.object({
        x: z.number().int(),
        y: z.number().int(),
        button: z.enum(["left", "right", "middle"]).default("left"),
        action: z.enum(["press", "release"]),
      }).strict(),
    },
    async ({ x, y, button, action }) => {
      try {
        await moveMouseRaw(x, y);
        await pointerButtonRaw(button, action);
      } catch (error) {
        return { content: [{ type: "text", text: `pointer_button ${action} failed: ${String(error?.message || error).slice(0, 200)}` }], isError: true };
      }
      return { content: [{ type: "text", text: `${button} ${action} at ${x},${y}` }] };
    }
  );
  // C4 customer control: what the page has under a point (outermost → innermost role/name), with the same
  // accessibility hit-test as click_element's verified-point click. The guard refuses a customer click that
  // would land on "Place order", a wallet button or a card field. Never acts.
  server.registerTool(
    "element_at",
    {
      title: "Read what is under a screen point (customer-control guard)",
      description: "Return {chain:[{role,name}…]} for the page elements under screen point x,y, outermost to innermost. Never acts.",
      inputSchema: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
    },
    async ({ x, y }) => {
      const win = await resolveWindow(undefined);
      const res = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "element_at", x, y }).catch(() => null);
      return { content: [{ type: "text", text: JSON.stringify({ chain: Array.isArray(res?.chain) ? res.chain : [] }) }] };
    }
  );
  // The store window must stay the only Chromium toplevel on the instance (REMOTE_BROWSER_PLAN.md §(d)):
  // a popup or a new window opened by the page is closed through the instance's own compositor and the
  // store window refocused. Learns the store window when called with no id and exactly one window exists.
  // Reads the tree and issues kill/focus through HEADLESS_SWAYSOCK only; never the ambient SWAYSOCK.
  server.registerTool(
    "enforce_single_window",
    {
      title: "Close extra browser windows on the instance (manual sessions only)",
      description: "Read the instance compositor's window tree; close every Chromium toplevel other than the main window (store_con_id) and refocus it. With no store_con_id and exactly one window, that window is reported as the main one. Returns {available, windows, store, closed, focused, missing, learned, ambiguous}.",
      inputSchema: z.object({ store_con_id: z.number().int().positive().optional() }).strict(),
    },
    async ({ store_con_id }) => {
      const swaysock = process.env.HEADLESS_SWAYSOCK;
      if (!swaysock) return { content: [{ type: "text", text: JSON.stringify({ available: false, reason: "no HEADLESS_SWAYSOCK", windows: 0, store: store_con_id ?? null, closed: [], focused: false, missing: false }) }] };
      const env = { ...process.env, SWAYSOCK: swaysock };
      const result = await enforceSingleWindow({
        storeConId: store_con_id ?? null,
        query: async () => (await execFileP("swaymsg", ["-t", "get_tree"], { env })).stdout,
        swaymsg: async (args) => { await execFileP("swaymsg", args, { env }); },
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}

export function canonicalKey(key) {
  const KEY_ALIASES = {
    arrowdown: "Down", arrowup: "Up", arrowleft: "Left", arrowright: "Right",
    esc: "Escape", spacebar: "space", del: "Delete", enter: "Return",
    pagedown: "Next", page_down: "Next", "page-down": "Next",
    "-": "minus", hyphen: "minus", minus: "minus",
  };
  return KEY_ALIASES[String(key).toLowerCase()] || key;
}

// A COMBO WRITTEN AS ONE KEY ("Alt+Left", "ctrl+a"): the model writes it that way often enough (prod Amazon checkout 2026-10-06:
// key_press({key:"Alt+Left"}) -> wtype "Unknown key 'Alt+Left'", then four turns to get back to the product page) that the key is
// split into its modifiers here. A lone "+" or a key that only ends in "+" stays as it was.
const MODIFIER_NAMES = { shift: "shift", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", logo: "logo", super: "logo", meta: "logo", cmd: "logo", win: "logo", altgr: "altgr" };
export function splitKeyCombo(key, modifiers = []) {
  const parts = String(key).split("+");
  if (parts.length < 2 || !parts[parts.length - 1]) return { key, modifiers };
  const mods = parts.slice(0, -1).map((m) => MODIFIER_NAMES[m.trim().toLowerCase()]);
  if (mods.some((m) => !m)) return { key, modifiers };
  return { key: parts[parts.length - 1].trim(), modifiers: [...new Set([...modifiers, ...mods])] };
}

export function keyPressArgs(key, modifiers = []) {
  const args = ["-s", "100"];
  for (const m of modifiers) args.push("-M", m);
  args.push("-k", canonicalKey(key));
  for (const m of [...modifiers].reverse()) args.push("-m", m);
  return args;
}

server.registerTool(
  "list_windows",
  {
    title: "List open windows",
    description: "List all open windows with their address, class, title, pid, geometry, and focus state.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    const windows = await listWindows();
    return { content: [{ type: "text", text: JSON.stringify(windows, null, 2) }] };
  }
);

server.registerTool(
  "get_active_window",
  {
    title: "Get the active window",
    description: "Get the currently focused window's class, title, pid, and geometry.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    const win = await getActiveWindow();
    return { content: [{ type: "text", text: JSON.stringify(win, null, 2) }] };
  }
);

server.registerTool(
  "focus_window",
  {
    title: "Focus a window",
    description: "Focus a window by its Hyprland address (from list_windows).",
    inputSchema: z.object({ address: z.string() }).strict(),
  },
  async ({ address }) => {
    await focusWindowByAddress(address);
    return { content: [{ type: "text", text: `Focused ${address}` }] };
  }
);

server.registerTool(
  "get_active_workspace",
  {
    title: "Get the active workspace",
    description: "Returns the Hyprland workspace ID currently visible. Used to remember where to switch back to after isolating a window on another workspace.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    const id = await getActiveWorkspaceId();
    return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
  }
);

server.registerTool(
  "move_window_to_workspace",
  {
    title: "Move a window to a workspace",
    description:
      "Focuses the given window, moves it to the target workspace, and switches the active view to follow it. Used to isolate the automation's browser on its own workspace (away from windows the user is actively using — a shared workspace means the user's real mouse/keyboard and this tool's synthetic input can land on the same window), and to move it back afterward.",
    inputSchema: z.object({ address: z.string(), workspace: z.union([z.string(), z.number()]) }).strict(),
  },
  async ({ address, workspace }) => {
    await moveWindowToWorkspace(address, workspace);
    return { content: [{ type: "text", text: `Moved ${address} to workspace ${workspace} and switched to it.` }] };
  }
);

server.registerTool(
  "move_mouse",
  {
    title: "Move the mouse",
    description: "Move the real mouse cursor to absolute screen coordinates.",
    inputSchema: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
  },
  async ({ x, y }) => {
    await moveMouseRaw(x, y);
    return { content: [{ type: "text", text: `Moved to ${x},${y}` }] };
  }
);

server.registerTool(
  "click",
  {
    title: "Click the mouse (raw coordinates)",
    description:
      "Move to (x, y) and click a real mouse button there via the kernel input layer (uinput), like a physical mouse. " +
      "Prefer click_element for anything with an accessible name (buttons, links, fields) — it's exact and doesn't require knowing pixel coordinates. " +
      "Use this raw version for canvas/custom-drawn UI, or coordinates you got from a screenshot.",
    inputSchema: z.object({
      x: z.number().int(),
      y: z.number().int(),
      coordinate_space: z.enum(["screen", "screenshot_crop"]).default("screen"),
      screenshot_id: z.string().optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
      clicks: z.number().int().min(1).max(3).default(1).describe("1 = single click, 2 = double click"),
      // Accepted and unused: the pointer is this instance's own (headless: its compositor; desktop: the screen).
      // Headless callers stamp window_address on EVERY call; refusing it made every raw click from the gallery's
      // geo switch fail silently ("Unrecognized key"), so Gap's "Continue to Gap US" never ran (live 2026-10-07).
      window_address: z.string().optional(),
    }).strict(),
  },
  async ({ x, y, coordinate_space, screenshot_id, button, clicks }) => {
    if (coordinate_space === "screenshot_crop") {
      if (!latestScreenshotContext || screenshot_id !== latestScreenshotContext.id) return { content: [{ type: "text", text: "Refused click: screenshot_crop coordinates require the current screenshot_id from a cropped screenshot; context is absent or stale." }], isError: true };
      ({ x, y } = screenshotPointToScreen(latestScreenshotContext.region, x, y));
    } else if (screenshot_id) {
      return { content: [{ type: "text", text: "Refused click: screenshot_id is only valid with coordinate_space=\"screenshot_crop\"." }], isError: true };
    }
    await moveMouseRaw(x, y);
    await new Promise((r) => setTimeout(r, 30));
    await clickButton(button, clicks);
    return { content: [{ type: "text", text: `${button} click x${clicks} at ${x},${y}` }] };
  }
);

server.registerTool(
  "scroll",
  {
    title: "Scroll",
    description: "Move to (x, y) and scroll the mouse wheel there.",
    inputSchema: z.object({
      x: z.number().int(),
      y: z.number().int(),
      direction: z.enum(["up", "down"]).default("down"),
      amount: z.number().int().min(1).max(50).default(5).describe("Wheel steps"),
      window_address: z.string().optional(), // accepted and unused, as for click
    }).strict(),
  },
  async ({ x, y, direction, amount }) => {
    await moveMouseRaw(x, y);
    await new Promise((r) => setTimeout(r, 30));
    const delta = direction === "down" ? amount : -amount;
    if (AUTOMATION_BACKEND === "headless") {
      if (await headlessPointer.available()) await headlessPointer.scroll(delta);
      else await run("wlrctl", ["pointer", "scroll", String(delta * 10), "0"]);
    } else {
      await run("ydotool", ["mousemove", "-w", "-x", "0", "-y", String(delta)]);
    }
    return { content: [{ type: "text", text: `Scrolled ${direction} ${amount} at ${x},${y}` }] };
  }
);

server.registerTool(
  "type_text",
  {
    title: "Type text",
    description: "Type literal text via the Wayland virtual keyboard, exactly as a human typing would.",
    inputSchema: z.object({ text: z.string() }).strict(),
  },
  async ({ text }) => {
    // The persistent virtual keyboard, when it is up (headless manual sessions): every keystroke lands on
    // the SAME device, so per-character type_text calls accumulate in the store's input instead of each new
    // wtype device replacing the last one's keystroke (see the headlessKeyboard note). Best-effort: any error
    // falls back to wtype, so the customer never sees a failure the ordinary path would have handled.
    if (AUTOMATION_BACKEND === "headless" && (await headlessKeyboard.available())) {
      try { await headlessKeyboard.type(text); return { content: [{ type: "text", text: `Typed ${text.length} characters` }] }; }
      catch (error) { if (!keyFallbackAllowed(error, "type")) return { content: [{ type: "text", text: `The keyboard failed after the text may have been typed (${error?.code || "error"}); it was NOT typed again. Read the field before acting on it.` }] }; }
    }
    // -s 100: sleep before the first keystroke. Without this, the leading
    // character is intermittently dropped — the virtual-keyboard-protocol
    // binding isn't always ready the instant wtype starts, especially right
    // after a synthetic click/focus (e.g. ctrl+L on the address bar). Losing
    // "h" off "https://..." turns a URL into a search query, which is a much
    // worse failure than 100ms of latency.
    // -d 25 (was 12): see type_into_element — rapid pacing drops shifted
    // characters like "?" in mixed content, 404ing query-string URLs.
    await typeWithWtype(text, 25);
    return { content: [{ type: "text", text: `Typed ${text.length} characters` }] };
  }
);

server.registerTool(
  "key_press",
  {
    title: "Press a key or key combo",
    description:
      "Press a named key (e.g. Return, Tab, Escape, BackSpace, Left, Right, Up, Down, PageDown/Next, Home, End, Delete, minus) optionally with modifiers (shift, ctrl, alt, logo).",
    inputSchema: z.object({
      key: z.string(),
      modifiers: z.array(z.enum(["shift", "ctrl", "alt", "logo", "altgr", "capslock"])).default([]),
    }).strict(),
  },
  async ({ key, modifiers }) => keyPressAction({ key, modifiers })
);

// ONE KEY WITH NOTHING HELD (Return / Escape / Delete on the primary paths): on a headless instance through the persistent
// keyboard — no one-shot wtype device, so no keyboard comes and goes under Chromium (the xkb SIGSEGV mechanism, 66500ee: the
// instance's holder already keeps the capability up; this removes the device churn as well) — after the same 100 ms settle wtype's
// "-s 100" gave; on the real desktop, or on any helper failure, the wtype call exactly as before.
async function tapKey(key, { settle = true } = {}) {
  await sendWithFallback({
    available: async () => AUTOMATION_BACKEND === "headless" && (await headlessKeyboard.available()),
    viaHelper: async () => { if (settle) await new Promise((r) => setTimeout(r, 100)); await headlessKeyboard.key(canonicalKey(key), []); },
    viaWtype: () => run("wtype", settle ? ["-s", "100", "-k", key] : ["-k", key]),
    what: key,
  });
}
// The key_press body, with its dependencies injectable so the gate and the
// call counts are provable without a compositor or a browser.
//
// wtype/xkbcommon use old X11 keysym names (Down, Left, ...), not DOM
// KeyboardEvent.key names (ArrowDown, ArrowLeft, ...) -- the tool description
// says so, but a model reaches for the DOM name often enough (caught live:
// "ArrowDown" -> "Unknown key" failure) that it's worth just accepting both
// rather than relying on the prompt alone.
// -s 100: see type_text — a fresh/rapid wtype call right after a focus change
// can race the compositor's virtual-keyboard binding and drop the event
// entirely (not just garble it, for a single key press).
//
// THE GATE COMES FIRST AND COSTS NOTHING. Only a raw unmodified Return with a
// token actually armed can reach the observation; the check is an in-memory
// map size plus a string compare. Every other key, every modifier combination,
// and an unarmed Return take the original path unchanged: same wtype call, same
// returned text, no window resolution, no bridge call, no added await.
export async function keyPressAction(args, deps = {}) {
  const { key, modifiers = [] } = splitKeyCombo(args.key, args.modifiers || []);
  // The persistent virtual keyboard when it is up (headless manual sessions): the key lands on the SAME
  // device as typed text, and ctrl/shift/alt/logo combos ride its modifier state. Best-effort — an
  // unavailable helper, an unsupported modifier (altgr/capslock), or any error falls back to the wtype argv,
  // so the submit-token gate below and every other caller behave exactly as before when it is not up.
  const runKey = deps.runKey || (async (args) => {
    await sendWithFallback({
      available: async () => AUTOMATION_BACKEND === "headless" && (await headlessKeyboard.available()),
      viaHelper: () => headlessKeyboard.key(canonicalKey(key), modifiers),
      viaWtype: () => run("wtype", args),
      what: key,
    });
  });
  const store = deps.store || submitTokens;
  const resolveWin = deps.resolveWindow || (() => resolveWindow(undefined));
  const readUri = deps.readUri || readPageDocumentUri;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const emitDiagnostic = deps.emitDiagnostic || emitSubmitTransitionDiagnostic;
  const pressed = `Pressed ${[...modifiers, key].join("+")}`;

  // (a) Anything that is not a raw unmodified Return: this keystroke could
  // itself have changed the page anywhere, so no armed token still describes a
  // trustworthy baseline and every one of them is dropped.
  if (!isPlainReturn(canonicalKey(key), modifiers)) {
    store.invalidateAll();
    await runKey(keyPressArgs(key, modifiers));
    return { content: [{ type: "text", text: pressed }] };
  }
  // (b) A plain Return with nothing armed anywhere: the original path, byte for
  // byte. No window resolution, no bridge call, no added await, nothing to
  // invalidate.
  if (store.size === 0) {
    await runKey(keyPressArgs(key, modifiers));
    return { content: [{ type: "text", text: pressed }] };
  }
  let win = null;
  try { win = await resolveWin(); } catch { win = null; }
  const token = win ? store.take(tokenKey(win)) : null;
  // (c) Tokens exist, but not for the window this Return actually reaches (or
  // this window's token has expired). Press unchanged and observe nothing —
  // and leave the OTHER windows' tokens alone: a Return delivered elsewhere is
  // not evidence about their pages, and destroying their baselines here would
  // let unrelated desktop focus steal another window's evidence.
  if (!token) {
    await runKey(keyPressArgs(key, modifiers));
    return { content: [{ type: "text", text: pressed }] };
  }
  await runKey(keyPressArgs(key, modifiers));
  const observation = await observeSubmitTransition({
    baselineUri: token.baselineUri,
    readUri: () => readUri(win),
    sleep,
    now,
    // How long the baseline was held, measured by the STORE with its own clock
    // — never recomputed here against a different one. The token no longer
    // expires, so this age can be large; that is reported, not enforced.
    baselineAgeMs: token.ageMs ?? null,
  });
  // An observation was actually performed, so its spend is recorded. The
  // paths above return before here precisely because they observed nothing.
  // Wrapped even though the default sink swallows its own failures: the
  // emitter is injectable, and NO emitter may be able to fail a keystroke that
  // has already been delivered and classified.
  try { emitDiagnostic(observation); } catch { /* diagnostics never fail a tool */ }
  return { content: [{ type: "text", text: `${pressed}${formatSubmitTransitionNote(observation)}` }] };
}

// The DIRECT path's decision: a type_into_element that both typed and submitted
// observes inline, with no token, because its own pre-typing observation is
// right there. Returns null — and performs NO observation at all — for exactly
// the excluded shapes: an omnibox target (which keeps its separate
// navigation-focus handling) and a match that is not inside the page document.
// Exported so those exclusions and the single observation are provable without
// a compositor.
export async function observeInPageSubmitTransition({ omnibox, found, prevPage, win }, deps = {}) {
  if (omnibox || found?.in_doc !== true) return null;
  const readUri = deps.readUri || readPageDocumentUri;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const emitDiagnostic = deps.emitDiagnostic || emitSubmitTransitionDiagnostic;
  const observation = await observeSubmitTransition({
    baselineUri: prevPage?.state === "known" ? prevPage.uri : null,
    readUri: () => readUri(win),
    sleep,
    now,
    // null, not 0: this path captured its baseline earlier in the SAME call, so
    // there is no held-age to report. Zero would be a claim about elapsed time
    // nobody measured.
    baselineAgeMs: null,
  });
  // Same sink as the token path, and reached only past the exclusions above —
  // so the two ways of observing a submit produce one record each, and the
  // shapes that observe nothing produce none. Wrapped for the same reason as
  // the token path: an injected emitter must not be able to fail the tool.
  try { emitDiagnostic(observation); } catch { /* diagnostics never fail a tool */ }
  return observation;
}

// Dismiss ONE positively-identified modal with a single Escape.
//
// Escape is Chromium's stop-loading shortcut, so this is gated hard and is kept
// entirely separate from navigation recovery. It runs only against a settled
// page, one proven modal, and focus already in that page — and it NEVER
// manipulates focus to get there. The site and browser have established the
// modal context; grabbing focus, clicking or moving the pointer would change
// the state being reasoned about. Focus is observed, never touched.
async function dismissByEscape(win, dialogRef, { listRemaining = true } = {}) {
  const cached = snapshotCache.get(win.pid)?.get(dialogRef);
  if (!cached) {
    return { content: [{ type: "text", text: `Refused: ref ${dialogRef} is not in the current snapshot. Call read_page and use a fresh ref.` }], isError: true };
  }
  if (!cached.obj_path) {
    return { content: [{ type: "text", text: `Refused: ref ${dialogRef} has no stable object-path identity. Call read_page again and use a fresh ref.` }], isError: true };
  }
  const readContext = () => atspiBridge({
    pid: win.pid, action: "dialog_escape_context",
    obj_path: cached.obj_path, doc_gen: cached.doc_gen ?? null,
  }).catch(() => null);

  const what = `${dialogRef} "${cached.name}"`;
  // TWO observations, >=250ms apart, agreeing on the WHOLE gate — document
  // generation and URI, the target's identity and modality, the dialog count and
  // the content counts. A page still settling fails this rather than being acted
  // on.
  const first = await readContext();
  await new Promise((r) => setTimeout(r, 300));
  const second = await readContext();
  const gate = classifyEscapeTarget(second);
  if (!gate.eligible) {
    const why = ESCAPE_REFUSAL_TEXT[gate.reason] || gate.reason;
    return { content: [{ type: "text", text: `Refused: ${what} — ${why}. NOTHING was pressed.` }], isError: true };
  }
  if (!escapeObservationsAgree(first, second)) {
    return { content: [{ type: "text", text: `Refused: ${what} — ${ESCAPE_REFUSAL_TEXT.page_unsettled}. NOTHING was pressed.` }], isError: true };
  }
  // Re-check the gate IMMEDIATELY before the key: focus can move to the browser
  // between observing and acting, and an Escape landing on the omnibox is a
  // different act entirely.
  const justBefore = await readContext();
  const gate2 = classifyEscapeTarget(justBefore);
  if (!gate2.eligible) {
    const why = ESCAPE_REFUSAL_TEXT[gate2.reason] || gate2.reason;
    return { content: [{ type: "text", text: `Refused: ${what} — the situation changed immediately before the keypress (${why}). NOTHING was pressed.` }], isError: true };
  }
  // Eligible is NOT the same as unchanged. The URI, the document set, the
  // target's modality or the dialog count could all have moved since the settled
  // pair while still leaving something superficially eligible — which would mean
  // sending the key into a situation that was never proven settled.
  if (!escapeObservationsAgree(second, justBefore)) {
    return { content: [{ type: "text", text: `Refused: ${what} — the page changed between the settled observations and the keypress, so it was not proven settled at the moment of acting. NOTHING was pressed.` }], isError: true };
  }

  const before = justBefore.survey;
  const beforeDocGen = justBefore.target.doc_gen;
  if (INPUT_STATS_ENABLED) inputStats.escapes++;
  await tapKey("Escape");
  await new Promise((r) => setTimeout(r, 700));

  const afterSurvey = await atspiBridge({ pid: win.pid, action: "dialog_survey" }).catch(() => null);
  const probe = await atspiBridge({ pid: win.pid, action: "element_states", obj_path: cached.obj_path, doc_gen: cached.doc_gen ?? null }).catch(() => null);
  const target = classifyTargetState(probe);
  const docState = classifyDocumentState(beforeDocGen, afterSurvey?.page_docs);
  const outcome = classifyEscapeOutcome({
    escapesSent: 1, documentState: docState.state, targetState: target.state,
    before, after: afterSurvey,
  });

  // A DIFFERENT dialog may have appeared where the target was — measured live:
  // dismissing one consent overlay revealed a second one and left the page LESS
  // readable than before. "The dialog you named is gone" is true and, on its
  // own, misleading; the caller has to be told what is there now.
  // The read that lists OTHER dialogs (with refs) is skipped when the uncapped structural survey already counted
  // none, or when the caller goes straight on to the dialog's own close control (dismissByEscapeThenClose).
  const afterSnap = listRemaining && !(afterSurvey && afterSurvey.dialogs === 0) ? await snapshotWindow(win, { limit: 200, pageInfo: true }) : { elements: [] };
  const remaining = afterSnap.elements.filter((e) => e.dialog_root === true && e.doc_class === "page");
  const remainingCount = Math.max(afterSurvey?.dialogs ?? 0, remaining.length);
  const remainingNote = remainingCount
    ? ` ${remainingCount} dialog(s) are present NOW${remaining.length ? ": " + remaining.map((d) => `${d.ref ?? "(no ref)"} "${d.name}"`).join(", ") : ""} — a DIFFERENT overlay, not the one dismissed. It was NOT closed automatically; review it and call dismiss_dialog again if that is what you want.`
    : "";
  // Content going DOWN is a distinct and more alarming fact than content merely
  // not going up, and it must not be flattened into the same sentence.
  const dropped = before && afterSurvey && (afterSurvey.links < before.links || afterSurvey.content < before.content);

  const fmt = (s) => s ? `${s.links} links / ${s.content} content outside dialogs / ${s.dialogs} dialog(s)` : "unreadable";
  const evidence = `Before: ${fmt(before)}. After: ${fmt(afterSurvey)}. Document: ${docState.reason}. Target: ${target.reason}. Escapes sent: 1. Gate: ${gate2.reason} (modal=${justBefore.target.modal}, tag=${JSON.stringify(justBefore.target.tag)}, xml-roles=${JSON.stringify(justBefore.target.xml_roles)}).`;
  // What is known, and nothing beyond it. The tool cannot observe what the site
  // stored, so it says only what it did.
  const didNot = " This tool sent Escape and did NOT activate any Accept, Reject or Preferences control; what preference the site may have recorded internally is not observable here.";
  if (outcome.kind === "success") {
    const revealed = outcome.reason === "dismissed_and_content_revealed"
      ? " The page behind it is now readable."
      : dropped
        ? " WARNING: the page exposes LESS content than before, so something else is now covering it — do not treat the page as ready."
        : " Page readability did not measurably increase — the overlay was not what was hiding content.";
    return { content: [{ type: "text", text: `Dismissed ${what} with one Escape: that exact dialog is verifiably gone.${revealed} Escape was ATTEMPTED and the outcome VERIFIED — delivery is never guaranteed in advance.${didNot}${remainingNote} ${evidence}` }] };
  }
  // Gone, same document, nothing new readable: a cart drawer or side panel that was never hiding the page. The
  // dialog is verifiably closed — that is the job done, not an error (benchmark 2026-09-25: reported as an
  // error, a closed Gymshark minicart read as a failure to the agent).
  if (outcome.reason === "nothing_revealed") {
    return { content: [{ type: "text", text: `Dismissed ${what} with one Escape: that exact dialog is verifiably gone. It was not hiding the page (nothing new became readable).${didNot} ${evidence}` }] };
  }
  const msg = {
    dialog_still_present: `FAILED: sent one Escape, but ${what} is STILL present — this overlay does not respond to Escape. Nothing further was attempted; use dismiss_dialog with a control_ref if it exposes a close control.${didNot} ${evidence}`,
    nothing_revealed: `UNVERIFIED: ${what} is gone but nothing was revealed. ${evidence}`,
    document_navigated: `UNVERIFIED: after the Escape the page document was REPLACED, so the dialog's disappearance proves nothing about the keypress. ${evidence}`,
    document_identity_unverified: `UNVERIFIED: the page document could not be re-identified after the Escape. ${evidence}`,
    target_identity_unverified: `UNVERIFIED: ${what} could not be probed after the Escape, so it is unknown whether it closed. A failed probe is not a disappearance. ${evidence}`,
    escape_count_unexpected: `UNVERIFIED: the number of Escapes sent could not be established. ${evidence}`,
  }[outcome.reason] || `UNVERIFIED: ${outcome.reason}. ${evidence}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

// Activate ONE close control inside a dialog and verify the outcome from fresh reads (the dismiss_dialog
// control path). `cached` is {obj_path, doc_gen, role, name}; `expectedDialog` pins the dialog it must close.
async function dismissByControl(win, cached, control_ref, expectedDialog = null) {
  let res;
  try {
    res = await atspiBridge({ pid: win.pid, action: "dismiss_dialog", obj_path: cached.obj_path, doc_gen: cached.doc_gen ?? null, role_filter: cached.role, ...(expectedDialog ? { expected_dialog_obj_path: expectedDialog.obj_path, expected_dialog_doc_gen: expectedDialog.doc_gen ?? null } : {}) });
  } catch (e) {
    return { content: [{ type: "text", text: `dismiss_dialog failed: ${e.message}` }], isError: true };
  }
  // FIRST, before any refusal handling: the bridge reports the do_action calls
  // it ISSUED, and that is the number of record. It is mirrored into the tally
  // here rather than counted locally, so a test can never pass by agreeing
  // with a wrong local guess — and, critically, so a refusal that DID issue a
  // call (do_action raised) is neither dropped from the tally nor described as
  // "nothing was activated".
  const outcomeOfCall = classifyBridgeResult(res);
  const invocationCount = outcomeOfCall.invocationCount;
  if (INPUT_STATS_ENABLED && invocationCount) inputStats.nativeActions += invocationCount;
  const why = DISMISS_REFUSAL_TEXT[outcomeOfCall.reason] || outcomeOfCall.reason;
  const subject = `${control_ref} ${cached.role} "${cached.name}"`;
  if (outcomeOfCall.kind === "refused") {
    return { content: [{ type: "text", text: `Refused: ${subject} — ${why}. Nothing was activated.` }], isError: true };
  }
  if (outcomeOfCall.kind === "partial") {
    // The call went out and then failed. It MAY have applied. Saying nothing
    // happened would be false, and retrying could apply it twice.
    return { content: [{ type: "text", text: `UNVERIFIED: ${subject} — ${why}. ${invocationCount} action invocation(s) were ISSUED and then failed, so the action MAY have partially applied. Nothing was retried and no fallback was attempted; call read_page to see the current state.` }], isError: true };
  }
  if (outcomeOfCall.kind !== "acted") {
    return { content: [{ type: "text", text: `UNVERIFIED: ${subject} — ${why}. It cannot be established what the bridge did, so nothing is claimed about the page.` }], isError: true };
  }

  // FRESH measurements for the postcondition — never the pre-action snapshot.
  await new Promise((r) => setTimeout(r, 600));
  // AFTER is taken with the SAME instrument as BEFORE (the bridge's structural
  // survey), so the two numbers are commensurable.
  const afterSurvey = await atspiBridge({ pid: win.pid, action: "dialog_survey" }).catch(() => null);
  // The target dialog's own identity: present, provably gone, or unknown.
  const probe = await atspiBridge({ pid: win.pid, action: "element_states", obj_path: res.before.dialog.obj_path, doc_gen: res.before.dialog.doc_gen })
    .catch(() => null);

  const target = classifyTargetState(probe);
  const docState = classifyDocumentState(res.before.page_doc_gen, afterSurvey?.page_docs);
  const beforeCounts = res.before.survey;
  const outcome = classifyDismissOutcome({
    invoked: true, invocationCount, targetState: target.state,
    documentState: docState.state, before: beforeCounts, after: afterSurvey,
  });

  // Remaining dialogs come from a FRESH snapshot so their refs are usable.
  // They are identified by the dialog_root marker the bridge stamps
  // structurally, never by filtering on role text: a dialog root with no
  // accessible name, or one whose ARIA role a build declines to map, still
  // carries the mark — and that is exactly the modal most likely to be the
  // thing hiding the page.
  // Skipped when the uncapped survey counted no dialogs: it could not list one the survey missed.
  const after = afterSurvey && afterSurvey.dialogs === 0 ? { elements: [] } : await snapshotWindow(win, { limit: 200, pageInfo: true });
  const remaining = after.elements.filter((e) => e.dialog_root === true && e.doc_class === "page");
  const surveyDialogs = afterSurvey?.dialogs;
  // If the structural walk sees more modals than the capped snapshot could
  // hand back refs for, SAY SO rather than presenting a short list as complete.
  const shortfall = typeof surveyDialogs === "number" && surveyDialogs > remaining.length
    ? ` (${surveyDialogs} dialog(s) counted structurally; ${remaining.length} addressable in this read — call read_page for the rest)`
    : "";
  const remainingCount = Math.max(surveyDialogs ?? 0, remaining.length);
  const remainingNote = remainingCount
    ? ` ${remainingCount} dialog(s) still present${remaining.length ? ": " + remaining.map((d) => `${d.ref ?? "(no ref)"} "${d.name}"`).join(", ") : ""}${shortfall} — NOT closed automatically; review the page and call dismiss_dialog again if that is what you want.`
    : "";

  const fmt = (s) => s ? `${s.links} links / ${s.content} content outside dialogs / ${s.dialogs} dialog(s)` : "unreadable";
  const evidence = `Before: ${fmt(beforeCounts)}. After: ${fmt(afterSurvey)}. Document: ${docState.reason}. Target: ${target.reason}. do_action calls: ${invocationCount}.`;

  if (outcome.kind === "success") {
    return { content: [{ type: "text", text: `Closed dialog "${res.before.dialog.name}" via AT-SPI '${res.invoked_name}'. It is gone and the page behind it is now readable. ${evidence}${remainingNote}` }] };
  }
  if (outcome.reason === "nothing_revealed") {
    return { content: [{ type: "text", text: `Closed dialog "${res.before.dialog.name}" via AT-SPI '${res.invoked_name}'. It is verifiably gone; it was not hiding the page (nothing new became readable). ${evidence}${remainingNote}` }] };
  }
  const msg = {
    document_navigated: `UNVERIFIED: activating '${res.invoked_name}' was followed by the page document being REPLACED (a navigation or a reload — the URL alone would not show it), so the dialog's disappearance proves nothing about it being dismissed. ${evidence}`,
    document_identity_unverified: `UNVERIFIED: the page document could not be re-identified after activating '${res.invoked_name}', so nothing about the dialog's disappearance can be attributed to it. ${evidence}`,
    dialog_still_present: `FAILED: activated '${res.invoked_name}' on ${subject}, but dialog "${res.before.dialog.name}" is STILL present. do_action returned ${res.do_action_returned}, which is not proof. ${evidence}`,
    target_identity_unverified: `UNVERIFIED: the dialog's identity could not be probed after activating '${res.invoked_name}', so it is unknown whether it closed. A failed probe is not a disappearance. ${evidence}`,
    nothing_revealed: `UNVERIFIED: dialog "${res.before.dialog.name}" is gone after '${res.invoked_name}', but no page content was revealed, so it was not what was hiding the page. ${evidence}${remainingNote}`,
    invocation_count_unexpected: `UNVERIFIED: the bridge reported ${invocationCount} action invocations, not exactly 1. ${evidence}`,
  }[outcome.reason] || `UNVERIFIED: ${outcome.reason}. ${evidence}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

// What a person does when Escape does nothing: press the popup's own close (X) button. Only a control the
// bridge proves is a close affordance inside THAT dialog (deny terms first — never Accept/Subscribe/…).
async function dismissByEscapeThenClose(win, dialogRef) {
  const dlg = snapshotCache.get(win.pid)?.get(dialogRef);
  const escaped = await dismissByEscape(win, dialogRef, { listRemaining: false });
  const said = escaped.content?.[0]?.text || "";
  // Escape tried and ignored, or refused because nothing proves where it would land (a non-modal "My offers"
  // panel on live Gap, 2026-09-25) — both leave the popup's own close button. A stale ref does not.
  const escapeLeftIt = /^FAILED: sent one Escape/.test(said) || (/^Refused: /.test(said) && /NOTHING was pressed/.test(said) && !/not in the current snapshot|object-path identity|no longer identifies/.test(said));
  if (!escaped.isError || !dlg?.obj_path || !escapeLeftIt) return escaped;
  const found = await atspiBridge({ pid: win.pid, action: "dialog_close_controls", obj_path: dlg.obj_path, doc_gen: dlg.doc_gen ?? null }).catch(() => null);
  const control = found?.controls?.[0];
  if (!control) return escaped;
  const closed = await dismissByControl(win, control, "(its close control)", { obj_path: dlg.obj_path, doc_gen: dlg.doc_gen ?? null });
  return { ...closed, content: [{ type: "text", text: `Escape did not close ${dialogRef} "${dlg.name}", so its own close control "${control.name}" was pressed. ${closed.content?.[0]?.text || ""}` }] };
}

// ONE ESCAPE FOR THE PAGE: the simplest way to clear an overlay is pressing Escape once the page has loaded.
// The key goes to the store's own document: focus in the browser's UI (the omnibox popup) is moved to the page document
// with grab_focus first — never a click, so nothing on the page acts. Never while a field or a choice has focus (a
// search box, a select/listbox mid-choice, a checkout field: Escape there clears or cancels the shopper's input).
// Escape is also Chromium's stop-loading key, so callers send it only once the page has loaded.
const ESCAPE_BLOCKING_ROLES = new Set(["entry", "password text", "combo box", "list box", "list", "menu", "menu item", "option", "list item", "spin button", "text", "slider", "check menu item", "radio menu item", "tree", "tree item"]);
export function escapePageGate(focused) {
  const docClass = !focused ? "none" : focused.in_doc === false ? "chrome" : (focused.doc_class || "unknown");
  if (docClass !== "page") return { ok: false, reason: `focus is not in the page (${docClass})`, docClass };
  if (ESCAPE_BLOCKING_ROLES.has(String(focused.role || ""))) return { ok: false, reason: `a ${focused.role} has focus (Escape would clear or cancel it)`, docClass };
  return { ok: true, docClass };
}
server.registerTool(
  "escape_page",
  {
    title: "Press Escape once for the page (store pop-ups)",
    description: "Send ONE Escape to the page document, after the page has loaded: focus in browser UI is first given to the page document (no click). Refused, with nothing pressed, when a field, a list or a choice has focus. Returns {sent, focus_before, focus, reason}. Verify with a read afterwards; this never claims a pop-up closed.",
    inputSchema: z.object({
      window_address: z.string().optional(),
      // Only for the one Escape right after a page loads: a store that autofocuses its search box would otherwise block it,
      // and nothing the shopper or agent typed can be in that field yet. Focus is moved to the document (no click) first.
      move_from_field: z.boolean().default(false),
    }).strict(),
  },
  async ({ window_address, move_from_field }) => {
    const win = await resolveWindow(window_address);
    const where = async () => (await atspiBridge({ pid: win.pid, action: "navigation_focus" }).catch(() => null))?.focused ?? null;
    const before = await where();
    let focused = before;
    const g0 = escapePageGate(focused);
    if (g0.docClass !== "page" || (move_from_field && !g0.ok)) {
      await atspiBridge({ pid: win.pid, action: "focus_page_document" }).catch(() => null);
      focused = await where();
    }
    const gate = escapePageGate(focused);
    const desc = (f) => (f ? `${f.role || "?"}${f.name ? ` "${String(f.name).slice(0, 40)}"` : ""} (${escapePageGate(f).docClass})` : "none");
    if (!gate.ok) return { content: [{ type: "text", text: JSON.stringify({ sent: false, reason: gate.reason, focus_before: desc(before), focus: desc(focused) }) }] };
    if (INPUT_STATS_ENABLED) inputStats.escapes++;
    await tapKey("Escape");
    await new Promise((r) => setTimeout(r, 500));
    return { content: [{ type: "text", text: JSON.stringify({ sent: true, focus_before: desc(before), focus: desc(focused) }) }] };
  }
);

server.registerTool(
  "dismiss_dialog",
  {
    title: "Close a dialog that is hiding the page (verified)",
    description:
      "Close ONE dialog that is covering the page. A consent or promo overlay can hide the entire page from the " +
      "accessibility tree, so read_page shows almost nothing while the site renders normally.\n" +
      "TRY dialog_ref FIRST for cookie, sale and promotional overlays: pass the ref of the DIALOG ITSELF (a row " +
      "marked DIALOG-ROOT) and it sends ONE Escape, then verifies whether that exact dialog actually closed. " +
      "Some overlays respond to Escape and some ignore it — the result tells you which, and never assumes. " +
      "Worth trying first because a consent banner may expose NO close button at all, only Accept/Reject/" +
      "Preferences.\n" +
      "FALL BACK in a SEPARATE CALL to control_ref when Escape is unavailable or fails verification: pass a close/dismiss control " +
      "INSIDE the dialog and its own action is invoked.\n" +
      "If dialog_ref or dialog_text is supplied, the Escape path always wins even when control_ref is also present; " +
      "this prevents callers from accidentally skipping the safe first attempt. Either way this tool ONLY closes. It refuses any control that makes a substantive choice (Accept, Reject, " +
      "Preferences, Subscribe and similar), because those decide something on the user's behalf — use click_element " +
      "if such a choice is genuinely intended. At most one action or one keypress, never a coordinate click, never " +
      "a change of keyboard focus, and the outcome is verified from a fresh read. If another dialog remains it is " +
      "reported with its ref rather than closed automatically.",
    inputSchema: z.object({
      dialog_ref: z.string().optional().describe(
        "PREFERRED for cookie, sale and promotional overlays: ref of the DIALOG ITSELF (a row marked " +
        "DIALOG-ROOT in read_page). Sends ONE Escape and verifies whether that exact dialog actually closed. " +
        "Worth trying first: a consent banner may expose no close button at all, only Accept/Reject/" +
        "Preferences. Some overlays respond to Escape and some ignore it — the result tells you which."),
      dialog_text: z.string().min(1).optional().describe(
        "For a dynamic dialog, pass this with dialog_ref as a stale-identity fallback, or alone when no ref survives. The exact ref is tried first; text refresh occurs only after a stale-identity refusal and must resolve exactly one dialog."),
      control_ref: z.string().optional().describe(
        "FALLBACK: ref of a close/dismiss control INSIDE the dialog. Use when Escape is unavailable or " +
        "fails verification. Activates that control's own action. May be combined with dialog_ref/dialog_text; " +
        "the dialog identity still selects the Escape-first path; use control_ref alone on the separate fallback call."),
      window_address: z.string().optional().describe("Hyprland window address; defaults to the active window."),
    }).strict(),
  },
  async ({ dialog_ref, dialog_text, control_ref, window_address }) => {
    dialog_ref = dialog_ref?.trim() || undefined;
    dialog_text = dialog_text?.trim() || undefined;
    control_ref = control_ref?.trim() || undefined;
    if (!control_ref && !dialog_ref && !dialog_text) return { content: [{ type: "text", text: "Refused: pass dialog_ref/dialog_text or control_ref." }], isError: true };
    const win = await resolveWindow(window_address);
    if (dialog_ref) {
      const exact = await dismissByEscapeThenClose(win, dialog_ref);
      if (!exact.isError || !/not in the current snapshot|no stable object-path identity|no longer identifies a live element/.test(exact.content?.[0]?.text || "")) return exact;
      dialog_ref = undefined;
    }
    if (dialog_text && !dialog_ref) {
      const fresh = await snapshotWindow(win, { textFilter: dialog_text, roleFilter: "dialog", limit: 10, pageInfo: true });
      if (fresh.elements.length !== 1) return { content: [{ type: "text", text: `Refused: dialog_text ${JSON.stringify(dialog_text)} matched ${fresh.elements.length} dialogs; exactly one is required. NOTHING was pressed.` }], isError: true };
      dialog_ref = fresh.elements[0].ref;
    }
    if (dialog_ref) return await dismissByEscapeThenClose(win, dialog_ref);
    const cached = snapshotCache.get(win.pid)?.get(control_ref);
    if (!cached) {
      return { content: [{ type: "text", text: `Refused: ref ${control_ref} is not in the current snapshot. Call read_page and use a fresh ref.` }], isError: true };
    }
    if (!cached.obj_path) {
      return { content: [{ type: "text", text: `Refused: ref ${control_ref} has no stable object-path identity (it may predate the latest read_page). Call read_page again and use a fresh ref.` }], isError: true };
    }
    return await dismissByControl(win, cached, control_ref);
  }
);

// Pure (tested): what a dropdown's read-back says about a choice. "verified"
// when its selected option (or, failing that, its displayed value) is the one
// chosen; "contradicted" when it reports a different option; else "unknown".
export function selectionReadBack(optionText, readBack) {
  const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(optionText);
  const same = (v) => { const got = norm(v); return !!got && !!want && (got === want || (want.length >= 2 && got.includes(want))); };
  if (!readBack || readBack.error) return { kind: "unknown", evidence: "" };
  if (readBack.selected != null && norm(readBack.selected)) {
    return same(readBack.selected)
      ? { kind: "verified", evidence: `the dropdown reports "${readBack.selected}" selected` }
      : { kind: "contradicted", evidence: `the dropdown reports "${readBack.selected}" selected` };
  }
  if (same(readBack.shown)) return { kind: "verified", evidence: `the dropdown displays "${readBack.shown}"` };
  return { kind: "unknown", evidence: readBack.shown ? `it displays "${String(readBack.shown).slice(0, 60)}"` : "" };
}

// Chromium marks the page document BUSY until it has loaded, and meanwhile the
// accessibility tree can be a stale part of the page: live Coach bag behind the
// US exit, 50 rows ending at the order total for ~30 s after launch, then 237
// rows (with "Proceed to Checkout") the moment BUSY cleared. The agent read the
// partial tree as the page and went hunting with screenshots.
export const PAGE_LOADING_WAIT_MS = 10000;
const EMPTY_PAGE_WAIT_MS = Number(process.env.COMPUTER_USE_EMPTY_PAGE_WAIT_MS ?? 8000);
// pid → the window title whose placeholder was already given focus: one grab per page (navigation), never a loop
const placeholderFocusDone = new Map();
export const PAGE_LOADING_NOTE = "[page still loading (the browser reports this page busy): this list can be missing controls further down the page. Wait a few seconds and read again before concluding something is absent — do not switch to screenshots or coordinates for it]\n";

// The read_page handler, kept so a click that changed the page can return the same read (observeAfterClick).
let readPageHandler = null;
server.registerTool(
  "read_page",
  {
    title: "Read the page/window structure (fast, cheap)",
    description:
      "The default way to see what's on screen. Reads the live accessibility tree (same API screen readers use) for the focused window " +
      "(or a given window_address) and returns every interactive element (buttons, links, fields, checkboxes, etc.) with its exact " +
      "screen coordinates and a short ref like 'e3'. Costs a few hundred tokens, not an image. Use filter_text/filter_role to narrow a " +
      "busy page. Follow up with click_element/type_into_element using the ref. Only fall back to screenshot if you need to see something " +
      "visual (an image, canvas, layout) that has no accessible representation.",
    inputSchema: z.object({
      window_address: z.string().optional().describe("Defaults to the currently focused window."),
      filter_text: z.string().optional().describe("Only return elements whose accessible name contains this (case-insensitive)."),
      filter_role: z
        .string()
        .optional()
        .describe("Only return elements of this role (several with |, e.g. 'entry|combo box' — one walk of the page), e.g. 'button', 'link', 'entry', 'heading', 'image', 'dialog' (popups/cookie banners/size sheets show up as 'dialog' — filter on it to read what the open popup contains: each dialog row, marked DIALOG-ROOT, followed by its buttons, options and list items)."),
      include_text: z
        .boolean()
        .default(false)
        .describe("Also include static text/paragraphs/headings for reading page content, not just interactive elements."),
      limit: z.number().int().min(1).max(500).default(80),
      start_at_ref: z.string().optional().describe("Read from this ref (from the previous read_page) onward, in page order — e.g. a product's heading, to read a buy box that sits past the row limit."),
      filter_state: z
        .enum(["checked", "pressed", "selected", "focused", "expanded", "disabled"])
        .optional()
        .describe(
          "Only return elements that REPORT this state — e.g. filter_state 'pressed' finds the currently " +
          "chosen option in a variant picker. Combines with filter_text/filter_role: an element must match " +
          "ALL filters given. This can only express the PRESENCE of a state: there is no way to ask for " +
          "'not checked', because an unchecked control and one that never exposes the state at all look " +
          "identical here."),
    }).strict(),
  },
  readPageHandler = async ({ window_address, filter_text, filter_role, filter_state, include_text, limit, start_at_ref }) => {
    const roleError = validateRole(filter_role);
    if (roleError) return { content: [{ type: "text", text: roleError }], isError: true };
    const win = await resolveWindow(window_address);
    // START AT A REF (2026-09-29, variant reader): read from that element onward, in page order — a product's buy
    // box past the first 500 rows (live YETI). A part of the page, like a filtered read: never judged as an empty page.
    let startPath = null;
    if (start_at_ref) {
      startPath = snapshotCache.get(win.pid)?.get(start_at_ref)?.obj_path || null;
      if (!startPath) return { content: [{ type: "text", text: `ref "${start_at_ref}" is not in the last read_page snapshot (or has no stable identity). Call read_page again and use a fresh ref.` }], isError: true };
    }
    const partial = !!(filter_text || filter_role || filter_state || startPath);
    const readSnapshot = () => snapshotWindow(win, {
      textFilter: filter_text,
      roleFilter: filter_role,
      stateFilter: filter_state,
      includeText: include_text,
      limit,
      pageInfo: true,
      // The agent reading "dialog" wants the popup's contents, not just its
      // root row; internal dialog COUNTS (captureSignals) keep roots only.
      dialogContents: filter_role === "dialog",
      // The agent's own reads treat a button and a link as one role (live Nordstrom's "Check Out" link).
      looseRoles: true,
      startPath,
    });
    let snap = await readSnapshot();
    if (startPath && snap.anchor_found === false) {
      return { content: [{ type: "text", text: `ref "${start_at_ref}" is no longer on the page (it re-rendered). Call read_page again and use a fresh ref.` }], isError: true };
    }
    // A busy page gets a short bounded wait: a read that comes back complete
    // costs seconds, a partial one costs the agent turns.
    // A page whose content has stopped changing is read as it is, even while the browser still reports it loading
    // (third-party scripts keep a store page "busy" for many seconds: live Alo under an 8-store load, 17.8 s for
    // the first read): two consecutive reads with the same substantial page content end the wait.
    for (let waited = 0, lastCount = -1; snap.page?.busy && waited < PAGE_LOADING_WAIT_MS; waited += 1000) {
      const count = snap.elements.filter((e) => e.in_doc).length;
      // A FILTERED read (a drawer read as "dialog", one control looked up) asks about a part of the page: it is
      // settled once it holds anything and holds still (live Owala: six drawer reads each waited out the full timer,
      // 25 s for "Add to cart").
      const enough = partial ? 1 : 80;
      if (count >= enough && count === lastCount) break;
      // …and a read CUT BY ITS OWN LIMIT (it already holds all it asked for) that holds still is settled too (live Gymshark
      // 2026-10-03: a 5-row "where am I" read waited the full PAGE_LOADING_WAIT_MS on every navigation of a busy page — 13–20 s
      // for 5 rows; the limit counts browser rows, so its page rows can never reach 80)
      const cutByLimit = Number.isFinite(Number(limit)) && snap.elements.length >= Number(limit);
      if (cutByLimit && count === lastCount) break;
      lastCount = count;
      await new Promise((r) => setTimeout(r, 1000));
      snap = await readSnapshot();
    }

    // READ-TIME RECOVERY. If this read came back with no page content at all
    // while the browser's own UI holds keyboard focus, the omnibox dropdown is
    // very likely swallowing the page: the tree exposes nothing, which reads
    // exactly like a dead site. One Escape fixes that — but Escape is also
    // Chromium's stop-loading shortcut, so it is only sent on POSITIVE evidence
    // that a navigation this harness started has already completed, and the
    // evidence is spent BEFORE the keystroke so it can never be reused.
    let recoveryNote = "";
    let recoveryFailed = false;
    // A FILTERED read returning nothing means the filter matched nothing — it is
    // not evidence that the page is empty, and treating it as such would both
    // misjudge the page and make every filtered read pay for a focus query.
    // Recovery is therefore considered only for an unfiltered read.
    // A CAPPED read is not evidence of emptiness either: `limit` truncates the
    // snapshot, so a read_page(limit:1) on a rich page returns one element and
    // would look empty. Emptiness only counts when the collection was not cut
    // short — i.e. it returned fewer elements than the cap.
    const capped = snap.elements.length >= (limit || 150);
    // filter_state belongs in this guard for the same reason as the others: a
    // state-filtered read returning nothing means NO CONTROL REPORTS THAT STATE,
    // which is not evidence the page is empty. Without it, asking for the
    // pressed option on a page where nothing is selected yet would look like a
    // dead page and could license an Escape.
    if (!partial && !capped) {
      const pageEntries = (els) => els.filter((e) => e.doc_class === "page");
      const contentOf = (els) => pageEntries(els).filter((e) => CONTENT_ROLES.has(e.role)).length;
      // TEST-ONLY (gated): the "browser UI holds focus" state is not
      // reproducible in a fixture — the omnibox never reports STATE_FOCUSED —
      // so only the focus CLASSIFICATION is overridden here. The page URI,
      // content counts, token state, the Escape itself and everything after it
      // stay real, so the recovery being tested is the real one.
      const focusFault = process.env.COMPUTER_USE_TEST_READ_FOCUS;
      let observeCalls = 0;
      const observe = async (s) => {
        let nav = await atspiBridge({ pid: win.pid, action: "navigation_focus" }).catch(() => null);
        observeCalls++;
        if (focusFault && nav) {
          const popup = { role: "combo box", name: "Ask AI Mode", doc_uri: "chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html", doc_class: "browser_internal" };
          if (focusFault === "internal") nav = { ...nav, focused: popup, doc_class: "browser_internal", doc_uri: popup.doc_uri };
          else if (focusFault === "internal_until_escape" && observeCalls <= 2) nav = { ...nav, focused: popup, doc_class: "browser_internal", doc_uri: popup.doc_uri };
          else if (focusFault === "none") nav = { ...nav, focused: null, doc_class: "none", doc_uri: null };
          else if (focusFault === "unknown") nav = { ...nav, focused: { role: "section", name: "", doc_uri: null, doc_class: "unknown" }, doc_class: "unknown", doc_uri: null };
        }
        return { nav, pageUri: nav?.page_document_uri ?? null, signature: contentSignature(pageEntries(s.elements)) };
      };
      // A page with no content yet is usually still building its tree (live
      // Sephora /checkout under an 8-store load: one empty read, the agent
      // reported "store unavailable"; the next read had the whole form). A
      // bounded wait first, as a person waits for a page to appear.
      // Not when the browser's own UI holds focus: that is the omnibox case below.
      // Cheapest possible gate first: an unfiltered read that DID return content
      // needs no focus query at all, so the common path costs nothing extra.
      let first = contentOf(snap.elements) === 0 ? await observe(snap) : null;
      if (first && first.nav?.doc_class !== "browser_internal") {
        // CHROMIUM'S EMPTY PLACEHOLDER (live Coach bag 2026-10-04): the page's accessibility document stays empty — no URI, no
        // children — while the page's scripts hang on a proxy connect (33 s there, the page painted the whole time; through the US exit
        // that was IPv6 blackholing, fixed in the exit config 2026-10-04). Once per read, that placeholder is re-focused (AT-SPI
        // grab_focus, never a click or a key), which fills it, and the wait below reads again.
        // Guardrails (lead 2026-10-04): our own headless instances only; ONCE per document per window (never a loop); the bridge
        // acts only on the exact placeholder of a window that already names a page, with focus not inside a populated document.
        if (AUTOMATION_BACKEND === "headless") {
          const phAt = Date.now();
          const ph = await atspiBridge({ pid: win.pid, action: "focus_placeholder_document", headless: true, skip_title: placeholderFocusDone.get(win.pid) ?? null }).catch(() => null);
          if (ph?.grabbed) placeholderFocusDone.set(win.pid, ph.title || "");
          if (ph?.placeholder && ph.grabbed) {
            // ≤ 2 s for the page's tree; still empty → the old path below, unchanged
            for (let k = 0; k < 4 && contentOf(snap.elements) === 0; k++) { await new Promise((r) => setTimeout(r, 500)); snap = await readSnapshot(); }
            console.error(`[a11y] empty page document "${String(ph.title || "").slice(0, 60)}": focus given to the page → ${contentOf(snap.elements) > 0 ? `content after ${Date.now() - phAt} ms` : "still empty after 2 s (the old answer stands)"}`);
          } else if (ph?.placeholder) console.error(`[a11y] empty page document: focus NOT given (${ph.why || "grab_focus refused"})`);
        }
        for (let waited = 0; contentOf(snap.elements) === 0 && waited < EMPTY_PAGE_WAIT_MS; waited += 1000) {
          await new Promise((r) => setTimeout(r, 1000));
          snap = await readSnapshot();
        }
        if (contentOf(snap.elements) > 0) first = null;
      }
      if (first && first.nav?.doc_class !== "browser_internal") {
        // An unfiltered read that came back with NOTHING is worth explaining even
        // when recovery is not applicable — otherwise the caller sees an empty
        // page and no reason for it, which is the failure mode this whole line of
        // work exists to remove. Nothing is pressed.
        const d = shouldAttemptRecovery({
          pageContentCount: 0, focusDocClass: first.nav?.doc_class ?? "none",
          pageUri: first.pageUri, token: getToken(win), observations: [first, first],
        });
        recoveryNote = `[this page exposes no content. No Escape was sent: ${REFUSAL_TEXT[d.reason] || d.reason}. focus ${first.nav?.focused ? `${first.nav.focused.role} "${first.nav.focused.name}"` : "none"} in ${first.nav?.doc_uri ?? "(no document)"}; page ${first.pageUri ?? "(no uri)"}]\n`;
      } else if (first && first.nav?.doc_class === "browser_internal") {
        await new Promise((r) => setTimeout(r, 400));
        const snap2 = await readSnapshot();
        const second = await observe(snap2);
        // Resolving a pending token is an OBSERVATION, not an action, so the
        // read path may do it too. This matters: at navigation time the page has
        // often not committed yet (no URI to compare), and without this the
        // token would stay pending forever — refusing recovery in exactly the
        // case it exists for. A stale in-flight document keeps the OLD uri, so
        // this can never resolve early.
        if (second.pageUri) resolveTokenIfNavigated(win, second.pageUri);
        const decision = shouldAttemptRecovery({
          pageContentCount: contentOf(snap2.elements),
          focusDocClass: second.nav?.doc_class ?? "none",
          pageUri: second.pageUri,
          token: getToken(win),
          observations: [first, second],
        });
        const beforeEvidence = `focus ${second.nav?.focused ? `${second.nav.focused.role} "${second.nav.focused.name}"` : "none"} in ${second.nav?.doc_uri ?? "(no document)"}; page ${second.pageUri ?? "(no uri)"} exposing no content`;
        if (decision.act) {
          // SPEND THE EVIDENCE FIRST. Consuming before the keystroke means a
          // failure, an exception, or a second read can never spend it again —
          // "exactly one Escape" holds across operations, not just within one.
          consumeToken(win, "read-time recovery");
          if (INPUT_STATS_ENABLED) inputStats.escapes++;
          await tapKey("Escape");
          const deadline = Date.now() + 2000;
          let after = null;
          do {
            await new Promise((r) => setTimeout(r, 250));
            snap = await readSnapshot();
            after = await observe(snap);
          } while (!(after.nav?.doc_class === "page" && contentOf(snap.elements) > 0) && Date.now() < deadline);
          if (after.nav?.doc_class === "page" && contentOf(snap.elements) > 0) {
            recoveryNote = `[recovered: the browser's own UI held keyboard focus and this page exposed nothing; one Escape returned focus to the page, which now exposes ${contentOf(snap.elements)} content elements. Before: ${beforeEvidence}]\n`;
          } else {
            recoveryFailed = true;
            recoveryNote = `[RECOVERY FAILED — the page is NOT confirmed readable. Before: ${beforeEvidence}. After one Escape: focus ${after?.nav?.focused ? `${after.nav.focused.role} in ${after.nav.doc_uri}` : "none"}, page exposing ${contentOf(snap.elements)} content elements. Nothing further was attempted.]\n`;
          }
        } else {
          recoveryNote = `[this page exposes no content and the browser's own UI holds keyboard focus, so its accessibility tree may be unreadable. No Escape was sent: ${REFUSAL_TEXT[decision.reason] || decision.reason}. ${beforeEvidence}]\n`;
          snap = snap2;
        }
      }
    }
    await recordVisit(win, snap.elements, snap.page).catch(() => {});
    const domain = snap.page?.url ? domainFromUrl(snap.page.url) : null;
    let knownHint = "";
    // COMPUTER_USE_SITE_MEMORY=off: a first-time visitor sees NO hint at all — the visit is still recorded above.
    // COMPUTER_USE_SITE_BRIEF=1: the caller's task already carries the site's notes, so the per-read hint drops the
    // free-text notes that would otherwise be repeated on every read; the one-line search-route hint stays.
    if (domain && process.env.COMPUTER_USE_SITE_MEMORY !== "off") {
      // A plugin's site-memory backend answers first (its record may be newer than the JSON snapshot).
      let map = null;
      if (siteMemoryBackend?.hint) { try { map = await siteMemoryBackend.hint(domain); } catch { map = null; } }
      if (!map) map = await loadSiteMap(domain).catch(() => null);
      if (map && map.visitCount > 1) {
        const withNotes = process.env.COMPUTER_USE_SITE_BRIEF !== "1" && Array.isArray(map.notes) && map.notes.length;
        knownHint = `[site memory: visited ${map.visitCount}x before` +
          (map.searchUrlPattern ? `, known search URL pattern: ${map.searchUrlPattern}` : "") +
          (withNotes ? `, notes: ${map.notes.join("; ")}` : "") +
          ` — call get_site_map for full known nav/fields]\n`;
      }
    }
    // The title is the PAGE-CONTROLLED window title; the [page-url:] marker is
    // the only server-attested URL statement and is never derived from it.
    const urlMarker = formatPageUrlMarker(snap.page?.url);
    const header = snap.page?.title || snap.page?.url ? `# ${sanitizeInline(snap.page.title || "")}${snap.page.url ? ` (${sanitizeInline(snap.page.url)})` : ""}\n` : "";
    return {
      content: [{ type: "text", text: recoveryNote + knownHint + urlMarker + (snap.page?.busy ? PAGE_LOADING_NOTE : "") + header + formatElements(snap.elements) }],
      ...(recoveryFailed ? { isError: true } : {}),
    };
  }
);

server.registerTool(
  "get_site_map",
  {
    title: "Get accumulated knowledge about a site",
    description:
      "Return everything learned about a domain from past visits (this session or previous ones): known nav links, known form " +
      "fields (search box, login, etc.), and any manually-saved search URL pattern / login URL / notes. Call this before exploring a " +
      "site you've likely visited before — it can save a full read_page round-trip. Defaults to the current page's domain.",
    inputSchema: z.object({ domain: z.string().optional().describe("Defaults to the currently focused window's page domain.") }).strict(),
  },
  async ({ domain }) => {
    let target = domain;
    if (!target) {
      const win = await resolveWindow();
      const snap = await snapshotWindow(win, { limit: 1, pageInfo: true });
      target = snap.page?.url ? domainFromUrl(snap.page.url) : null;
    }
    if (!target) return { content: [{ type: "text", text: "Could not determine a domain." }] };
    const map = await loadSiteMap(target);
    if (!map) return { content: [{ type: "text", text: `No saved knowledge for ${target} yet.` }] };
    return { content: [{ type: "text", text: JSON.stringify(summarizeSiteMap(map, { full: true }), null, 2) }] };
  }
);

server.registerTool(
  "save_site_map",
  {
    title: "Save/enrich knowledge about a site",
    description:
      "Manually record durable facts about a domain that aren't safe to auto-detect: a direct search URL pattern (e.g. " +
      "'https://example.com/search?q={query}' — use {query} as the placeholder) once you've verified it works, a login URL, or a " +
      "free-text note (e.g. 'mega-menu needs click not hover', 'no bot-check observed on homepage'). Nav links and form fields are " +
      "recorded automatically by read_page — you don't need to save those yourself.",
    inputSchema: z.object({
      domain: z.string().optional().describe("Defaults to the currently focused window's page domain."),
      search_url_pattern: z.string().optional(),
      login_url: z.string().optional(),
      note: z.string().optional(),
    }).strict(),
  },
  async ({ domain, search_url_pattern, login_url, note }) => {
    let target = domain;
    if (!target) {
      const win = await resolveWindow();
      const snap = await snapshotWindow(win, { limit: 1, pageInfo: true });
      target = snap.page?.url ? domainFromUrl(snap.page.url) : null;
    }
    if (!target) return { content: [{ type: "text", text: "Could not determine a domain." }], isError: true };
    const map = (await loadSiteMap(target)) || emptySiteMap(target);
    if (search_url_pattern) map.searchUrlPattern = search_url_pattern;
    if (login_url) map.loginUrl = login_url;
    if (note) map.notes.push(note);
    await writeSiteMap(target, map);
    return { content: [{ type: "text", text: `Saved knowledge for ${target}.` }] };
  }
);

server.registerTool(
  "list_known_sites",
  {
    title: "List all sites with saved knowledge",
    description: "List every domain this harness has accumulated knowledge about, with visit counts.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    await mkdir(SITEMAP_DIR, { recursive: true });
    const files = await readdir(SITEMAP_DIR);
    const maps = await Promise.all(
      files.filter((f) => f.endsWith(".json")).map((f) => readFile(path.join(SITEMAP_DIR, f), "utf8").then(JSON.parse))
    );
    const lines = maps
      .sort((a, b) => b.visitCount - a.visitCount)
      .map((m) => `${m.domain}\tvisits=${m.visitCount}\tlast=${m.lastVisited}\t"${m.lastTitle || ""}"`);
    return { content: [{ type: "text", text: lines.join("\n") || "(no sites recorded yet)" }] };
  }
);

// COMPUTER_USE_CLICK_OBSERVE=1 (cart runs): a click that changed the page or opened a panel returns the page it
// produced, as a person sees it — no separate read turn. Measured 2026-09-26 on Owala: six of 17 turns were a
// read right after a click (~3 s each). A navigation is read the way read_after_navigation reads it (waits for
// the new URL's content); a panel (dialog / expanded drawer) is read at once. Off by default: other callers keep
// click_element's exact result.
async function observeAfterClick(args, result) {
  if (process.env.COMPUTER_USE_CLICK_OBSERVE !== "1" || !result || result.isError) return result;
  const said = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const navigated = /url changed|and it opened https?:\/\/\S+ \[verified|Navigated directly to https?:\/\/\S+ \[verified/i.test(said);
  // Only a panel that OPENED (a dialog count going up, or something expanding): a closing drawer changed nothing new.
  const dlg = /dialogs (\d+)->(\d+)/i.exec(said);
  const panel = (dlg && Number(dlg[2]) > Number(dlg[1])) || /expanded false->true/i.test(said);
  if (!navigated && !panel) return result;
  try {
    let page;
    if (navigated) {
      const win = await resolveWindow(args.window_address);
      const url = await observePageUri(win);
      page = url ? await readAfterNavigationAction({ expected_url: url, window_address: args.window_address, timeout_ms: 6000, poll_ms: 300, limit: 300 }) : null;
    }
    // A panel that opened as a DIALOG (a cart drawer: "dialogs 0->1") is read as the dialog — its contents are what
    // the click was for, and a whole-page read cut at 300 rows can end before them (live Owala: the drawer's
    // Checkout was past the cut, the agent closed the drawer and typed the cart URL instead).
    const dialogOpened = /dialogs (\d+)->(\d+)/i.exec(said);
    if (!page && readPageHandler && dialogOpened && Number(dialogOpened[2]) > Number(dialogOpened[1])) {
      // A drawer fills in after it opens (its cart lines load): read until two reads 450 ms apart agree (≤ ~3 s),
      // as a person waits for the drawer to finish sliding in. Read at once, it was empty and the agent closed it.
      const rowsOf = (p) => (p?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").split("\n").filter((l) => /^e\d+\t/.test(l)).map((l) => l.replace(/^e\d+\t/, "")).join("\n");
      let prev = null;
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 450));
        page = await readPageHandler({ window_address: args.window_address, filter_text: "", filter_role: "dialog", include_text: true, limit: 150 });
        const now = rowsOf(page);
        if (prev !== null && now === prev && now.length > 0) break;
        prev = now;
      }
    }
    if (!page && readPageHandler) page = await readPageHandler({ window_address: args.window_address, filter_text: "", filter_role: "", include_text: true, limit: 300 });
    if (!page) return result;
    const text = (page.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (!text) return result;
    return { ...result, content: [...result.content, { type: "text", text: `\n[the page after this click — already read for you; do not read it again]\n${text}` }] };
  } catch { return result; }
}

server.registerTool(
  "click_element",
  {
    title: "Click an element by ref or by name",
    description:
      "Click an interactive element precisely — either a ref from a previous read_page call, or by matching its accessible name/text " +
      "directly (no read_page needed first; this does the find-and-click in one call, which is the efficient path for a simple 'click the " +
      "X button' step). Uses the same kernel-level input as the click tool, just aimed exactly instead of guessed.",
    inputSchema: z.object({
      ref: z.string().optional().describe("A ref like 'e3' from a prior read_page call."),
      text: z.string().optional().describe("Accessible name to search for (case-insensitive substring), if not using ref."),
      role: z.string().optional().describe("Narrow text search to this role, e.g. 'button', 'link'."),
      window_address: z.string().optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
      clicks: z.number().int().min(1).max(3).default(1),
      // A caller that confirms the result itself (the pop-up closer's own-control click, which re-reads the whole page next) can
      // skip the ~2 s transition watch: one quick look (150 ms) instead. Default true — every other caller keeps the watch.
      observe: z.boolean().optional().describe("false: skip the post-click transition watch (one quick 150 ms look); the caller confirms the result itself. Default true."),
      // A link whose href is not where the page's own script takes it (live Coach Outlet 2026-10-07: a search panel's "VIEW ALL"
      // href is the bare /search; typed into the address bar it 404'd, pressed it opens /search?q=…).
      activate: z.boolean().optional().describe("true: press a link in the page (its own click handler) instead of opening its href. Default false."),
    }).strict(),
  },
  async (clickArgs) => observeAfterClick(clickArgs, await (async ({ ref, text, role, window_address, button, clicks, observe, activate }) => {
      const watch = (ms) => (observe === false ? 150 : ms); // the transition watch's deadline (observe:false → one quick look)
    const win = await resolveWindow(window_address);
    // A clean link ref already carries the exact href observed in the page
    // snapshot.  Direct navigation below acts on that destination, not on the
    // live AT-SPI object, so forcing the object to survive a results-page
    // rerender first adds no safety and cost two recovery turns live on Walmart.
    // Reuse the cached destination only when the browser is STILL on the same
    // origin and the snapshot did not flag it off-site.  Every other ref keeps
    // the strict object-path identity resolution (especially state controls).
    const cached = ref ? snapshotCache.get(win.pid)?.get(ref) : null;
    let directBeforeUrl = "";
    let resolved;
    // The shortcut acts on the CACHED entry without re-resolving, so it may be
    // taken only when that entry already carries POSITIVE page provenance. A
    // cached ref that predates provenance stamping is not refused outright —
    // it falls through to resolveElement, which re-resolves the live identity
    // and stamps provenance, and the gate then judges the FRESH answer. That is
    // both safer and less wasteful than refusing a page that can be re-proven.
    if (!LINK_CLICKS_ACTIVATE && !activate && cached?.role === "link" && cached.href && !cached.off_site && cached.doc_class === "page" && !isCheckoutLink(cached)
        && !cached.href.includes("?") && button === "left" && clicks === 1) {
      directBeforeUrl = await observePageUri(win);
      if (cleanHrefDirectEligible(cached.href, directBeforeUrl)) {
        resolved = {
          element: cached,
          matchCount: 1,
          matchedText: cached.name,
          objPath: cached.obj_path || null,
          docGen: cached.doc_gen || null,
        };
      }
    }
    if (!resolved) resolved = await resolveElement({ ref, text, role, win });
    const { element, matchCount, matchedText, objPath, docGen } = resolved;

    // PROVENANCE GATE. Placed here deliberately: every way this tool can act —
    // the direct-href navigation below, semantic activation, the coordinate
    // fallback, any state mutation — happens AFTER this line, and the branch
    // above only chooses a target without touching anything. So one check
    // covers the ref path and the text path together.
    //
    // Measured cost of not having it (REI, 07e180c): a click on the BROWSER
    // WINDOW's own Close button was accepted as page content and activated;
    // Chromium exited code 0 at 18.5s because the window it closed was the only
    // one. Requiring POSITIVE page provenance is what makes that unreachable,
    // and it is checked on the resolved element rather than on a name, so a
    // localized or duplicated "Close" cannot slip past it.
    // The authorization boundary is CROSSED HERE, and everything the tool can
    // do lives inside the thunk below — so a refusal cannot be followed by an
    // action even by accident, and a test can prove that by counting rather
    // than by reading where the check sits.
    return authorizeClick(element, async () => {

    // For a plain single left-click on a LINK with a known, query-string-
    // free href, navigate there directly instead of clicking. This
    // sidesteps a real, reproducible bug class: a coordinate click on a
    // link can silently land on the wrong thing (a duplicate/hidden
    // accessibility-only element sharing the same name+role, or a
    // hover-preview overlay that a real synthetic mouse-move can itself
    // trigger) and never navigate, with no error to signal it — caught
    // live, repeatedly, on a real Amazon product link. A direct URL is
    // unambiguous by construction; typing it is safe here specifically
    // because it has no "?" (see type_text's dropped-"?" note for why a
    // query string would NOT be safe to type into the address bar).
    // Known minor tradeoff: a same-page anchor/skip-link (e.g. "skip to
    // main content") will also match this path and reload the current
    // page instead of just scrolling — harmless, just not instant, and
    // not a link an agent has reason to intentionally target anyway.
    if (element.role === "link" && element.href && element.off_site && !element.href.includes("?") && button === "left" && clicks === 1) {
      return { content: [{ type: "text", text: `Refused direct navigation to off-site link ${element.href}. Use an explicitly requested destination instead of bypassing the page's [OFF-SITE REDIRECT] warning.` }], isError: true };
    }
    if (!LINK_CLICKS_ACTIVATE && !activate && element.role === "link" && element.href && !element.href.includes("?") && button === "left" && clicks === 1 && !isCheckoutLink(element)) {
      // The URL the browser was showing BEFORE anything was typed (URI-only
      // probe). Only an exact, readable match against it can ever buy a second
      // submission; see directHrefNavigation for the observation rules.
      const beforeUrl = directBeforeUrl || (await observePageUri(win));
      // A text-resolved link reaches this branch only after live resolution,
      // so its current-page origin was not available to the earlier cached-ref
      // fast path. Enforce the same boundary here before synthesizing input.
      if (!cleanHrefDirectEligible(element.href, beforeUrl)) {
        return { content: [{ type: "text", text: `Refused direct navigation from ${beforeUrl || "an unobservable page"} to ${element.href}: the link is not a verified same-origin clean destination.` }], isError: true };
      }
      const outcome = await directHrefNavigation({ href: element.href, element, win, beforeUrl, objPath, docGen });
      return { content: [{ type: "text", text: outcome.text }] };
    }

    // Activatable controls: prefer the element's OWN AT-SPI action over a
    // coordinate click (gh issue #4). A synthetic pointer click does not
    // reliably focus/activate web controls in this environment; the
    // accessible action does (proven on Owala: press() dismissed consent
    // and mounted+focused the search input). semantic_activate is ATOMIC in
    // the bridge (resolve+enumerate+choose+invoke on one live object) and
    // refuses on any duplication/ambiguity. do_action's boolean is never
    // treated as success — we poll a fresh transition below.
    // REF-BASED ACTIVATION IS ALWAYS SEMANTIC (issue #5): a ref carries a
    // stable object-path identity, so it must resolve+act atomically on that
    // exact live node. Falling through to a coordinate click would act on
    // whatever now occupies cached coordinates — the identity-degradation this
    // issue exists to eliminate (a rerender between resolve and click can hit a
    // different duplicate). So for ANY role reached by ref we go semantic and,
    // if the node exposes no usable action, FAIL EXPLICITLY below rather than
    // click a screen position. Text-based calls keep the legacy role allowlist.
    if (objPath && !(button === "left" && clicks === 1)) {
      return { content: [{ type: "text", text: `Refused: ${element.ref} ${element.role} "${element.name}" was targeted by ref, but ${button}-click x${clicks} is a pointer-only gesture with no AT-SPI equivalent — a coordinate click cannot preserve the ref's identity. Use a text-based click for pointer gestures, or a different control.` }], isError: true };
    }
    // STATEFUL TOGGLES (aria-pressed). A click here is a CLICK, not an
    // idempotent "select": it follows the control's own advertised action, so
    // clicking an already-pressed toggle unpresses it. That is what the control
    // says it will do, and the result text says exactly what happened rather
    // than assuming the caller meant to keep it on.
    if (TOGGLE_ROLES.has(element.role) && button === "left" && clicks === 1) {
      let res;
      try {
        // Keep an already-chosen option (the agent clicking the selected colour); a second click on the same
        // control within 30 s is a deliberate "turn it off".
        const toggleKey = `${win.pid}:${element.role}:${element.name}`;
        const confirmUnpress = keptPressed.get(toggleKey) > Date.now() - 30000;
        keptPressed.delete(toggleKey);
        res = await atspiBridge({ pid: win.pid, action: "semantic_toggle", text_filter: element.name, role_filter: element.role, keep_pressed: !confirmUnpress, ...(objPath ? { obj_path: objPath, doc_gen: docGen } : {}) });
        if (res?.already_pressed) {
          keptPressed.set(toggleKey, Date.now());
          return { content: [{ type: "text", text: `${element.role} "${element.name}" is already PRESSED (selected), so nothing was clicked. Clicking it again within 30 s would turn it off.` }] };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `semantic_toggle failed: ${e.message}` }], isError: true };
      }
      // The classifier validates the count BEFORE anything branches on the
      // result, and the tally mirrors only what it validated — so a malformed
      // or negative count can neither inflate the record of actions performed
      // nor silently decrement it.
      const tg = classifyToggle(res);
      if (INPUT_STATS_ENABLED && tg.invocationCount) inputStats.nativeActions += tg.invocationCount;
      const what = `${element.role} "${element.name}"`;
      // What the control said it would do, so the report is auditable without
      // re-reading the page.
      const advertised = (res?.actions || []).map((a) => a.name).filter((n) => n !== "showContextMenu");
      if (tg.kind === "verified") {
        const corrob = Array.isArray(res.post_actions)
          ? ` It now advertises ${JSON.stringify(res.post_actions.filter((n) => n !== "showContextMenu"))}.`
          : "";
        // ONLY the requested control is claimed. aria-pressed declares no
        // group, so nothing is said about other options being deselected —
        // even where a site happens to behave exclusively, that behaviour is
        // invisible to the accessibility tree and cannot be verified here.
        return { content: [{ type: "text", text: `${what} is now ${res.desired ? "PRESSED" : "NOT pressed"} — pressed ${res.pre_on}->${res.post_states?.pressed} was OBSERVED on that exact control after invoking its own '${res.invoked_name}' action.${corrob} This states only what happened to THIS control; aria-pressed declares no group, so nothing is claimed about other options.` }] };
      }
      // Some responsive navigation disclosures are exposed by Chromium as a
      // "toggle button" even though they have no readable aria-pressed state.
      // If (and only if) the bridge invoked nothing and the control advertises
      // exactly the ordinary semantic `press` action, activate that same
      // identity once and verify the disclosure by newly exposed links or an
      // expanded-state transition. Never use a coordinate fallback here.
      const disclosureCandidate = tg.invocationCount === 0
        && ["unreadable_state", "no_activation_action"].includes(tg.reason)
        && advertised.length === 1 && advertised[0] === "press";
      if (disclosureCandidate) {
        const pre = await captureDisclosureSignals(win, element);
        let act;
        try {
          act = await atspiBridge({ pid: win.pid, action: "semantic_activate", text_filter: element.name, role_filter: element.role, ...(objPath ? { obj_path: objPath, doc_gen: docGen } : {}) });
        } catch (e) {
          return { content: [{ type: "text", text: `Disclosure activation failed: ${e.message}` }], isError: true };
        }
        const cls = classifyActivation(act);
        if (cls.kind !== "invoked") {
          return { content: [{ type: "text", text: `Refused: ${what} could not be activated as a disclosure (${cls.reason || cls.kind}). No coordinate click was attempted.` }], isError: true };
        }
        if (INPUT_STATS_ENABLED) inputStats.nativeActions++;
        const trans = await pollDisclosureTransition(win, element, pre);
        if (!trans.changed) {
          return { content: [{ type: "text", text: `UNVERIFIED: invoked AT-SPI '${act.invoked_name}' once on disclosure ${what}. ${trans.summary} Do not assume the menu opened.` }], isError: true };
        }
        return { content: [{ type: "text", text: `Activated disclosure ${what} via AT-SPI '${act.invoked_name}'. ${trans.summary}` }] };
      }
      // The control re-rendered under the click (live Owala 2026-09-26: "24oz" was replaced as the store switched
      // variants, the old node read stale): look once at the ONE fresh control with the same role and name, as a
      // person looks at the button again. Only a unique match that reports the desired state counts.
      if (res?.failure === "post_state_unavailable" && tg.invocationCount === 1) {
        try {
          await new Promise((r) => setTimeout(r, 400));
          const fresh = await snapshotWindow(win, { roleFilter: element.role, textFilter: element.name, limit: 20 });
          const same = (fresh?.elements || []).filter((el) => el.role === element.role && el.name === element.name && el.doc_class === "page");
          const on = same.length === 1 && (same[0].states || []).some((st) => st === "pressed" || st === "checked" || st === "selected");
          if (same.length === 1 && on === !!res.desired) {
            return { content: [{ type: "text", text: `${what} is now ${res.desired ? "PRESSED" : "NOT pressed"} — the control re-rendered after '${res.invoked_name}', and its one fresh copy reports ${res.desired ? "pressed" : "not pressed"}.` }] };
          }
        } catch { /* fall through to the unverified report */ }
      }
      const msg = {
        failed_unverified: {
          state_unchanged: `FAILED-UNVERIFIED: invoked '${res.invoked_name}' on ${what}, but that exact control's pressed state did NOT reach ${res.desired} (still ${res.post_states?.pressed}). do_action returned ${res.do_action_returned}, which is not proof.`,
          post_state_unavailable: `FAILED-UNVERIFIED: invoked '${res.invoked_name}' on ${what}, but its state could not be read back afterwards (${res.post_status}), so the result is unknown. Re-read the page before relying on it.`,
          action_raised: `UNVERIFIED: the '${res.invoked_name}' action was ISSUED on ${what} and then failed (${res.raised}), so it MAY have partially applied. Nothing was retried and no fallback was attempted; re-read the page.`,
        }[res.failure] || `FAILED-UNVERIFIED: ${what} — ${tg.detail}.`,
        // A result that called itself a refusal while reporting an ISSUED call.
        // It may have partially applied, so it must not be described as a
        // refusal, and nothing is retried.
        refusal_after_invocation: `UNVERIFIED: ${what} — the bridge reported a refusal (${res.decision || "unspecified"}) but ALSO reported ${tg.invocationCount} action invocation(s) ISSUED, so an action MAY have been performed and MAY have partially applied. Nothing was retried and no fallback was attempted; re-read the page before relying on its state.`,
        invocation_count_unexpected: `UNVERIFIED: ${what} — the bridge reported an invocation but counted ${tg.invocationCount} calls, not exactly 1, so what was performed cannot be established. Nothing is claimed about the control's state; re-read the page.`,
        invocation_count_unusable: `UNVERIFIED: ${what} — the bridge reported no usable count of the actions it issued (got ${JSON.stringify(res?.invocation_count)}), so it cannot be established whether anything was performed. Nothing is claimed; re-read the page.`,
        stale_ref: `Refused: ${element.ref || what} is stale — ${res.status}. Call read_page again and use a fresh ref.`,
        ambiguous_target: `Refused: ${res.match_count ?? "multiple"} elements match ${what} — duplicate targets are not unique identity. Disambiguate before clicking.`,
        unsupported_role: `Refused: ${what} is not a stateful toggle.`,
        unreadable_state: `Refused: ${what} exposes no readable pressed state, so what a click would do cannot be derived. Nothing was invoked.`,
        state_action_contradiction: `Refused: ${what} reports pressed=${res.pre_on} but advertises only '${res.offered}' — the action contradicts the state, so its state model is not understood. Expected '${res.want}'. Nothing was invoked.`,
        ambiguous_action: `Refused: ${what} exposes an unclassifiable action set (${JSON.stringify(advertised)}); not guessing which one to invoke.`,
        no_activation_action: `Refused: ${what} advertises no '${res.want}' action (has: ${JSON.stringify(advertised)}), so it cannot be set semantically. NOT performing a coordinate click — it could not be verified anyway.`,
        toggle_error: `Error toggling ${what}: ${tg.detail}`,
        "no-result": `Refused: semantic_toggle returned no result for ${what}.`,
        unrecognized: `Refused: semantic_toggle returned an unrecognized result for ${what}. NOT performing a coordinate click.`,
      }[tg.reason] || `Refused: ${tg.reason}`;
      return { content: [{ type: "text", text: msg }], isError: true };
    }
    // CHECKABLE CONTROLS (issue #6): a click on a radio/check box is a request
    // for a STATE, so it is routed to the bridge's atomic set-and-verify rather
    // than to generic activation. The verdict is decided in one Python process
    // on one identity-resolved object; nothing here infers success from the
    // page-level transition summary, and do_action's boolean is never proof.
    if (CHECKABLE_ROLES.has(element.role) && button === "left" && clicks === 1) {
      let res;
      try {
        res = await atspiBridge({ pid: win.pid, action: "semantic_set_checkable", text_filter: element.name, role_filter: element.role, ...(objPath ? { obj_path: objPath, doc_gen: docGen } : {}) });
      } catch (e) {
        return { content: [{ type: "text", text: `semantic_set_checkable failed: ${e.message}` }], isError: true };
      }
      const ck = classifyCheckable(res);
      const what = `${element.role} "${element.name}"`;
      if (ck.kind === "already_satisfied") {
        // Say how far the observation reaches: "it is selected" and "it is the
        // only thing selected in its group" are different claims, and only one
        // of them is available when the tree exposes no defensible group.
        const grp = res.peer_association === "not_applicable" ? ""
          : res.peer_verified ? ` No other option in its group (${res.peer_association}) is selected.`
          : ` No defensible group association for this control exists in the accessibility tree (${res.peer_association}), so group-wide state was NOT verified — other options may also be selected.`;
        return { content: [{ type: "text", text: `${what} is already ${res.desired_checked ? "selected" : "unselected"} — checked=${res.pre_states?.checked} was OBSERVED on that exact control, so no action was invoked. (Nothing ran; this is the state being reported, not an activation.)${grp}` }] };
      }
      if (ck.kind === "verified") {
        const dir = `checked ${res.pre_states?.checked}->${res.post_states?.checked}`;
        let peer;
        // A check box has no group by nature, so it gets no peer clause at all;
        // only a radio's report needs to say how far the verification reached.
        if (res.peer_association === "not_applicable") peer = "";
        else if (res.peer_verified) peer = ` Its previously-selected peer "${res.peer_name}" was verified deselected by its own identity (${res.peer_association}).`;
        else if (res.peer_reason === "no_prior_peer") peer = ` No option in its group (${res.peer_association}) was selected beforehand, so this is target-only verification.`;
        else if (res.peer_reason) peer = ` No defensible group association for this control exists in the accessibility tree (${res.peer_reason}), so this is TARGET-ONLY verification — other options were not checked.`;
        else peer = "";
        return { content: [{ type: "text", text: `${res.desired_checked ? "Selected" : "Unselected"} ${what} via AT-SPI '${res.invoked_name}'. Verified on that exact control: ${dir}.${peer}` }] };
      }
      // A radio group that never exposes checked (live Gymshark / Shopify themes 2026-09-26: visually hidden
      // <input type=radio> inside styled labels; the click DID select "S" on screen, but no option reports
      // checked before or after) cannot be verified by state at all. Calling that FAILED sent the agent into
      // retries (~25 s). When nothing in the group reports checked, say so plainly: the click was invoked, and
      // the variant is confirmed by the cart line after adding. A group that does expose state stays strict.
      if (element.role === "radio button" && res?.failure === "state_unchanged" && res.desired_checked === true && res.pre_states?.checked !== true) {
        try {
          const group = await snapshotWindow(win, { roleFilter: "radio button", limit: 80 });
          const radios = (group?.elements || []).filter((el) => el.role === "radio button" && el.doc_class === "page");
          const anyChecked = radios.some((el) => (el.states || []).includes("checked"));
          if (radios.length > 1 && !anyChecked) {
            return { content: [{ type: "text", text: `Clicked ${what} (AT-SPI '${res.invoked_name}'). This store does not expose which option is selected — none of its ${radios.length} options reports checked, before or after — so the selection cannot be read back here. Do not click it again: continue (add to cart) and confirm the ${element.name.trim()} on the cart line.` }] };
          }
        } catch { /* fall through to the strict report */ }
      }
      const msg = {
        failed_unverified: {
          state_unchanged: `FAILED-UNVERIFIED: invoked AT-SPI '${res.invoked_name}' on ${what}, but that exact control's checked state did NOT change (still ${res.post_states?.checked}). do_action returned ${res.do_action_returned}, which is not proof. The control was NOT set.`,
          post_state_unavailable: `FAILED-UNVERIFIED: invoked AT-SPI '${res.invoked_name}' on ${what}, but its state could not be read back afterwards, so the result is unknown. Re-read the page and check before relying on it.`,
          peer_still_checked: `FAILED-UNVERIFIED: ${what} reports checked=${res.post_states?.checked}, but its previously-selected peer "${res.peer_name}" is STILL selected — two options selected in one group means the selection did not take.`,
          peer_unreadable: `FAILED-UNVERIFIED: ${what} reports checked=${res.post_states?.checked}, but the peer that was selected beforehand can no longer be read (${res.peer_status || "unreadable"}), so the group state is unverified.`,
        }[res.failure] || `FAILED-UNVERIFIED: ${what} — ${ck.detail}.`,
        stale_ref: `Refused: ${element.ref || what} is stale — ${res.reason || res.status}. Call read_page again and use a fresh ref.`,
        ambiguous_target: `Refused: ${res.match_count ?? "multiple"} elements match ${what} — duplicate targets are not unique identity. Disambiguate before setting it.`,
        ambiguous_action: `Refused: ${what} exposes an unclassifiable set of actions (${(res.actions || []).map((a) => a.name).join(", ")}); not guessing which one sets the state.`,
        ambiguous_group: res.already_checked_target
          ? `Refused: ${what} is already selected, but its group (${res.peer_association}) ALSO has ${res.checked_peer_count - 1} other option(s) selected (${(res.checked_peer_names || []).join(", ")}). Reporting this as satisfied would hide a malformed group. Nothing was invoked.`
          : `Refused: ${what} is in a group (${res.peer_association}) that ALREADY has ${res.checked_peer_count} options selected (${(res.checked_peer_names || []).join(", ")}). Setting this one could not be verified — deselecting one peer would leave the other selected and still look like success. Nothing was invoked.`,
        no_activation_action: `Refused: ${what} exposes no '${res.wanted_action}' action (has: ${(res.actions || []).map((a) => a.name).join(", ")}), so its state cannot be set semantically. NOT performing a coordinate click — it could not be verified anyway.`,
        unsupported_role: `Refused: ${what} is not a checkable control.`,
        checkable_error: `Error setting ${what}: ${ck.detail}`,
        "no-result": `Refused: semantic_set_checkable returned no result for ${what}.`,
        unrecognized: `Refused: semantic_set_checkable returned an unrecognized result for ${what}. NOT performing a coordinate click.`,
      }[ck.reason] || `Refused: ${ck.reason}`;
      return { content: [{ type: "text", text: msg }], isError: true };
    }
    if ((objPath || ACTIVATABLE_ROLES.has(element.role)) && button === "left" && clicks === 1) {
      const pre = await captureSignals(win, element);
      let act;
      try {
        act = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "semantic_activate", text_filter: element.name, role_filter: element.role, ...(objPath ? { obj_path: objPath, doc_gen: docGen } : {}) });
      } catch (e) {
        return { content: [{ type: "text", text: `semantic_activate failed: ${e.message}` }], isError: true };
      }
      // A ref whose object-path identity no longer resolves -> explicit stale,
      // never a name/coordinate guess (issue #5).
      if (act && act.stale_ref) {
        return { content: [{ type: "text", text: `Refused: ${element.ref} "${element.name}" is stale — ${act.reason || act.status}. Call read_page again and use a fresh ref.` }], isError: true };
      }
      // Pure routing (unit-tested): the ONLY outcome that permits pointer
      // input is coordinate_fallback; everything else is a no-pointer error.
      const cls = classifyActivation(act);
      // For a ref (object-path identity), NEVER fall back to coordinates
      // (Codex ruling): the element resolved uniquely but exposes no AT-SPI
      // action -> fail closed rather than click a screen position.
      // One exception, still identity-bound: the bridge hit-tests points inside
      // the element's CURRENT extents, in the same process that resolved the
      // ref, and a point counts only when the accessibility hit-test descends
      // through that exact element (live On: size options and address
      // suggestions are bare <li> nodes with no action). The pointer goes only
      // to such a point, and the click still has to produce a transition.
      if (objPath && cls.kind === "coordinate_fallback") {
        let hit = null;
        try {
          hit = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "hit_point", text_filter: element.name, role_filter: element.role, obj_path: objPath, doc_gen: docGen });
        } catch (e) {
          hit = { status: `bridge_error: ${e.message}` };
        }
        if (hit?.stale_ref) {
          return { content: [{ type: "text", text: `Refused: ${element.ref} "${element.name}" is stale — ${hit.reason || hit.status}. Call read_page again and use a fresh ref.` }], isError: true };
        }
        // A pop-up's close control covering the point (live J.Crew 2026-09-28: a sign-up overlay spanning the screen,
        // not a dialog root, sat over "Select a size"; the model never closed it and the run was lost): close it —
        // the page's own close control, activated by name — and hit-test again, once.
        let closedCover = null, closeAttempt = "";
        if (hit?.status !== "owned" && hit?.hit && /^(?:button|push button|link)$/i.test(hit.hit.role || "") && COVER_CLOSE_NAME.test(String(hit.hit.name || "").trim())) {
          try {
            const closed = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "semantic_activate", text_filter: hit.hit.name, role_filter: hit.hit.role });
            closeAttempt = ` Tried its "${hit.hit.name}" control first: ${classifyActivation(closed).kind}${closed?.reason ? ` (${closed.reason})` : ""}.`;
            const rehit = () => atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "hit_point", text_filter: element.name, role_filter: element.role, obj_path: objPath, doc_gen: docGen });
            const stillCovered = (h) => h?.status !== "owned" && h?.hit && COVER_CLOSE_NAME.test(String(h.hit.name || "").trim());
            const cover = hit.hit;
            if (classifyActivation(closed).kind === "invoked") {
              closedCover = cover.name;
              await new Promise((r) => setTimeout(r, 900));
              hit = await rehit();
            }
            // A backdrop ignores the accessibility press (live J.Crew): Escape, as a person closes a modal, then a real
            // click on the backdrop itself at a point the hit-test proved is the backdrop's.
            if (stillCovered(hit)) {
              await keyPressAction({ key: "Escape", modifiers: [] }).catch(() => {});
              await new Promise((r) => setTimeout(r, 700));
              hit = await rehit();
              closeAttempt += stillCovered(hit) ? " Escape did not close it." : " Escape closed it.";
              if (!stillCovered(hit)) closedCover = cover.name;
            }
            if (stillCovered(hit) && Number.isFinite(hit.hit.x) && Number.isFinite(hit.hit.y)) {
              await moveMouseRaw(hit.hit.x, hit.hit.y);
              await new Promise((r) => setTimeout(r, 30));
              await clickButton("left", 1);
              await new Promise((r) => setTimeout(r, 900));
              hit = await rehit();
              closeAttempt += stillCovered(hit) ? " A click on its backdrop did not close it either." : " A click on its backdrop closed it.";
              if (!stillCovered(hit)) closedCover = cover.name;
            }
          } catch { /* the refusal below stands */ }
        }
        if (hit?.status !== "owned") {
          const over = (hit?.hit ? ` The point is covered by ${hit.hit.role} "${hit.hit.name}".` : "") + closeAttempt;
          return { content: [{ type: "text", text: `Refused: ${element.role} "${element.name}" resolved by ref identity but exposes no AT-SPI activation action, and no point inside it is provably its own (${hit?.status || "no result"}).${over} Not performing a coordinate click. Close whatever covers it, scroll it into view, or re-read the page.` }], isError: true };
        }
        await moveMouseRaw(hit.x, hit.y);
        await new Promise((r) => setTimeout(r, 30));
        await clickButton(button, clicks);
        const trans = await pollTransition(win, element, pre, 150, watch(2000), { countTargetRemoval: true });
        if (closedCover) trans.summary = `(First closed the pop-up covering it via its "${closedCover}" control.) ${trans.summary}`;
        if (!trans.changed) {
          return { content: [{ type: "text", text: `UNVERIFIED: ${element.role} "${element.name}" has no AT-SPI activation action, so it was clicked at ${hit.x},${hit.y}, a point the accessibility hit-test proved is its own. ${trans.summary} Nothing observable changed; re-read the page before relying on it.` }], isError: true };
        }
        return { content: [{ type: "text", text: `Clicked ${element.role} "${element.name}" at ${hit.x},${hit.y}, a point the accessibility hit-test proved is its own (it has no AT-SPI activation action). ${trans.summary}` }] };
      }
      if (cls.kind === "error") {
        const msg = {
          ambiguous_target: `Refused: ${act.match_count ?? "multiple"} elements match ${element.role} "${element.name}" — duplicate targets are not unique identity. Disambiguate (different role, or a fresher read_page) before activating.`,
          ambiguous_action: `Refused: ${element.role} "${element.name}" exposes multiple activation actions (${(act.actions || []).map((a) => a.name).join(", ")}); not guessing which.`,
          do_action_false: `do_action('${act.invoked_name}') returned false on ${element.role} "${element.name}" — activation failed. NOT falling back to a coordinate click; re-read and retry deliberately.`,
          activation_error: `Activation error on ${element.role} "${element.name}": ${cls.detail}`,
          unrecognized: `Refused: semantic_activate returned an unrecognized result for ${element.role} "${element.name}" — NOT performing a coordinate click. Re-read the page.`,
          "no-result": `Refused: semantic_activate returned no result for ${element.role} "${element.name}".`,
        }[cls.reason] || `Refused: ${cls.reason}`;
        return { content: [{ type: "text", text: msg }], isError: true };
      }
      if (cls.kind === "coordinate_fallback") {
        // Unique target with no AT-SPI activation action → explicit, labeled
        // coordinate fallback (known-unreliable). Only reached for the
        // no_activation_action shape (all ambiguous/error shapes returned above).
        await moveMouseRaw(element.cx, element.cy);
        await new Promise((r) => setTimeout(r, 30));
        await clickButton(button, clicks);
        const trans = await pollTransition(win, element, pre, 150, watch(2000));
        // NAME WHAT THE CONTROL ACTUALLY OFFERED. "exposed no AT-SPI activation
        // action" was false on real controls: a variant picker advertising
        // `check` exposes an action this harness does not RECOGNIZE, which is a
        // different and much more useful thing to be told.
        const offered = (act.actions || []).map((a) => a.name).filter((n) => n !== "showContextMenu");
        const advertised = offered.length
          ? `It advertises ${JSON.stringify(offered)}, which this harness does not route.`
          : "It advertises no action at all.";
        if (!trans.changed) {
          // A coordinate click is not evidence. Nothing observable changed, so
          // nothing may be claimed — and it must not read as success.
          return { content: [{ type: "text", text: `UNVERIFIED: ${element.role} "${element.name}" exposes no activation action this harness recognizes, so a coordinate click was attempted at ${element.cx},${element.cy}. ${advertised} ${trans.summary} NOTHING is proven to have changed — a coordinate click is not evidence in itself. Do NOT assume this took effect; re-read the page and confirm before relying on it.` }], isError: true };
        }
        return { content: [{ type: "text", text: `Coordinate fallback — ${element.role} "${element.name}" exposes no activation action this harness recognizes, so a coordinate click was used. ${advertised} ${trans.summary}` }] };
      }
      // cls.kind === "invoked"
      // A cart/checkout link opens a slow page (live Owala: its checkout took longer than 2 s, the click read as
      // UNVERIFIED and the agent spent four turns re-reading and re-clicking): watch it for up to 6 s.
      const trans = await pollTransition(win, element, pre, 150, watch(element.role === "link" && isCheckoutLink(element) ? 6000 : isCheckoutStepButton(element) ? 7000 : 2000), { countTargetRemoval: true });
      // REMOVAL-ONLY evidence gets its own wording. "Activated ..." would read
      // as a claim that the action did what it was for; all that was actually
      // observed is that the control we invoked is gone from a page that did
      // not navigate. An overlay can outlive its close button.
      if (trans.removalOnly) {
        return { content: [{ type: "text", text: `Invoked AT-SPI '${act.invoked_name}' on ${element.role} "${element.name}". ${trans.summary} That is the whole observation: it is NOT proof the overlay closed or that the action otherwise succeeded. Read the page if you need its current state.` }] };
      }
      if (!trans.changed) {
        // do_action's boolean is evidence, never proof. With no observable
        // transition there is nothing to attribute to the invocation, so this
        // is an explicit failure to verify rather than a qualified success.
        return { content: [{ type: "text", text: `UNVERIFIED: invoked AT-SPI '${act.invoked_name}' on ${element.role} "${element.name}" and do_action returned ${act.do_action_returned}, which is not proof. ${trans.summary} No observable change could be attributed to it. Do NOT assume it took effect; re-read the page and confirm.` }], isError: true };
      }
      return { content: [{ type: "text", text: `Activated ${element.role} "${element.name}" via AT-SPI '${act.invoked_name}' action. ${trans.summary}` }] };
    }

    // A ref must never reach a coordinate click (issue #5). Any ref call is
    // handled semantically above; reaching here means the role/action could not
    // be performed semantically -> fail closed instead of trusting coordinates
    // captured before the identity-resolving bridge process exited.
    if (objPath) {
      return { content: [{ type: "text", text: `Refused: ${element.ref} ${element.role} "${element.name}" resolved by ref identity but could not be activated semantically — NOT falling back to a coordinate click (it could hit a different duplicate after a rerender). Re-read the page, or target a control that exposes an AT-SPI action.` }], isError: true };
    }
    await moveMouseRaw(element.cx, element.cy);
    await new Promise((r) => setTimeout(r, 30));
    await clickButton(button, clicks);
    const note = matchCount > 1 ? ` (${matchCount} elements matched "${matchedText}"; clicked the most likely one — pass role to disambiguate)` : "";
    return {
      content: [
        { type: "text", text: `Clicked ${element.ref} ${element.role} "${element.name}" @${element.cx},${element.cy}${note}` },
      ],
    };
    });
  })(clickArgs))
);

server.registerTool(
  "press_element",
  {
    title: "Press an option opener by ref (read-only, fast)",
    description:
      "Press ONE option opener from a prior read_page — a size/colour dropdown, a 'Select size' button, a tab — through its own " +
      "accessibility action, so its values can be read next. Read-only and fast: no before/after page snapshot, no pointer, no " +
      "coordinate fallback. Refuses links (use click_element), and anything that changes the cart, the order or the account. " +
      "Returns 'Pressed' or 'Not pressed' with the reason; it does not verify what opened — read_page does.",
    inputSchema: z.object({
      ref: z.string().describe("A ref like 'e3' from a prior read_page call."),
      window_address: z.string().optional(),
    }).strict(),
  },
  async ({ ref, window_address }) => {
    const win = await resolveWindow(window_address);
    const { element, objPath, docGen } = await resolveElement({ ref, win });
    const refusal = pressRefusalFor(element);
    if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
    const what = `${element.ref || ref} ${element.role} ${JSON.stringify(element.name ?? "")}`;
    let act;
    try {
      act = await atspiBridge({ pid: win.pid, action: "semantic_activate", text_filter: element.name, role_filter: element.role, obj_path: objPath, doc_gen: docGen });
    } catch (e) {
      return { content: [{ type: "text", text: `Not pressed: ${what} — ${e.message}` }], isError: true };
    }
    const cls = classifyActivation(act);
    if (cls.kind !== "invoked") {
      return { content: [{ type: "text", text: `Not pressed: ${what} (${cls.reason || cls.kind}). No coordinate click was attempted.` }], isError: true };
    }
    if (INPUT_STATS_ENABLED) inputStats.nativeActions++;
    return { content: [{ type: "text", text: `Pressed ${what} via AT-SPI '${act.invoked_name}'. Not verified — read_page to see what opened.` }] };
  }
);

server.registerTool(
  "wait_page_settled",
  {
    title: "Wait until the page has finished loading (event-driven)",
    description:
      "Wait until the page on screen has finished loading: its document is no longer busy and the browser has " +
      "announced no structural change for quiet_ms. Event-driven (the browser's own accessibility notifications), not " +
      "a fixed sleep. Returns {settled, reason, ms, ready_ms, events}. Read-only.",
    inputSchema: z.object({
      window_address: z.string().optional(),
      quiet_ms: z.number().int().min(100).max(5000).default(800),
      max_ms: z.number().int().min(500).max(60000).default(15000),
      url_contains: z.string().optional(),
      title_contains: z.string().optional().describe("Only a document whose title contains this counts."),
      not_doc: z.string().optional().describe("The `doc` a previous wait_page_settled returned: after a navigation, only a DIFFERENT document counts (a view-source: page keeps its page's URI and has no title)."),
    }).strict(),
  },
  async ({ window_address, quiet_ms, max_ms, url_contains, title_contains, not_doc }) => {
    const win = await resolveWindow(window_address);
    const res = await atspiBridge({ pid: win.pid, action: "wait_settled", quiet_ms, max_ms, ...(url_contains ? { url_contains } : {}), ...(title_contains ? { title_contains } : {}), ...(not_doc ? { not_doc } : {}), ...(AUTOMATION_BACKEND === "headless" ? { placeholder_focus_ok: true } : {}) }).catch((e) => ({ settled: false, reason: e.message }));
    // LOG ONLY (lead 2026-10-04): a settle that ran to max_ms on a document still loading but already populated and quiet — a day
    // of per-store counts decides whether settle may rely on the populated document instead of load-complete. Not in the answer.
    if (res && res.would_have_settled_ms != null) {
      let host = ""; try { host = new URL(res.uri).hostname; } catch {}
      console.error(`[settle] would have settled at ${res.would_have_settled_ms} ms, quiet_while_loading (timed out at ${res.ms} ms, ${host || "no host"})`);
      delete res.would_have_settled_ms;
    }
    if (res?.placeholder_focus?.placeholder) console.error(`[a11y] settle: empty page document ${res.placeholder_focus.grabbed ? `given focus at ${res.placeholder_focus.at_ms} ms${res.placeholder_focus.ready_after_ms != null ? `, ready ${res.placeholder_focus.ready_after_ms} ms later` : ", still not ready"}` : `NOT given focus (${res.placeholder_focus.why || "refused"})`}`);
    return { content: [{ type: "text", text: JSON.stringify(res) }], ...(res?.settled ? {} : { isError: false }) };
  }
);

server.registerTool(
  "page_text",
  {
    title: "Save the open page's full text to a file (read-only)",
    description:
      "Write the text of the page document now open (leaf by leaf, in document order) to a local file and return its " +
      "path. Built for a view-source: page, so a store's embedded product data can be read through this browser " +
      "session. Read-only: nothing is clicked, typed or navigated.",
    inputSchema: z.object({
      window_address: z.string().optional(),
      max_chars: z.number().int().min(1000).max(8000000).default(4000000),
      from_end: z.boolean().default(false).describe("Read from the document's end back (a page's embedded app data usually closes it); the text returned is still in page order."),
    }).strict(),
  },
  async ({ window_address, max_chars, from_end }) => {
    const win = await resolveWindow(window_address);
    // A view-source: page just opened may not expose its document yet (live Hydro Flask/YETI: none at 3 s): look again, bounded.
    let res;
    for (let i = 0; i < 5; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500));
      res = await atspiBridge({ pid: win.pid, action: "document_text", max_chars, reverse: from_end }).catch((e) => ({ ok: false, reason: e.message }));
      if (res?.ok || res?.reason !== "no_page_document") break;
    }
    if (!res?.ok) return { content: [{ type: "text", text: `No page text: ${res?.reason || "unknown"}` }], isError: true };
    const file = path.join(os.tmpdir(), `page-text-${win.pid}-${Date.now()}.txt`);
    await writeFile(file, res.text || "", "utf8");
    return { content: [{ type: "text", text: JSON.stringify({ path: file, chars: (res.text || "").length, nodes: res.nodes, truncated: res.truncated, uri: res.uri || null }) }] };
  }
);

server.registerTool(
  "type_into_element",
  {
    title: "Type into a field by ref or by name",
    description:
      "Focus a text field (by ref from read_page, or by matching its accessible name/label) and type into it in one call — finds, " +
      "clicks, optionally clears, types, and optionally submits. This is the efficient path for 'fill in the search box and search'.",
    inputSchema: z.object({
      ref: z.string().optional(),
      text: z.string().optional().describe("Accessible name/label to search for, if not using ref."),
      role: z.string().optional(),
      window_address: z.string().optional(),
      value: z.string().describe("Text to type."),
      clear: z.boolean().default(true).describe("Select-all and delete existing content first."),
      press_enter: z.boolean().default(false).describe("Press Return after typing (e.g. to submit a search)."),
    }).strict(),
  },
  async ({ ref, text, role, window_address, value, clear, press_enter }) => {
    const win = await resolveWindow(window_address);
    // Returns {editables, truncated}. `truncated` (review v6/v7) means the
    // baseline could NOT be completely and reliably enumerated — recovery must
    // fail closed on it, never judge a candidate against a blind baseline. A
    // baseline is COMPLETE ONLY if the bridge returned a well-formed response
    // with an explicit truncated===false and a real editables array. ANY other
    // outcome — an exception, an {error}, a malformed/missing array, a
    // missing/true completeness flag — is treated as INCOMPLETE (truncated:true).
    // We never DEFAULT an unknown baseline to complete (that would fail OPEN).
    const captureTextEditables = async () => {
      try {
        const r = await atspiBridge({ pid: win.pid, action: "list_text_editables" });
        if (r && Array.isArray(r.editables) && r.truncated === false) {
          return { editables: r.editables, truncated: false };
        }
        return { editables: Array.isArray(r?.editables) ? r.editables : [], truncated: true };
      } catch {
        return { editables: [], truncated: true };
      }
    };
    // Recovery eligibility follows the RESOLVED element role, not just a
    // caller-supplied one (recovery review #2): the normal API addresses fields
    // by ref alone, so a ref to a combo box must still enable recovery with role
    // omitted. Derive the role WITHOUT an extra tree walk — an explicit role, or
    // else the ref's cached snapshot role (a text search always carries a role).
    let resolvedRole = role;
    if (!resolvedRole && ref) {
      try { resolvedRole = snapshotCache.get(win.pid)?.get(ref)?.role; } catch {}
    }
    // HOT-PATH SCOPING (recovery review #6): baseline capture is a FULL AT-SPI
    // tree walk. Only combo boxes exhibit the focus-expanding/replacement/
    // unmount pattern (VS, Owala, etc.), and that is how those widgets are
    // addressed. So baselines + recovery run ONLY for combo-box targets; every
    // normal <input>/entry/textbox call pays ZERO extra walks.
    const wantRecovery = ["combo box", "combobox"].includes((resolvedRole || "").toLowerCase().trim());
    // For combo targets ONLY, capture the TRUSTED PRE-FOCUS original signature
    // (landmark + match_count) and the S0 baseline BEFORE focusing. A no-focus
    // resolve (scroll_to) yields the original's landmark without moving focus,
    // so recovery can anchor association on it even if focus later UNMOUNTS the
    // original and mounts the real input elsewhere (recovery review #1).
    let origSig = null;
    let s0 = [], s0Truncated = false;
    if (wantRecovery) {
      try {
        const pre = await resolveElement({ ref, text, role, win, focus: false });
        origSig = { name: pre.element.name, role: pre.element.role, landmark: pre.element.landmark ?? null, matchCount: pre.matchCount ?? 1 };
      } catch {}
      const cap0 = await captureTextEditables();
      s0 = cap0.editables; s0Truncated = cap0.truncated;
    }
    // PRE-INTERACTION page observation, taken BEFORE the first synthetic input.
    // It must precede focusing/clearing/typing, because that interaction is
    // itself what can make the old page tree disappear (measured). Observing
    // afterwards could report "no previous page" when a page was in fact showing
    // — and a missing observation, if treated as "there was none", would let ANY
    // later URI resolve the token, including the stale previous page reappearing
    // mid-navigation. So it is captured early and carried through immutably.
    // The gate used to be omnibox-SHAPED: it required an entry whose name was a
    // known address-bar name, or a ref. A site's own search field addressed by
    // its visible text ("Search") failed it, so no baseline existed, and with no
    // baseline observeSubmitTransition reports "unobservable" WITHOUT polling —
    // the model is sent to read a page whose navigation has not committed, acts
    // on refs from the previous document, and pays a stale_doc refusal plus a
    // second read. So the gate is now role-shaped: capture unless the target
    // plainly cannot accept text. It preserves every old shape whose baseline
    // can be consumed (including the omnibox), while deliberately avoiding the
    // read for ref-addressed non-editable controls; that narrowing is pinned in
    // test_submit_transition.mjs.
    let prevPage = { state: "unknown" };
    if (needsSubmitBaseline({ role: resolvedRole, pressEnter: press_enter })) {
      try {
        // The URI-only read: only page_document_uri_raw is used below, and the
        // same command the transition poll issues (see pageUriBridgeCommand).
        const pre = await atspiBridge(pageUriBridgeCommand(win));
        // The RAW uri, which keeps about:blank: a fresh tab positively IS showing
        // that document, and a later real URL differs from it and resolves
        // normally. Anything else is UNKNOWN — never "there was no page", which
        // the capped, exception-swallowing walk cannot prove.
        prevPage = pre?.page_document_uri_raw
          ? { state: "known", uri: pre.page_document_uri_raw }
          : { state: "unknown" };
      } catch { prevPage = { state: "unknown" }; }
      // TEST-ONLY (gated): force the pre-navigation observation to be UNKNOWN,
      // to exercise the fail-closed path where a stale page URI later appears
      // while the real destination is still loading.
      if (process.env.COMPUTER_USE_TEST_PREPAGE === "unknown") prevPage = { state: "unknown" };
    }
    const { element } = await resolveElement({ ref, text, role, win, focus: true });
    let coordinateFallbackUsed = false;
    const observeFocusedPageEditable = async (target) => {
      // The focus call already read the page's focused editable in its own process; spend that once.
      if (target && target.focusedNow !== undefined && !target.focusedNowUsed) {
        target.focusedNowUsed = true;
        if (target.focusedNow) return { focused: target.focusedNow, matches: focusedPageEditableMatches(target, target.focusedNow) };
      }
      try {
        const focused = (await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "get_focused" }))?.focused;
        return { focused, matches: focusedPageEditableMatches(target, focused) };
      } catch {
        return { focused: null, matches: false };
      }
    };
    // allowFallback:false — grab_focus proof or nothing, never a pointer click.
    // The post-navigation ref SWAP passes it (rev 27b): a swap is a bounded
    // recovery on a node it resolved by identity, and a coordinate click there
    // broke the fail-closed contract of the recovery path (test_focus_recovery
    // case12: zero pointer input when the baseline bridge faults).
    const focusPlainEditable = async (target, { allowFallback = true, priorRole = null, recovery = false } = {}) => {
      let proof = await observeFocusedPageEditable(target);
      const decision = plainEditableFocusDecision(target, proof.focused, { fallbackUsed: coordinateFallbackUsed, omnibox: isOmniboxTarget(target), priorRole, recovery });
      if (decision.allow) return proof;
      if (!decision.fallback || !allowFallback) return proof;
      coordinateFallbackUsed = true;
      await moveMouseRaw(target.cx, target.cy);
      await new Promise((r) => setTimeout(r, 30));
      await clickButton("left", 1);
      await new Promise((r) => setTimeout(r, 50));
      return observeFocusedPageEditable(target);
    };
    // KNOWN-UNLOADABLE URL GUARD, applied at the navigation CHOKE POINT.
    // cleanHrefDirectEligible used to be consulted only inside click_element's
    // direct-href branch, where a false result just skipped the branch in
    // silence — the model was never told the URL shape does not load on its
    // own. Live consequence: after a Macy's product failed, the model typed a
    // slug-only Macy's product URL straight into the address bar and got a
    // 404. Typing an address is the only other way to reach a URL, so the same
    // predicate belongs here, before any keystroke is sent.
    if (isOmniboxTarget(element) && /^https?:\/\//i.test(String(value).trim()) && !cleanHrefDirectEligible(String(value).trim())) {
      return { content: [{ type: "text", text: `Refused to navigate to ${String(value).trim()}: this URL shape is known not to load on its own — the site supplies the product identity from the page you clicked from, so entering it directly returns a 404 or an empty page. NOTHING was typed. Go back to the listing and use click_element on the product link itself, or choose a different candidate.` }], isError: true };
    }
    let s1 = [], s1Truncated = false;
    if (wantRecovery) {
      const cap1 = await captureTextEditables();
      s1 = cap1.editables; s1Truncated = cap1.truncated;
    }
    // User-facing target identity (review v3 P2): if focusing UNMOUNTED the
    // element, the live focus result reads back as role "invalid"/no name. Fall
    // back to the trusted PRE-FOCUS origSig so messages name the real target.
    const invalidated = element.role === "invalid" || !element.name;
    const displayRole = invalidated && origSig ? origSig.role : element.role;
    const displayName = invalidated && origSig ? origSig.name : element.name;
    // Combo boxes: TRUST grab_focus when it reports focused, and do NOT
    // click on top of it. Root-caused live on Victoria's Secret
    // (2026-08-28): its "Search" combo is a focus-expanding widget —
    // focusing it REPLACES the trigger with the real input ("Ask
    // anything") plus a clear/close button at nearby coordinates, so a
    // click aimed at the original trigger's coordinates lands on the
    // expanded widget's clear button (or toggles it closed) and the typed
    // text silently evaporates. An earlier session concluded the opposite
    // ("never trust grab_focus for combo box, always click") from the
    // same site — that conclusion came from a broken verification read,
    // not from the click actually helping. The read-back verification
    // below is the real safety net either way: if grab_focus genuinely
    // didn't deliver keystrokes, verification fails and the retry does
    // the click.
    // A coordinate click is a focus fallback for plain fields grab_focus
    // missed. NEVER click a combo-box/recovery target: focusing it can
    // restructure the widget (VS "Search"->"Ask anything") so the pre-focus
    // coordinates now sit on its clear/close button — clicking there dismisses
    // it or lands on the wrong control, and reports as a destructive pointer
    // action. For these, trust grab_focus and let focus-recovery handle a miss.
    const initialFocus = await focusPlainEditable(element, { priorRole: origSig?.role ?? null, recovery: wantRecovery });
    if (!wantRecovery && !isOmniboxTarget(element) && !initialFocus.matches) {
      const where = initialFocus.focused ? `${initialFocus.focused.doc_class || "unknown"} ${initialFocus.focused.role || "object"} "${initialFocus.focused.name || ""}"` : "nothing has focus";
      return { content: [{ type: "text", text: `Refused to type into ${element.ref} ${displayRole} "${displayName}": the freshly resolved page editable is not confirmed focused (${where}). NOTHING was typed, pasted, or submitted.` }], isError: true };
    }
    if (element.role === "combo box") {
      // Focus-expansion animation can eat the first keystrokes (caught
      // live: "abc" typed the instant focus landed became "ab") — let the
      // widget finish restructuring before typing.
      await new Promise((r) => setTimeout(r, 350));
    }
    if (clear) {
      // -s 100: see type_text — every wtype invocation is a fresh process
      // that can race the compositor's virtual-keyboard binding, dropping
      // the whole keypress (not just garbling text) if it fires too soon.
      await selectAllKeys();
      await new Promise((r) => setTimeout(r, 20));
    }
    // -d 25 (was 12): caught live — rapid pacing was silently dropping "?"
    // in mixed content like URLs ("/s?k=..." typed as "/sk=..."), turning
    // every direct search-URL navigation into a 404. Looks like a shift-state
    // transition race (a bare "?" in isolation typed fine; it's specifically
    // letter->shift-char->letter sequences that lost the shifted character).
    //
    // PASTE-FIRST, for one narrow shape only: a headless-backend http(s) URL
    // going into the trusted RESOLVED omnibox element (never inferred from the
    // caller's text), and never a combo/recovery target. Measured live on New
    // Balance and eBay: direct-URL navigation cost ~6.3-6.9s because the first
    // wtype pass dropped characters EVERY time and only the clipboard-paste
    // retry landed. shouldPasteUrlFirst fails closed to typing on anything
    // else — in-document fields, combo targets, non-URL omnibox text, and the
    // real desktop (where a paste would clobber the user's own clipboard). If
    // wl-copy rejects, enterValue falls back once to exactly the wtype call
    // below; verification, the single retry and the safe-submit gate are
    // unchanged and still judge the outcome either way.
    // THE OMNIBOX TAKES KEYBOARD FOCUS ONLY ON THE SECOND grab_focus (live Alo 2026-10-03, from a product page, with and
    // without the post-add drawer): after the first, a paste lands nowhere — the field still held the page's own URL, the
    // clipboard WAS served, and neither a 1 s wait (0/2) nor a select-all (0/2) changed that; a second grab_focus made the field
    // report focused and the paste land (2/2, inserted before the old URL), and the second focus + a select-all landed the exact
    // value at once (3/3). The single retry below did exactly that, ~3 s later, on EVERY typed URL ("verified after one retry
    // (clipboard paste)"). Only the browser's FIRST omnibox entry misses (typed navigations in one instance: the first retried,
    // the next two landed at once), and the second focus costs 0.3–1.3 s, so it is spent once per browser process; the
    // select-all on every URL paste. The retry below still covers any miss.
    const pasteFirst = shouldPasteUrlFirst({ backend: AUTOMATION_BACKEND, element, value, wantRecovery });
    if (pasteFirst) {
      if (!omniboxFocusedOnce.has(win.pid)) {
        try { await resolveElement(ref ? { ref, win, focus: true } : { text: text || element.name, role: role || element.role, win, focus: true }); } catch {}
        omniboxFocusedOnce.add(win.pid);
      }
      await selectAllKeys(); // replace, never append
      await new Promise((r) => setTimeout(r, 20));
    }
    const firstMethod = await enterValue({
      pasteFirst,
      paste: () => pasteValue(value),
      type: () => typeWithWtype(value, 25),
    });

    // Verify the typed text actually landed before (optionally)
    // submitting. Two real, live-caught ways it silently doesn't: a
    // popup's click-outside-dismiss handler consumes the focusing click so
    // the keystrokes go nowhere, and a focus-expanding search widget eats
    // early keystrokes while restructuring. Verification searches the
    // WHOLE tree for any editable containing the value (not the target
    // element by name — an expanding widget replaces/renames the element
    // the caller targeted, see the combo-box note above). One retry covers
    // the popup case: by then the popup is gone and a fresh click + retype
    // lands.
    const verifyCandidates = [value];
    const strippedUrl = value.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    if (strippedUrl && strippedUrl !== value) verifyCandidates.push(strippedUrl); // omnibox displays URLs scheme-stripped
    const verifyTyped = async () => {
      for (const v of verifyCandidates) {
        try {
          const r = await atspiBridge({
            pid: win.pid, offset_x: win.at[0], offset_y: win.at[1],
            action: "verify_text", value: v,
          });
          if (r.found) return { ...r, needle: v.trim() }; // rev 30b: which candidate matched (its length is the typed prefix)
        } catch {}
      }
      return null;
    };
    // isSubmitSafe (module-level, unit-tested): exact value AND an
    // unambiguous keypress destination — focused, or a sole chrome match
    // WHEN the original target was the omnibox itself (which never reports
    // STATE_FOCUSED). Bound to the original target so a failed in-page type
    // can't be rescued into submitting via a same-valued Find/side-panel
    // field. A sole match INSIDE the page is NOT safe (focus may be on a
    // clear-X).
    const targetCtx = { omnibox: isOmniboxTarget(element) };
    const submitSafe = (f) => isSubmitSafe(f, targetCtx);
    const describeMatch = (f) => {
      const dest = f.focused
        ? "focused "
        : f.candidates === 1 && f.in_doc === false
        ? "sole omnibox (unambiguous) "
        : f.candidates === 1
        ? "sole in-page (focus unconfirmed) "
        : "UNFOCUSED ambiguous ";
      return `text ${f.match === "exact" ? "present" : "present WITH AUTOCOMPLETE SUFFIX"} in ${dest}${f.role} "${f.name}"`;
    };
    let found = await verifyTyped();
    // rev 30b: the omnibox's inline autocomplete — a prefix match whose
    // selection is exactly the completed suffix — is removed with ONE Delete
    // and re-verified; every other prefix shape keeps the refusal below.
    let autocompleteRemoved = false;
    if (found && omniboxAutocompleteDeletion({ omnibox: targetCtx.omnibox, match: found.match, typedLength: found.needle.length, fieldLength: found.text_length, selection: found.selection })) {
      await tapKey("Delete", { settle: false });
      const again = await verifyTyped();
      if (again) { autocompleteRemoved = again.match === "exact"; found = again; }
    }
    let verifyNote;
    // POST-NAVIGATION REF SWAP state (ref_epoch.js): at most one extra cycle.
    let swap = null;
    let swapVerified = false;
    let recovery = null;
    let retryMethod = "slow re-type";
    if (found) {
      // Name the entry method only when it was NOT plain typing, so every
      // pre-existing path's output stays byte-identical and a paste-first
      // navigation is still identifiable in the transcript.
      verifyNote = ` [verified${firstMethod === "typing" ? "" : ` (${firstMethod})`}: ${describeMatch(found)}${autocompleteRemoved ? "; autocomplete suffix removed with one Delete" : ""}]`;
    } else {
      // POST-NAVIGATION REF SWAP (ref_epoch.js; a live run: the
      // composer found right after a page-level route change was replaced by
      // the still-mounting page, so the ref's node was gone before the keys
      // landed). Exactly ONE extra cycle, and only on evidence: the ref was
      // minted inside the post-navigation window of an OBSERVED epoch (or a
      // text-addressed call resolved inside it). The cycle re-resolves the same
      // editable IDENTITY (name + role) fresh through the bridge — never the
      // stale ref, its bounds, coordinates or a blind focus — requires a UNIQUE
      // match on a DIFFERENT node with confirmed editable focus, replaces any
      // partial text (select-all) and re-verifies. It never presses Return. If
      // it typed and still cannot verify, the run reports the honest NOT
      // VERIFIED below without a further retry; if it could not even start
      // (no match / ambiguous / same node / focus unconfirmed), the existing
      // retry + focus-recovery path runs unchanged.
      {
        // Provenance from the ACTUAL resolved target: a ref call keeps the
        // caller's pre-existing ref (its snapshot stamp decides); a text call
        // was resolved by THIS call moments ago (resolveElement stamped it) and
        // is judged as resolved-now in the current epoch, never by epoch age.
        const minted = ref ? (snapshotCache.get(win.pid)?.get(ref) || null) : element;
        const gate = postNavigationRefSwapEligible({
          minted: minted ? { page_epoch: minted.page_epoch, minted_at: minted.minted_at } : null,
          epoch: pageEpochs.get(win.pid) || null,
          resolvedNow: !ref,
        });
        if (gate.eligible) {
          swap = { gate: gate.reason, outcome: "no-match" };
          // Probe WITHOUT focusing (a focus resolve on an ambiguous name would
          // grab one duplicate blindly); only a unique, different node is then
          // focused by its own (doc_gen, obj_path) identity.
          let probe = null;
          try { probe = await resolveElement({ text: element.name, role: element.role, win, focus: false }); } catch {}
          let fresh = null;
          if (!probe) swap.outcome = "no-match";
          else if (probe.matchCount !== 1) swap.outcome = `ambiguous (${probe.matchCount} matches)`;
          else if (element.obj_path && probe.element.obj_path === element.obj_path) swap.outcome = "same-node";
          else if (!probe.element.ref) swap.outcome = "not-actionable";
          else {
            try { fresh = await resolveElement({ ref: probe.element.ref, win, focus: true }); } catch {}
            if (!fresh) swap.outcome = "identity-lost";
          }
          if (fresh) {
            const swapFocus = await focusPlainEditable(fresh.element, { allowFallback: false });
            if (!isOmniboxTarget(fresh.element) && !swapFocus.matches) swap.outcome = "focus-unconfirmed";
            else {
              swap.newRef = fresh.element.ref || null; swap.role = fresh.element.role; swap.name = fresh.element.name;
              await selectAllKeys(); // replace, never append
              await new Promise((r) => setTimeout(r, 20));
              await typeWithWtype(value, 80, { attempt: 2 });
              await new Promise((r) => setTimeout(r, 60));
              found = await verifyTyped();
              swap.outcome = found ? "verified" : "not-verified";
              swapVerified = !!found;
            }
          }
        }
      }
      if (!found && !(swap && swap.outcome === "not-verified")) {
      // Retry — but NEVER by blindly re-clicking coordinates captured
      // before the first attempt (review finding, gh issue #1): a dynamic
      // widget may have replaced the element since then, leaving the old
      // coordinates on e.g. its clear button. Re-resolve the target FRESH
      // (new snapshot, new geometry, new grab_focus); only if it can't be
      // re-resolved, fall back to whatever currently holds focus.
      let retryEl = null;
      let skipPasteRetry = false;
      try {
        // A ref-based call MUST re-resolve by its object-path identity on retry,
        // never by name (issue #5): a name re-search can focus/type into a
        // DIFFERENT duplicate. If the identity is now stale (the widget
        // restructured), resolveElement throws -> retryEl stays null -> we fall
        // into the association-safe focus-recovery path below, never a name
        // search. Text-based calls keep the legacy name/role retry.
        retryEl = (await resolveElement(ref ? { ref, win, focus: true } : { text: text || element.name, role: role || element.role, win, focus: true })).element;
      } catch {}
      if (retryEl) {
        const retryFocus = await focusPlainEditable(retryEl, { priorRole: origSig?.role ?? null, recovery: wantRecovery });
        if (!wantRecovery && !isOmniboxTarget(retryEl) && !retryFocus.matches) {
          const where = retryFocus.focused ? `${retryFocus.focused.doc_class || "unknown"} ${retryFocus.focused.role || "object"} "${retryFocus.focused.name || ""}"` : "nothing has focus";
          return { content: [{ type: "text", text: `Refused to retry typing into ${retryEl.ref} ${retryEl.role} "${retryEl.name}": page editable focus remains unconfirmed (${where}). NOTHING was typed, pasted, or submitted.${swap ? ` One post-navigation re-resolve was also tried (${swap.outcome}).` : ""}` }], isError: true };
        }
        await new Promise((r) => setTimeout(r, 350));
      } else {
        let focusedNow = null;
        try {
          const f = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "get_focused" });
          focusedNow = f.focused;
        } catch {}
        if (!focusedNow || !focusedNow.editable) {
          // The combo restructured, the ORIGINAL widget is gone, and focus
          // landed on a non-editable (e.g. a VS expanding-search 'close'
          // button) or nowhere. This is the TRUE-UNMOUNT case. For combo
          // targets, DON'T bail here — the safe-stop must come AFTER the
          // recovery attempt (review v2 #1): S0-anchored focus-recovery can
          // find a replacement input that mounted elsewhere and was left
          // unfocused. Skip the in-place paste (nothing editable holds focus
          // to paste into) and fall through to recovery below.
          if (wantRecovery) {
            skipPasteRetry = true;
          } else {
            const where = focusedNow ? `focus is on ${focusedNow.role} "${focusedNow.name}"` : "nothing has focus";
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Typed into ${element.ref} ${displayRole} "${displayName}" but the text did NOT land, and the element could not be re-resolved (${where}). ` +
                    `Return was NOT pressed. The widget likely restructured itself on input. ` +
                    `Options: read_page to find a newly-mounted input and type into THAT; check for a blocking dialog (read_page filter_role "dialog"); or use the site's direct search URL from get_site_map.` +
                    (swap ? ` One post-navigation re-resolve was also tried (${swap.outcome}).` : ""),
                },
              ],
              isError: true,
            };
          }
        }
        // An editable does hold focus — retype in place.
      }
      retryMethod = "slow re-type";
      if (!skipPasteRetry) {
      // Retry method (review, gh issue #1 follow-up): atomic CLIPBOARD
      // PASTE, but ONLY on the headless backend. The keystroke-drop this
      // works around is a headless/nested-compositor-under-load phenomenon;
      // on the real desktop a paste would clobber the user's own clipboard for
      // no benefit, so there we re-type slowly instead. Paste is preferred
      // in headless because re-typing at any pace can drop again, while a
      // paste lands the whole value in one event; if wl-copy itself fails
      // (rejects), fall back to the slow re-type there too.
      await selectAllKeys();
      await new Promise((r) => setTimeout(r, 20));
      // Paste is a retry method for the OMNIBOX only: under the nested
      // compositor a clipboard paste lands nothing in an in-document field
      // (measured; see paste_first.js), so there the retry is the segmented,
      // sacrificial-key typing plan — the bounded fallback the local
      // reproduction proved for keystroke-dropping values.
      if (AUTOMATION_BACKEND === "headless" && isOmniboxTarget(retryEl || element)) {
        try {
          await pasteValue(value);
          retryMethod = "clipboard paste";
        } catch {
          await typeWithWtype(value, 80, { attempt: 2 });
        }
      } else {
        retryMethod = AUTOMATION_BACKEND === "headless" ? "segmented re-type" : "slow re-type";
        await typeWithWtype(value, 80, { attempt: 2 });
      }
      await new Promise((r) => setTimeout(r, 60));
      found = await verifyTyped();
      } // end !skipPasteRetry

      // ATOMIC FOCUS RECOVERY: if the retry still didn't land, the target is a
      // wrapper/replacement/unmount widget (grab_focus focused a node that
      // isn't the real text destination, or the original unmounted and a real
      // input mounted elsewhere; VS "Search" -> "Ask anything"). Find + focus
      // the real DIRECT-TEXT-CAPABLE editable ASSOCIATED with the original in
      // ONE bridge op (no pointer, no A/B race), then clear + type + re-verify.
      // Association is anchored on the TRUSTED PRE-FOCUS origSig (landmark +
      // match_count) so it works even when the live original is gone. Exactly
      // ONE recovery attempt — no loop; if it rerenders again, stop.
      recovery = null;
      if (!found && wantRecovery) {
        try {
          recovery = await atspiBridge({
            pid: win.pid, offset_x: win.at[0], offset_y: win.at[1],
            action: "recover_focus",
            text_filter: origSig?.name ?? element.name,
            role_filter: origSig?.role ?? element.role,
            s0, s1,
            s0_truncated: s0Truncated,
            s1_truncated: s1Truncated,
            orig_landmark: origSig?.landmark ?? null,
            orig_match_count: origSig?.matchCount ?? 1,
          });
        } catch {}
        if (recovery && recovery.recovered && recovery.focused) {
          // Re-enter by DIRECT TYPING, not clipboard paste. A recovered target
          // is a real web <input> that grab_focus genuinely focused (verified:
          // synthesized keystrokes land in it char-for-char). Clipboard paste
          // (wl-copy + ctrl+v), by contrast, does NOT land in these
          // freshly-focused web inputs under the nested headless compositor —
          // the selection isn't readable by Chromium at paste time — so it
          // silently leaves the field empty. Typing is proven reliable here and
          // recovery is a rare, correctness-critical last resort, so we always
          // type (both backends) and let verify+safe-stop catch any drop.
          await selectAllKeys();
          await new Promise((r) => setTimeout(r, 20));
          await typeWithWtype(value, 80, { attempt: 2 }); // focus-recovery retype: the bounded segmented fallback, never the first path
          await new Promise((r) => setTimeout(r, 60));
          found = await verifyTyped();
        }
      }

      } // end existing retry + focus-recovery path (skipped after a typed-but-unverified swap)

      const recovered = !!(recovery && recovery.recovered && found);
      verifyNote = found
        ? swapVerified
          ? ` [verified after post-navigation ref swap (${swap.gate}): the original ${element.ref || `"${sanitizeInline(displayName)}"`} was replaced after the page navigated; retyped into fresh ${swap.newRef || "editable"} ${swap.role} "${sanitizeInline(swap.name || "")}": ${describeMatch(found)}]`
          : recovered
          ? ` [verified after focus-recovery to ${recovery.chosen.role} "${recovery.chosen.name}" (${recovery.transition || "existing-descendant"}): ${describeMatch(found)}]`
          : ` [verified after one retry (${retryMethod}): ${describeMatch(found)} — the first attempt's keystrokes were dropped; the retry landed]`
        : recovery && recovery.ambiguous
        ? ` [NOT VERIFIED: focus-recovery found ${(recovery.candidates || []).length} equally-ranked associated editables (${(recovery.candidates || []).join(", ")}) — refusing to guess which is the real input]`
        : recovery && recovery.ambiguous_original
        ? ` [NOT VERIFIED: the target name/role "${displayName}" matches ${recovery.orig_match_count} on-screen widgets — focus-recovery refuses to guess which one to type into; disambiguate with a ref from read_page, then retry]`
        : recovery && recovery.truncated
        ? " [NOT VERIFIED: the page's editable fields could not be completely and reliably enumerated (the page is too large, or the accessibility baseline was unavailable) — focus-recovery refuses to guess which input is real. Return NOT pressed. Use read_page to locate the input and type into it by ref, or the site's direct search URL from get_site_map]"
        : recovery && recovery.orig_gone
        ? " [NOT VERIFIED: the widget restructured on input — the original target unmounted and the overlay exposes no uniquely-associated text input to recover to. Return NOT pressed. Use read_page to find a newly-mounted input and type into THAT, or the site's direct search URL from get_site_map]"
        : " [NOT VERIFIED: no visible editable field contains the typed value after a retry (and focus-recovery found no uniquely-associated real input) — do NOT assume it landed; check the page state (screenshot or read_page filter_role \"dialog\")]";
      if (!found && swap) verifyNote += ` One post-navigation re-resolve was also tried (${swap.outcome}).`;
    }
    // Submit ONLY on verified text (review finding, gh issue #1): after a
    // failed verification, focus may be on a clear button, another
    // control, or browser chrome — a blind Return there is at best a no-op
    // and at worst activates the wrong thing. Callers that are SURE the
    // text landed (e.g. a field that exposes no readable text) can check
    // visually and submit with key_press Return themselves.
    let enterNote = "";
    let navNote = "";
    let navUnverified = false;
    if (press_enter && swapVerified) {
      // The swap path never submits: the field was re-resolved after the page
      // changed, so the caller confirms the page state and presses Return
      // deliberately (key_press) if a submit is still wanted.
      enterNote = " — Return NOT pressed after a post-navigation ref swap: confirm the page state, then key_press Return deliberately if a submit is still wanted";
    } else if (press_enter) {
      if (submitSafe(found)) {
        // The pre-interaction observation taken above is what the report and the
        // token both use — never a value read after the omnibox was touched.
        const prevPageUri = prevPage.state === "known" ? prevPage.uri : null;
        if (targetCtx.omnibox) {
          // The token is created only HERE: at the point verified text is
          // actually submitted, not when typing merely began.
          createPendingToken(win, value, prevPage);
        } else {
          // An in-page submit can navigate; it does not create evidence, it destroys it.
          invalidateTokenFor(win, "in-page Return");
        }
        await new Promise((r) => setTimeout(r, 30));
        await tapKey("Return");
        enterNote = " and pressed Enter";
        // IN-PAGE submit only: observe the transition inline, with no token —
        // this call both typed and submitted, so the pre-typing observation is
        // right here. Same bounded, evidence-only classifier as the token path.
        // The omnibox keeps its own navigation-focus handling below, untouched.
        const observation = await observeInPageSubmitTransition({ omnibox: targetCtx.omnibox, found, prevPage, win });
        if (observation) enterNote += formatSubmitTransitionNote(observation);
        // NAVIGATION-FOCUS OBSERVATION — omnibox targets only.
        // Typing in the address bar opens Chromium's suggestion dropdown, and it
        // can stay open after Enter holding keyboard focus. While it does, the
        // navigated page's accessibility subtree is not exposed: read_page
        // returns browser chrome only and Tab never enters the document, which
        // reads exactly like a dead site.
        //
        // This path deliberately sends NO keystroke. Escape would dismiss the
        // dropdown, but Escape is also Chromium's STOP-LOADING shortcut, and
        // there is no signal in this build that proves the CURRENT navigation
        // finished:
        //   - MEASURED with a slow HTTP response: the PREVIOUS document and its
        //     URI survive the whole in-flight window, so "a page document exists"
        //     is satisfied by a stale page and would license a destructive press.
        //   - MEASURED: no BUSY state is exposed on the document or the frame at
        //     any point during that window.
        //   - A URI change proves a new document only when the URL differs; a
        //     reload or same-URL navigation has no positive signal at all.
        // So the browser-UI case is REPORTED, never pressed, and dismissal is left
        // to the read path, where a settled page can actually be established.
        if (targetCtx.omnibox) {
          const requestedScheme = (String(value).trim().match(/^([a-z][a-z0-9+.-]*):/i)?.[1] || "").toLowerCase();
          const requestedIsBrowserPage = ["chrome", "chrome-untrusted", "chrome-search", "chrome-extension", "devtools", "chrome-error"].includes(requestedScheme);
          // TEST-ONLY (gated): the natural "dropdown holds focus" state was
          // observed live but is not reproducible in a fixture — the omnibox
          // never reports STATE_FOCUSED — so the focus SHAPES are injectable to
          // cover every row deterministically. The classifier is never faked.
          const fault = process.env.COMPUTER_USE_TEST_NAV_FOCUS;
          const navFocus = async () => {
            if (fault) {
              const internal = { focused: { role: "combo box", name: "Ask AI Mode", doc_uri: "chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html", doc_class: "browser_internal" }, doc_class: "browser_internal", doc_uri: "chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html", page_content_nodes: 0, page_document_present: true, page_document_uri: prevPageUri || "https://example.test/previous" };
              if (fault === "internal") return internal;
              if (fault === "internal_stale_page") return { ...internal, page_document_uri: prevPageUri };
              if (fault === "none") return { focused: null, doc_class: "none", doc_uri: null, page_content_nodes: 0, page_document_present: false, page_document_uri: null };
              if (fault === "unknown") return { focused: { role: "section", name: "", doc_uri: null, doc_class: "unknown" }, doc_class: "unknown", doc_uri: null, page_content_nodes: 0, page_document_present: false, page_document_uri: null };
            }
            try { return await atspiBridge({ pid: win.pid, action: "navigation_focus" }); } catch { return null; }
          };
          const cls = (n) => (n && n.focused ? n.doc_class : n ? "none" : "error");
          const describeNav = (n) => `${n?.focused ? `${n.focused.role} "${n.focused.name}"` : "nothing focused"}${n?.doc_uri ? ` in ${n.doc_uri}` : ""}`;
          // Wait only for a DECIDABLE classification. No keystroke follows, so
          // there is nothing to gate on a completion signal that does not exist.
          let nav = null;
          const settleBy = Date.now() + 5000;
          do {
            await new Promise((r) => setTimeout(r, 400));
            nav = await navFocus();
          } while (!["page", "browser_internal"].includes(cls(nav)) && Date.now() < settleBy);

          // NO COMMIT AFTER THE RETURN (lead 2026-10-03: "typed + verified, but the tab never left" — 3 sightings in a day, Alo's
          // pre-open /cart, Gymshark's product URL after the clipboard-paste retry). The page document is still the PREVIOUS url,
          // the requested one differs (never a same-URL reload, never a browser page): the state is LOGGED, and Return is pressed
          // ONCE more only when the omnibox still holds EXACTLY the typed URL with an unambiguous destination (the same
          // isSubmitSafe gate the first Return passed) — a second Return there can only navigate to that same URL. Never another
          // key: Escape stays forbidden (stop-loading).
          const sameAsPrevious = (() => { try { return !!prevPageUri && new URL(String(value).trim()).href.replace(/\/$/, "") === new URL(prevPageUri).href.replace(/\/$/, ""); } catch { return false; } })();
          let noCommit = !!prevPageUri && !requestedIsBrowserPage && !sameAsPrevious && (!nav?.page_document_uri || nav.page_document_uri === prevPageUri);
          // …a navigation still IN FLIGHT also shows the previous document (measured, above): up to 3 s more for the address to move
          for (const until = Date.now() + 3000; noCommit && Date.now() < until;) {
            await new Promise((r) => setTimeout(r, 500));
            nav = await navFocus();
            noCommit = !nav?.page_document_uri || nav.page_document_uri === prevPageUri;
          }
          if (noCommit) {
            const again = await verifyTyped();
            const omniboxState = again ? `${again.match}${again.focused ? ", focused" : again.candidates === 1 && again.in_doc === false ? ", sole omnibox match" : ", NOT focused"}` : "the typed URL is no longer in it";
            console.error(`[omnibox] no commit after Return: page still ${prevPageUri}; focus ${describeNav(nav)}; omnibox: ${omniboxState}`);
            if (again && again.match === "exact" && submitSafe(again)) {
              await tapKey("Return");
              enterNote += " [the first Return did not navigate: Return pressed ONCE more — the address bar still held exactly the typed URL, with an unambiguous destination]";
              const again2By = Date.now() + 5000;
              do {
                await new Promise((r) => setTimeout(r, 400));
                nav = await navFocus();
              } while ((!nav?.page_document_uri || nav.page_document_uri === prevPageUri) && Date.now() < again2By);
              console.error(`[omnibox] after the one re-press: page ${nav?.page_document_uri || "(none)"}${nav?.page_document_uri && nav.page_document_uri !== prevPageUri ? " — committed" : " — still not committed"}`);
            }
          }

          // Whether this navigation COMMITTED is a question about the page
          // document's URI, and is independent of where focus happens to sit.
          // Resolving only inside the page-focus branch left the token pending
          // forever exactly when the dropdown held focus — i.e. in the one case
          // the later recovery exists to handle.
          if (nav?.page_document_uri) resolveTokenIfNavigated(win, nav.page_document_uri);
          if (cls(nav) === "page") {
            // Say only what was observed. The page document may still be the
            // PREVIOUS one (measured: it survives the whole in-flight window),
            // so "focus is in a page" must not be dressed up as "the requested
            // page is ready".
            const stillPrevious = prevPageUri && nav.page_document_uri === prevPageUri;
            if (stillPrevious) {
              // FAIL CLOSED. Saying "this may not have committed" while returning
              // success is a contradiction the caller cannot act on. A same-URL
              // reload stays in this branch by design: this build exposes no
              // signal that distinguishes "reloaded" from "never started", and
              // an unprovable navigation must not report ready.
              navUnverified = true;
              navNote = ` — NAVIGATION FOCUS UNVERIFIED: focus is in a page document, but that document is still the PREVIOUS url (${prevPageUri}), so the requested page is not proven to have committed. Call read_after_navigation with the requested URL next; do not use an ordinary read_page or resubmit the URL`;
            } else {
              navNote = ` [navigation focus verified: ${describeNav(nav)}]`;
            }
          } else if (cls(nav) === "browser_internal" && requestedIsBrowserPage) {
            navNote = ` [navigation focus verified: ${describeNav(nav)} — a browser page was requested, so browser-internal focus is expected]`;
          } else if (cls(nav) === "browser_internal") {
            navUnverified = true;
            navNote = ` — NAVIGATION FOCUS UNVERIFIED: the browser's own UI (${describeNav(nav)}) holds keyboard focus, so the page's accessibility tree may expose nothing yet. NOTHING was pressed: Escape is the stop-loading shortcut, and there is no signal proving the navigation finished. Call read_after_navigation with the requested URL next; do not use an ordinary read_page or resubmit the URL`;
          } else {
            navUnverified = true;
            navNote = ` — NAVIGATION FOCUS UNVERIFIED: ${cls(nav) === "none" ? "nothing holds keyboard focus" : "the focused node's document could not be identified"} (${describeNav(nav)}). Call read_after_navigation with the requested URL next; do not use an ordinary read_page or resubmit the URL`;
          }
        }
      } else if (found && found.match === "prefix") {
        enterNote =
          " — Return NOT pressed: the field contains MORE than the requested value (autocomplete completion). Submitting would send the completed text, not what was asked. Clear-and-retype, or key_press Return yourself to deliberately accept the completion";
      } else if (found) {
        enterNote =
          " — Return NOT pressed: the value is present but the field is not confirmed focused (a sole in-page match can coexist with focus on a clear-X/button), so Return could go to a different control. Click the field, then key_press Return";
      } else {
        enterNote = " — Return NOT pressed (refusing to submit unverified text)";
      }
    }
    // ARM the submit-transition token: this call typed verified text into a
    // focused in-page field and did NOT submit, so the very next plain Return
    // is a submit worth observing. The baseline is the PRE-TYPING page URI
    // already captured above — no extra read is taken here, and a baseline that
    // was never captured stays null, which the classifier reports as
    // unobservable rather than guessing.
    if (canArmSubmitToken({ omnibox: targetCtx.omnibox, pressEnter: press_enter, found, submitSafe: submitSafe(found) })) {
      submitTokens.arm(tokenKey(win), {
        baselineUri: prevPage.state === "known" ? prevPage.uri : null,
        target: { obj_path: element.obj_path ?? null, doc_gen: element.doc_gen ?? null },
      });
    }
    return {
      content: [
        {
          type: "text",
          text: `Typed into ${element.ref} ${displayRole} "${displayName}"${enterNote}${verifyNote}${navNote}`,
        },
      ],
      ...(navUnverified || (press_enter && !submitSafe(found)) ? { isError: true } : {}),
    };
  }
);

server.registerTool(
  "scroll_to_element",
  {
    title: "Scroll an element into view (reliable — not simulated)",
    description:
      "Scroll the page so an element (found by text/role, or a ref from read_page) is visible, using the accessibility API's own " +
      "scroll-into-view action rather than simulating wheel/keyboard scrolling. This is the reliable way to reach below-the-fold " +
      "content — some pages silently ignore simulated wheel/Page_Down events (e.g. pinned image galleries) but this always works. " +
      "Also useful to bring a nearby landmark into view before using screenshot on content that itself has no accessible representation " +
      "(e.g. a canvas-based size picker) — scroll to a labeled heading near it, then screenshot.",
    inputSchema: z.object({
      ref: z.string().optional(),
      text: z.string().optional(),
      role: z.string().optional(),
      window_address: z.string().optional(),
    }).strict(),
  },
  async ({ ref, text, role, window_address }) => {
    const win = await resolveWindow(window_address);
    const { element } = await resolveElement({ ref, text, role, win });
    // Report only what actually happened. The bridge scrolls a POSITIVELY page
    // surface and nothing else, so without both the provenance and the
    // scrolled flag this call did not scroll anything — and it must not say it
    // did. The old wording also printed the ref unconditionally, which for an
    // ineligible node (no ref is minted for one) read as "Scrolled to
    // undefined".
    const refusal = scrollRefusalFor(element);
    if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
    return {
      content: [{ type: "text", text: `Scrolled to ${element.ref} ${element.role} "${element.name}" @${element.cx},${element.cy}` }],
    };
  }
);

// Read-only: what a dropdown currently shows, without opening it. The private
// address fill uses it to leave a Country dropdown alone when it already shows
// the destination: re-choosing it reset Bath & Body Works' form to its first,
// ZIP-only step (live 2026-09-23). Supervisor-only (hidden from the model).
server.registerTool(
  "read_selected_option",
  {
    title: "Read a dropdown's current value",
    description: "Return the option a dropdown (combo box) currently reports selected, or the value it displays. Never opens or changes it.",
    inputSchema: z.object({
      combo_ref: z.string().optional(),
      combo_text: z.string().optional(),
      combo_role: z.string().default("combo box"),
      window_address: z.string().optional(),
    }).strict(),
  },
  async ({ combo_ref, combo_text, combo_role, window_address }) => {
    const win = await resolveWindow(window_address);
    const { element: combo, objPath, docGen } = await resolveElement({ ref: combo_ref, text: combo_text, role: combo_role, win });
    if (!combo) return { content: [{ type: "text", text: `No dropdown found matching ${combo_ref || combo_text}.` }], isError: true };
    let res = null;
    try { res = await atspiBridge({ pid: win.pid, action: "get_selected", text_filter: combo.name, role_filter: combo.role, ...(objPath ? { obj_path: objPath, doc_gen: docGen } : {}) }); } catch (e) { res = { error: e.message }; }
    if (!res || res.error || res.stale_ref) return { content: [{ type: "text", text: `Could not read the dropdown (${res?.error || res?.reason || res?.status || "no result"}).` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify({ selected: res.selected ?? null, shown: res.shown ?? null }) }] };
  }
);

// Supervisor-only: give a form field keyboard focus (grab_focus on the ref's exact identity), without a click and
// its 2 s wait for a page transition that focusing never produces. The private fill uses it before picking the
// browser's saved address. Returns {focused}.
server.registerTool(
  "focus_field",
  {
    title: "Focus a form field",
    description: "Give a form field (by ref) keyboard focus. Returns whether it is focused.",
    inputSchema: z.object({ ref: z.string(), window_address: z.string().optional() }).strict(),
  },
  async ({ ref, window_address }) => {
    const win = await resolveWindow(window_address);
    try {
      const { element } = await resolveElement({ ref, win, focus: true });
      if (!["entry", "combo box", "password text"].includes(element?.role)) return { content: [{ type: "text", text: "Refused: not a form field." }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ focused: !!element.focused }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Could not focus ${ref}: ${String(e?.message || e).slice(0, 160)}` }], isError: true };
    }
  }
);

// Supervisor-only: is Chrome's own address-autofill dropdown open (so Return picks the saved address and cannot
// submit the page's form)? Returns {open, rows}, never the rows' text.
server.registerTool(
  "autofill_popup_state",
  {
    title: "Is Chrome's address autofill dropdown open",
    description: "Whether the browser's own saved-address dropdown is open. Never returns its text.",
    inputSchema: z.object({ window_address: z.string().optional() }).strict(),
  },
  async ({ window_address }) => {
    const win = await resolveWindow(window_address);
    let res = null;
    try { res = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "autofill_popup" }); } catch (e) { res = { error: e.message }; }
    if (!res || res.error) return { content: [{ type: "text", text: `Could not read the browser (${res?.error || "no result"}).` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify({ open: !!res.open, rows: res.rows || 0, manage_selected: !!res.manage_selected }) }] };
  }
);

// Supervisor-only (never offered to the agent model): the private-address fill confirms what an address
// suggestion wrote into City/ZIP/street. It returns match / differs / empty / missing per field, never the text.
server.registerTool(
  "check_field_values",
  {
    title: "Check form fields against expected values",
    description: "For each {name, expect, mode}: whether the visible form field with that name holds the value (match / differs / empty / missing). Never returns field text.",
    inputSchema: z.object({
      checks: z.array(z.object({ name: z.string(), expect: z.string(), mode: z.enum(["exact", "street"]).default("exact") }).strict()).min(1).max(12),
      window_address: z.string().optional(),
    }).strict(),
  },
  async ({ checks, window_address }) => {
    const win = await resolveWindow(window_address);
    let res = null;
    try { res = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "field_checks", checks }); } catch (e) { res = { error: e.message }; }
    if (!res || res.error || !Array.isArray(res.statuses)) return { content: [{ type: "text", text: `Could not read the form (${res?.error || "no result"}).` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(res.statuses) }] };
  }
);

server.registerTool(
  "select_option",
  {
    title: "Select a dropdown/<select> option reliably",
    description:
      "Select an option from a dropdown (combo box). Use this instead of click_element for dropdowns — some dropdowns are native " +
      "browser <select> popups whose options are ALL reported at the exact same coordinate by the accessibility tree (a known " +
      "Chromium/AT-SPI limitation for virtualized native selects), which makes clicking by coordinate silently select the WRONG " +
      "option. This tool detects that case automatically and falls back to type-ahead (typing the option text at a realistic pace) " +
      "instead of guessing a click position — position-independent, so it doesn't matter what was previously selected. It then " +
      "reads the dropdown back: the result says [verified: …] when the chosen option reports selected, FAILED when a different " +
      "one does, and otherwise returns a cropped screenshot to check before trusting the selection.",
    inputSchema: z.object({
      combo_ref: z.string().optional(),
      combo_text: z.string().optional().describe("Accessible name of the dropdown, e.g. 'State'."),
      combo_role: z.string().default("combo box"),
      option_text: z.string().describe("Exact visible text of the option to select, e.g. 'California'."),
      window_address: z.string().optional(),
    }).strict(),
  },
  async ({ combo_ref, combo_text, combo_role, option_text, window_address }) => {
    const win = await resolveWindow(window_address);
    const { element: combo, objPath: comboObjPath, docGen: comboDocGen } = await resolveElement({ ref: combo_ref, text: combo_text, role: combo_role, win });
    const readBackNow = async () => {
      try {
        let r = await atspiBridge({ pid: win.pid, action: "get_selected", text_filter: combo.name, role_filter: combo.role, ...(comboObjPath ? { obj_path: comboObjPath, doc_gen: comboDocGen } : {}) });
        if (r?.stale_ref) r = await atspiBridge({ pid: win.pid, action: "get_selected", text_filter: combo.name, role_filter: combo.role });
        return r;
      } catch { return null; }
    };

    // SEMANTIC FIRST: choose the option through its own accessibility action
    // (or the list's Selection interface) without opening the dropdown or
    // typing. It counts only when the read-back proves it; otherwise the
    // open-and-pick path below runs as before.
    let choseTried = false;
    try {
      choseTried = true;
      const choose = () => atspiBridge({ pid: win.pid, action: "choose_option", text_filter: combo.name, role_filter: combo.role, option_text, ...(comboObjPath ? { obj_path: comboObjPath, doc_gen: comboDocGen } : {}) });
      let chose = await choose();
      let back = null;
      if (chose?.status === "invoked") {
        await new Promise((r) => setTimeout(r, 400));
        back = await readBackNow();
        // A FIRST CHOICE THE PAGE IGNORES (live Coach checkout State 2026-10-08, probed: the first accessibility choice never
        // applies — read back empty at 0.4 s and at 1 s — and the second always does; by ref that meant ~2 s and a refusal,
        // by name the type-ahead fallback, 3.4 s): the same choice once more before any other path.
        if (!back?.stale_ref && selectionReadBack(option_text, back).kind !== "verified") {
          const again = await choose().catch(() => null);
          if (again?.status === "invoked") { chose = again; await new Promise((r) => setTimeout(r, 400)); back = await readBackNow(); }
        }
      }
      if (chose?.status === "invoked") {
        // THE CHOICE RELOADED THE PRODUCT (Amazon 2026-10-07: choosing shoe size "9.5" navigated to that size's own /dp/ page, the
        // dropdown was rebuilt, and the read-back's ref went stale — reported as "Refused", though the size WAS chosen): say so.
        if (back?.stale_ref) {
          return { content: [{ type: "text", text: `Chose "${option_text}" in "${combo.name}" via its accessibility action, and the page then rebuilt (a new product page for that option: its dropdown is a new element). Re-read the page to confirm "${option_text}" is the selected option before going on.` }] };
        }
        const verdict = selectionReadBack(option_text, back);
        if (verdict.kind === "verified") {
          return { content: [{ type: "text", text: `Selected "${option_text}" in "${combo.name}" via its accessibility ${chose.via.replace("action:", "'") + (chose.via.startsWith("action:") ? "' action" : " interface")} [verified: ${verdict.evidence}].` }] };
        }
      }
    } catch { /* fall through to the open-and-pick path */ }

    // OPENING THE COMBO MUST PRESERVE REF IDENTITY (issue #5). A coordinate
    // click here would open whatever now sits at coordinates captured before
    // the identity-resolving bridge process exited — after a rerender that can
    // be a DIFFERENT duplicate combo. For a combo_ref we therefore open it via
    // its OWN AT-SPI action, resolved atomically by object-path identity, and
    // fail closed if it exposes no usable action or the identity went stale.
    // Text-based callers keep the legacy coordinate open.
    if (comboObjPath) {
      let act;
      try {
        act = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "semantic_activate", text_filter: combo.name, role_filter: combo.role, obj_path: comboObjPath, doc_gen: comboDocGen });
      } catch (e) {
        return { content: [{ type: "text", text: `Could not open ${combo.role} "${combo.name}" by ref: semantic_activate failed (${e.message}). NOT falling back to a coordinate click.` }], isError: true };
      }
      if (act && act.stale_ref && choseTried) {
        return { content: [{ type: "text", text: `Tried "${option_text}" in "${combo.name}" via its accessibility action, and the page then rebuilt (a new product page for that option: its dropdown is a new element). Re-read the page to confirm "${option_text}" is the selected option before going on.` }] };
      }
      if (act && act.stale_ref) {
        return { content: [{ type: "text", text: `Refused: combo ref is stale — ${act.reason || act.status}. Call read_page again and use a fresh ref.` }], isError: true };
      }
      const cls = classifyActivation(act);
      if (cls.kind !== "invoked") {
        return { content: [{ type: "text", text: `Refused: ${combo.role} "${combo.name}" resolved by ref identity but could not be opened semantically (${cls.reason || cls.kind}) — NOT falling back to a coordinate click, which could open a different duplicate. Use combo_text (coordinate path) if you accept that risk, or a different control.` }], isError: true };
      }
      await new Promise((r) => setTimeout(r, 350));
    } else {
      await moveMouseRaw(combo.cx, combo.cy);
      await new Promise((r) => setTimeout(r, 30));
      await clickButton("left", 1);
      await new Promise((r) => setTimeout(r, 350));
    }

    const optionsSnap = await snapshotWindow(win, { roleFilter: "menu item", limit: 300 });
    const needle = option_text.trim().toLowerCase();
    const index = optionsSnap.elements.findIndex((el) => el.name.trim().toLowerCase() === needle);
    if (index === -1) {
      return {
        content: [{ type: "text", text: `No option found matching "${option_text}" in the open dropdown.` }],
        isError: true,
      };
    }

    // Coordinate-distinctness alone isn't a reliable signal — a virtualized
    // native <select> only collapses OFF-SCREEN options to a shared fallback
    // coordinate, so which options look "distinct" shifts depending on where
    // the list auto-scrolled to (e.g. near a prior selection). List length is
    // a more stable proxy: long lists (states, countries) are almost always
    // native/virtualized selects best handled with type-ahead; short lists
    // (sort/filter menus) are usually custom-rendered and click reliably.
    const isVirtualized = optionsSnap.elements.length > 8;

    let method;
    if (isVirtualized) {
      // Arrow-key counting (Home + N×Down) turned out to be unreliable here —
      // this widget moves relative to whatever was previously selected, not
      // an absolute "Home" position, so a prior selection throws the count
      // off by however far away it was. Type-ahead search doesn't depend on
      // the starting position at all — type the target text at a realistic
      // per-keystroke pace (native/ARIA comboboxes filter as you type; too
      // fast and the events can coalesce into a garbled match).
      method = "type-ahead";
      // -s 100: see type_text — avoids intermittently dropping the leading character.
      await typeWithWtype(optionsSnap.elements[index].name, 80);
      await new Promise((r) => setTimeout(r, 200));
      await tapKey("Return");
    } else {
      method = "click";
      const target = optionsSnap.elements[index];
      await moveMouseRaw(target.cx, target.cy);
      await new Promise((r) => setTimeout(r, 30));
      await clickButton("left", 1);
    }
    await new Promise((r) => setTimeout(r, 400));

    // Read the dropdown back. A proven selection says so; a DIFFERENT selected
    // value is a failure; a control that exposes neither keeps the old
    // unverified wording (live Coach: type-ahead "selected" California, the
    // page said "State is required.", and the address fill trusted it).
    const verdict = selectionReadBack(option_text, await readBackNow());
    if (verdict.kind === "verified") {
      return { content: [{ type: "text", text: `Selected "${option_text}" (index ${index}) in "${combo.name}" via ${method} navigation [verified: ${verdict.evidence}].` }] };
    }
    if (verdict.kind === "contradicted") {
      return { content: [{ type: "text", text: `FAILED: after choosing "${option_text}" in "${combo.name}" via ${method} navigation, ${verdict.evidence} — the selection did not take.` }], isError: true };
    }

    const region = {
      x: Math.max(0, combo.x - 20),
      y: Math.max(0, combo.y - 60),
      width: Math.min(win.size[0], combo.w + 300),
      height: 220,
    };
    const base64 = await screenshotToBase64(region);
    return {
      content: [
        {
          type: "text",
          text: `Selected "${option_text}" (index ${index}) in "${combo.name}" via ${method} navigation. UNVERIFIED: the dropdown did not report its value${verdict.evidence ? ` (${verdict.evidence})` : ""}. VERIFY against the screenshot below before proceeding — do not assume this worked.`,
        },
        { type: "image", data: base64, mimeType: "image/png" },
      ],
    };
  }
);

server.registerTool(
  "recover_visual_overlay",
  {
    title: "Recover from an accessibility-invisible overlay",
    description:
      "Use only after a screenshot visibly shows an overlay while an unfiltered accessibility read exposes zero page content. Click exactly one screenshot-identified neutral point inside the overlay, press Escape exactly once, then verify that the same document became readable and no accessible dialog remains. This reports restored readability, never an unobservable claim that the visual overlay closed. Do not retry on failure.",
    inputSchema: z.object({
      x: z.number().int().min(0).max(10000),
      y: z.number().int().min(0).max(10000),
      expected_url: z.string().url(),
      window_address: z.string().optional(),
    }).strict(),
  },
  async ({ x, y, expected_url, window_address }) => {
    const win = await resolveWindow(window_address);
    const contentCount = (snap) => snap.elements.filter((entry) => entry.doc_class === "page" && CONTENT_ROLES.has(entry.role)).length;
    const before = await snapshotWindow(win, { includeText: true, limit: 500, pageInfo: true });
    if (contentCount(before) !== 0) return { content: [{ type: "text", text: "Refused visual-overlay recovery: the page already exposes content, so the zero-content precondition is false." }], isError: true };
    await moveMouseRaw(x, y);
    await clickButton("left", 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (INPUT_STATS_ENABLED) inputStats.escapes++;
    await tapKey("Escape");
    const deadline = Date.now() + 3000;
    let after, outcome;
    do {
      await new Promise((resolve) => setTimeout(resolve, 250));
      after = await snapshotWindow(win, { includeText: true, limit: 500, pageInfo: true });
      outcome = classifyVisualOverlayRecovery({ beforeContent: 0, expectedUrl: expected_url, observedUrl: after.page?.url, afterContent: contentCount(after), afterDialogs: after.elements.filter((entry) => entry.doc_class === "page" && entry.role === "dialog").length });
    } while (!outcome.success && Date.now() < deadline);
    if (!outcome.success) return { content: [{ type: "text", text: `Visual-overlay recovery failed: ${outcome.reason}. One click and one Escape were attempted; nothing else was sent.` }], isError: true };
    await recordVisit(win, after.elements, after.page).catch(() => {});
    return { content: [{ type: "text", text: `[visual-overlay recovery verified: same document now exposes ${contentCount(after)} page-content elements; this verifies readability, not the visual overlay's disappearance]\n# ${after.page?.title || ""} (${after.page?.url || ""})\n${formatElements(after.elements)}` }] };
  }
);

/** read_after_navigation's handler, with every observation injectable (deps) so a
 * scripted bridge can count exactly which reads happen: readUri (the URL gate),
 * snapshot (full reads and the link scan), getToken, recordVisit, learnSearchRoute,
 * sleep and now. The registered tool calls it with the real dependencies. */
export async function readAfterNavigationAction({ expected_url, expected_heading, accept_product_link = false, search_query, window_address, timeout_ms = NAVIGATION_READY_BUDGET_MS, poll_ms = 300, limit = 500 }, deps = {}) {
    const resolveWin = deps.resolveWindow || ((address) => resolveWindow(address));
    const readUri = deps.readUri || ((win) => observePageUri(win));
    const snapshot = deps.snapshot || ((win, opts) => snapshotWindow(win, opts));
    const tokenOf = deps.getToken || ((win) => getToken(win));
    const visit = deps.recordVisit || ((win, elements, page) => recordVisit(win, elements, page));
    const learn = deps.learnSearchRoute || ((observed, expected, query) => learnSearchRoute(observed, expected, query));
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = deps.now || Date.now;
    let expected;
    try { expected = new URL(expected_url); } catch { return { content: [{ type: "text", text: "expected_url is invalid" }], isError: true }; }
    // search_query is the SUBMITTED SEARCH TEXT and nothing else. It is kept
    // separate from expected_heading on purpose: a heading is whatever the page
    // titles its results with ("Search results", "132 items"), which is not the
    // query, and learning a URL pattern from one would bind the wrong datum
    // whenever a heading happened to equal a parameter value. Outside search
    // mode there is no submitted query to learn from, so supplying it here is
    // an error rather than something silently ignored.
    const learning = searchRouteLearningQuery({ acceptProductLink: accept_product_link, searchQuery: search_query });
    if (!learning.ok && learning.reason !== "no-search-query") {
      return { content: [{ type: "text", text: `search_query rejected (${learning.reason}): it must be the exact non-empty search text you submitted, at most 200 characters, and passed together with accept_product_link true. Omit it for any non-search destination.` }], isError: true };
    }
    if (expected.protocol !== "https:" && expected.protocol !== "http:") return { content: [{ type: "text", text: "expected_url must be http(s)" }], isError: true };
    const win = await resolveWin(window_address);
    const deadline = now() + timeout_ms;
    let snap = { elements: [], page: null }, readiness = { ready: false, reason: "not-observed" };
    // Supplementary link-scan instrumentation. The broad snapshot below walks
    // EVERYTHING in pre-order and stops at `limit`, so on a results page with a
    // large header/facet region the element budget can be spent before the
    // first product tile — readiness then reports product-link-missing while
    // the links really exist. The deterministic fixture replay
    // (test_readiness_truncation.mjs) proves this systemic mechanism; it is a
    // CANDIDATE explanation for the live eBay/REI/Best Buy first-search false
    // negatives (their raw failing snapshots were not preserved, so late
    // hydration may account for part of those incidents — this scan narrows
    // that window too, but does not prove their cause). A
    // role-filtered walk spends budget only on links, so it reaches the results
    // region regardless of what precedes it. Bounded on purpose: at most ONE
    // supplementary scan per poll, and only when the pure shouldRunLinkScan
    // gate holds — a search destination (accept_product_link) whose broad
    // snapshot found no qualifying link, was actually truncated (a snapshot
    // smaller than its limit covered the whole tree, so a second walk of the
    // same tree can prove nothing more), and failed for the one reason a scan
    // can cure (product-link-missing). Merged evidence is additive only — the
    // same fail-closed gates (same-origin, product-shaped path, page document)
    // apply to it.
    let linkScans = 0, linkScanMs = 0, scanDecided = false;
    let candidates = [];
    // rev 22 (cut 2, phase A): the URL GATE. While the browser has not reached
    // the destination (destination-mismatch / query-mismatch / no readable URI)
    // no element can make the page ready, so a full snapshot proves nothing
    // and only costs — live (Best Buy 33ad2f9f) a 6 s wait was ~8 full 500-row
    // walks. The gate polls the ONE-call page_document_uri probe instead (the
    // same observePageUri as the direct-navigation observation, so page epochs
    // are fed) and takes no snapshot until the URL verdict passes. The gate is
    // re-armed if a later snapshot's own URL verdict regresses (the page moved
    // on again). One exception, kept from before: a query-mismatch reading that
    // is canonical-rewrite-eligible needs LINK evidence, so it goes straight to
    // the snapshot path. After the gate the polls are exactly what they were.
    let urlReached = false;
    let lastReadWasFull = false;
    const urlPending = (reason) => reason === "invalid-url" || reason === "destination-mismatch" || reason.startsWith("query-mismatch:");
    while (true) {
      if (!urlReached) {
        const uri = await readUri(win);
        const verdict = navigationReady({ expectedUrl: expected_url, observedUrl: uri, expectedHeading: expected_heading, acceptProductLink: accept_product_link, elements: [] });
        const rewriteEligible = verdict.reason.startsWith("query-mismatch:") && canonicalSearchRewriteReady({ expectedUrl: expected_url, observedUrl: uri, token: tokenOf(win), hasProductLink: true });
        if (urlPending(verdict.reason) && !rewriteEligible) {
          readiness = verdict;
          snap = { elements: [], page: uri ? { url: uri, title: "" } : null };
          lastReadWasFull = false;
          if (now() >= deadline) break;
          await sleep(Math.min(poll_ms, Math.max(0, deadline - now())));
          continue;
        }
        urlReached = true;
      }
      snap = await snapshot(win, { includeText: true, limit, pageInfo: true });
      lastReadWasFull = true;
      candidates = accept_product_link ? productLinkCandidates(snap.elements, expected_url) : [];
      scanDecided = false;
      const evaluate = (elements) => navigationReady({ expectedUrl: expected_url, observedUrl: snap.page?.url, observedTitle: snap.page?.title, expectedHeading: expected_heading, acceptProductLink: accept_product_link, elements });
      readiness = evaluate(snap.elements);
      // Reason-gated (audited): a scan can cure ONLY product-link-missing on a
      // capped snapshot — destination-mismatch means the navigation is still in
      // flight and url-and-dialog is already ready, so scanning there only
      // burned time — plus one deliberate exception: a query-mismatch poll that
      // would be INDEPENDENTLY eligible for canonical-rewrite acceptance if
      // link evidence existed (hypothetical hasProductLink:true). The scan then
      // supplies that evidence; the REAL canonicalSearchRewriteReady below,
      // with actual candidates, stays the fail-closed decision. shouldRunLinkScan
      // is the pure, tested form of this gate.
      const canonicalRewriteEligible = readiness.reason.startsWith("query-mismatch:") && canonicalSearchRewriteReady({
        expectedUrl: expected_url, observedUrl: snap.page?.url, token: tokenOf(win), hasProductLink: true,
      });
      if (shouldRunLinkScan({ acceptProductLink: accept_product_link, candidateCount: candidates.length, elementCount: snap.elements.length, limit, reason: readiness.reason, canonicalRewriteEligible })) {
        const scanStart = now();
        const linkSnap = await snapshot(win, { roleFilter: "link", limit: 500 }).catch(() => null);
        linkScans += 1;
        linkScanMs += now() - scanStart;
        if (linkSnap) {
          const readinessElements = mergeReadinessElements(snap.elements, linkSnap.elements);
          candidates = productLinkCandidates(readinessElements, expected_url);
          scanDecided = candidates.length > 0;
          readiness = evaluate(readinessElements);
        }
      }
      if (!readiness.ready && readiness.reason.startsWith("query-mismatch:") && canonicalSearchRewriteReady({
        expectedUrl: expected_url, observedUrl: snap.page?.url, token: tokenOf(win), hasProductLink: candidates.length > 0,
      })) readiness = { ready: true, reason: "url-query-rewritten-and-product-link" };
      // Ready but still loading: keep polling while the budget lasts, since the
      // tree may be a stale part of the page (see PAGE_LOADING_NOTE).
      if (readiness.ready && snap.page?.busy && now() + poll_ms < deadline) {
        await sleep(poll_ms);
        continue;
      }
      if (readiness.ready) {
        await visit(win, snap.elements, snap.page).catch(() => {});
        if (learning.ok && readiness.reason !== "url-query-rewritten-and-product-link") await learn(snap.page?.url, expected_url, learning.query);
        const header = `${formatPageUrlMarker(snap.page?.url)}# ${sanitizeInline(snap.page?.title || "")} (${sanitizeInline(snap.page?.url || "")})\n`;
        const guidance = navigationReadyGuidance(readiness.reason);
        const scanNote = scanDecided ? `[the broad snapshot hit its ${limit}-element cap before any product link; a role-filtered link scan (${linkScans} scan(s), ${linkScanMs}ms total) supplied the product-link evidence — use the candidates below, whose refs are valid]\n` : "";
        const candidateText = candidates.length ? `[product candidates]\n${formatElements(candidates)}\n[/product candidates]\n` : "";
        return { content: [{ type: "text", text: `[navigation ready: ${readiness.reason}]\n${snap.page?.busy ? PAGE_LOADING_NOTE : ""}${guidance ? `${guidance}\n` : ""}${scanNote}${candidateText}${header}${formatElements(snap.elements)}` }] };
      }
      if (urlPending(readiness.reason)) urlReached = false; // the page moved on again: back to the gate
      if (now() >= deadline) break;
      await sleep(Math.min(poll_ms, Math.max(0, deadline - now())));
    }
    // The not-ready report keeps its rows: when the budget ran out inside the
    // URL gate, ONE full read of whatever page the browser shows (the old loop's
    // last poll was a full read too, so the report's shape and cost are unchanged).
    if (!lastReadWasFull) { try { snap = await snapshot(win, { includeText: true, limit, pageInfo: true }); } catch { /* keep the gate's reading */ } }
    const header = snap.page?.url ? ` Last observed: ${sanitizeInline(snap.page.title || "")} (${sanitizeInline(snap.page.url)}).` : " No page URL was observable.";
    // rev 30a: one evidence sentence inside the diagnostic log's prefix, so a
    // miss is classifiable afterwards — late hydration (uncapped snapshot, no
    // link), a capped snapshot the link scan could not cure, or a link shape.
    const finalCandidates = accept_product_link ? productLinkCandidates(snap.elements, expected_url).length : 0;
    const scanState = linkScans > 0 ? `ran (${linkScans})` : snap.elements.length >= limit ? "not run" : "not run (snapshot uncapped)";
    const evidenceNote = ` Last snapshot: ${snap.elements.length} elements (cap ${limit}), ${finalCandidates} product-shaped links; link scan: ${scanState}.`;
    const scanNote = linkScans > 0 ? ` A role-filtered link scan also found no qualifying product link (${linkScans} scan(s), ${linkScanMs}ms total).` : "";
    return { content: [{ type: "text", text: `Navigation not ready after ${timeout_ms}ms: ${readiness.reason}.${evidenceNote}${scanNote}${header}\n${formatPageUrlMarker(snap.page?.url)}${formatElements(snap.elements)}` }], isError: true };
}

server.registerTool(
  "read_after_navigation",
  {
    title: "Wait for a destination and read it",
    description:
      "After a verified address-bar navigation or clean-link click, poll until the page URL matches the expected destination and meaningful page content is present, then return that accessibility snapshot. A page dialog is returned immediately as an actionable blocker instead of waiting for hidden content. Pass expected_heading whenever known; readiness then requires that page heading, so unrelated nav/footer headings cannot satisfy the wait. This replaces wait_for_element followed by read_page. For a search destination pass accept_product_link true AND search_query set to the exact text you submitted — search_query is the query you typed, never a heading — so this site's durable search-URL pattern can be learned.",
    inputSchema: z.object({
      expected_url: z.string().url(),
      expected_heading: z.string().optional().describe("Optional heading fragment. Empty is treated as omitted for homepage/storefront reads."),
      accept_product_link: z.boolean().default(false).describe("For a search-results destination only: accept a same-site product-shaped link when the site omits the expected results heading."),
      search_query: z.string().min(1).max(200).optional().describe("The EXACT search text that was submitted to reach this page — not a heading. Supply it only with accept_product_link true. It is used solely to learn this site's durable search-URL pattern when the observed URL provably encodes this text."),
      window_address: z.string().optional(),
      timeout_ms: z.number().int().min(500).max(7000).default(NAVIGATION_READY_BUDGET_MS),
      poll_ms: z.number().int().min(100).max(1000).default(300),
      limit: z.number().int().min(1).max(500).default(500),
    }).strict(),
  },
  async (args) => readAfterNavigationAction(args),
);

// rev 18 — trusted product images WITHOUT DevTools: the accessibility tree
// already carries each image node's resolved `src` (Chromium object
// attribute), so the supervisor can select a product image from a read-only
// inventory of image nodes with zero added browser observables. This is a
// SUPERVISOR tool (fast_agent calls it after a verified product report; the
// model never picks an image). Rows use `iN` handles, not actionable refs.
server.registerTool(
  "list_images",
  {
    title: "List the page's image nodes (read-only)",
    description:
      "Read-only inventory of the current document's image nodes from the accessibility tree: accessible name (alt), rendered box and the element's own image source URL. " +
      "No click, scroll or focus. Used by the supervisor to attach a trusted product image; the rows carry i-handles that cannot be clicked.",
    // max_nodes/min_size default to the historic behaviour (64 / no size filter); the catalog harvester raises
    // the node budget and filters out sub-thumbnail swatches so a results grid's product images all fit.
    inputSchema: z.object({ window_address: z.string().optional(), max_nodes: z.number().int().min(1).max(1000).optional(), min_size: z.number().int().min(0).max(2000).optional() }).strict(),
  },
  async ({ window_address, max_nodes, min_size }) => {
    const win = await resolveWindow(window_address);
    const page = await snapshotWindow(win, { limit: 1, pageInfo: true });
    const cap = max_nodes ?? 64;
    const inventory = await atspiBridge({ pid: win.pid, offset_x: win.at[0], offset_y: win.at[1], action: "list_images", cap, min_px: min_size ?? 0 });
    if (inventory?.error) return { content: [{ type: "text", text: `list_images failed: ${sanitizeInline(String(inventory.error))}` }], isError: true };
    const rows = (inventory.images || []).map((img, i) => {
      const b = Array.isArray(img.b) ? img.b : null;
      const where = b ? `@${b[0] + Math.floor(b[2] / 2)},${b[1] + Math.floor(b[3] / 2)} ${b[2]}x${b[3]}` : "@?,? 0x0";
      return `i${i + 1}\timage\t"${sanitizeInline(img.name)}"\t${where}${img.showing ? "" : " [hidden]"}${img.src ? ` -> ${sanitizeInline(img.src)}` : ""}`;
    });
    const header = page.page?.url ? `# ${sanitizeInline(page.page.title || "")} (${sanitizeInline(page.page.url)})\n` : "";
    return { content: [{ type: "text", text: formatPageUrlMarker(page.page?.url) + header + (rows.length ? rows.join("\n") : "(no image nodes)") + (inventory.capped ? `\n[capped at ${cap} image nodes]` : "") }] };
  }
);

server.registerTool(
  "wait_for_element",
  {
    title: "Wait for an element to appear",
    description:
      "Poll the accessibility tree until an element matching text/role appears (or the timeout elapses). Use this instead of blind " +
      "sleeps when waiting on page loads, AJAX content, or animations to settle. Getting the role wrong here is expensive — it polls " +
      "the FULL timeout for a role that can never match. If unsure of the exact role, omit role and match on text alone.",
    inputSchema: z.object({
      text: z.string().optional(),
      role: z.string().optional().describe("Real AT-SPI role name only (button, link, entry, heading, ...) — NOT HTML-ish names like 'textbox' or 'input'. Omit if unsure."),
      window_address: z.string().optional(),
      // Capped at 5s (was 60s, then 8s): a wrong guess at confirmation text
      // (common — exact post-search heading wording varies by site, and
      // the model keeps doing this despite prompt guidance not to) burns
      // the whole timeout for nothing. Caught live repeatedly: several bad
      // guesses per run, each eating the full ceiling, was the dominant
      // cost in nearly every test run measured this session. A tighter
      // ceiling makes even a bad guess cheap; a genuinely slow page just
      // needs a second call.
      timeout_ms: z.number().int().min(100).max(5000).default(3000),
      poll_ms: z.number().int().min(100).max(5000).default(400),
    }).strict(),
  },
  async ({ text, role, window_address, timeout_ms, poll_ms }) => {
    const roleError = validateRole(role);
    if (roleError) return { content: [{ type: "text", text: roleError }], isError: true };
    const win = await resolveWindow(window_address);
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
      const snap = await snapshotWindow(win, { textFilter: text, roleFilter: role, limit: 5, pageInfo: true }); // pageInfo: the found ref must carry its navigation epoch
      if (snap.elements.length > 0) {
        const el = snap.elements[0];
        return {
          content: [{ type: "text", text: `Found ${el.ref} ${el.role} "${sanitizeInline(el.name)}" @${el.cx},${el.cy}` }],
        };
      }
      await new Promise((r) => setTimeout(r, poll_ms));
    }
    return { content: [{ type: "text", text: `Timed out after ${timeout_ms}ms waiting for match.` }] };
  }
);

// PLUGINS (plugin_loader.mjs): other projects add their own tools here, before the server connects. A plugin gets the
// server and the core's perception / navigation helpers; one that fails to load is logged and skipped.
const pluginContext = Object.freeze({
  server, z,
  page: Object.freeze({ resolveWindow, snapshotWindow, formatElements, formatPageUrlMarker, observePageUri, directHrefNavigation, storefrontRootPath }),
  siteMemory: Object.freeze({
    dir: () => SITEMAP_DIR,
    setDir: (dir) => { if (!process.env.COMPUTER_USE_SITEMAP_DIR && typeof dir === "string" && dir) SITEMAP_DIR = dir; },
    setBackend: (backend) => { siteMemoryBackend = backend && typeof backend === "object" ? backend : null; },
  }),
});
await loadPlugins(pluginContext);

const transport = new StdioServerTransport();
await server.connect(transport);
