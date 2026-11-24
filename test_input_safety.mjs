#!/usr/bin/env node
// Non-live regression tests for the input-safety logic (gh issue #1
// follow-up review). No browser, no compositor — pure logic + the
// clipboard failure path. Run: node test_input_safety.mjs
import { isSubmitSafe, isOmniboxTarget, omniboxAutocompleteDeletion } from "./submit_safety.js";
import { readFileSync } from "node:fs";
import { pasteValue } from "./clipboard.js";
import { shouldPasteUrlFirst, enterValue } from "./paste_first.js";
import { segmentForTyping, wtypeTypingArgs, typingInvocations, ordinaryTypingArgs, typingArgvPlan, TYPING_MAX_DISTINCT } from "./typing_plan.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` (got ${got}, want ${want})`}`);
  ok ? pass++ : fail++;
}

const OMNIBOX = { omnibox: true };   // original target was the address bar
const INPAGE = { omnibox: false };   // original target was a page field

// --- isSubmitSafe: destination-ambiguity + target binding ------------------
// Codex v1 fixtures:
check(
  "sole EXACT in-page editable + focus on clear button => Return REFUSED",
  isSubmitSafe({ match: "exact", focused: false, candidates: 1, in_doc: true }, INPAGE),
  false
);
check(
  "sole EXACT omnibox chrome match, target=address bar => ALLOWED",
  isSubmitSafe({ match: "exact", focused: false, candidates: 1, in_doc: false }, OMNIBOX),
  true
);
// Codex v2 fixtures — the escape hatch is bound to the ORIGINAL target:
check(
  "original target=in-page Search + sole EXACT chrome match => REFUSED (no Find-bar rescue)",
  isSubmitSafe({ match: "exact", focused: false, candidates: 1, in_doc: false }, INPAGE),
  false
);
check(
  "original target=Address bar + sole EXACT chrome match => ALLOWED",
  isSubmitSafe({ match: "exact", focused: false, candidates: 1, in_doc: false }, OMNIBOX),
  true
);
check(
  "focused exact => ALLOWED regardless of target (in-page)",
  isSubmitSafe({ match: "exact", focused: true, candidates: 1, in_doc: true }, INPAGE),
  true
);
// Supporting cases:
check("prefix (autocomplete-extended), even focused => refused", isSubmitSafe({ match: "prefix", focused: true, candidates: 1, in_doc: false }, OMNIBOX), false);
check("multiple chrome matches, target omnibox => refused (ambiguous)", isSubmitSafe({ match: "exact", focused: false, candidates: 2, in_doc: false }, OMNIBOX), false);
check("sole in-page match, target omnibox (mismatch) => refused", isSubmitSafe({ match: "exact", focused: false, candidates: 1, in_doc: true }, OMNIBOX), false);
check("null match => refused", isSubmitSafe(null, OMNIBOX), false);
check("not-found shape => refused", isSubmitSafe({ match: undefined, focused: false }, OMNIBOX), false);

// --- isOmniboxTarget: identifies the address bar specifically --------------
check("address bar entry (chrome) => omnibox", isOmniboxTarget({ role: "entry", name: "Address and search bar", in_doc: false }), true);
check("in-page Search entry => not omnibox", isOmniboxTarget({ role: "entry", name: "Search", in_doc: true }), false);
check("in-page Search Amazon entry => not omnibox (name)", isOmniboxTarget({ role: "entry", name: "Search Amazon" }), false);
check("combo box named like address bar => not omnibox (role)", isOmniboxTarget({ role: "combo box", name: "Address and search bar" }), false);
check("address-bar-named entry but in document => not omnibox", isOmniboxTarget({ role: "entry", name: "Address and search bar", in_doc: true }), false);

// --- shouldPasteUrlFirst: the ONE shape that pastes first -------------------
// Live evidence: New Balance + eBay headless direct-URL navigation each cost
// ~6.3-6.9s because the first wtype pass dropped characters every time and
// only the clipboard retry landed. Everything NOT in that shape must keep
// typing — these cases pin each exclusion.
const OMNIBOX_EL = { role: "entry", name: "Address and search bar", in_doc: false };
const pasteFirst = (o) => shouldPasteUrlFirst({ backend: "headless", element: OMNIBOX_EL, value: "https://www.newbalance.com/", wantRecovery: false, ...o });

check("headless + omnibox + https URL => PASTE first", pasteFirst({}), true);
check("http (not just https) URL => paste first", pasteFirst({ value: "http://example.com/x" }), true);
check("URL with query string (the '?'-dropping shape) => paste first", pasteFirst({ value: "https://www.ebay.com/sch/i.html?_nkw=running+shoes" }), true);

// Exclusion: real desktop. wl-copy there would clobber the user's own clipboard.
check("hyprland backend (real desktop) => type, never paste", pasteFirst({ backend: "hyprland" }), false);
check("undefined backend => type (fails closed)", pasteFirst({ backend: undefined }), false);

// Exclusion: in-document fields. Paste is proven NOT to land in freshly
// focused web inputs under the nested compositor.
check("in-page Search entry, even with a URL value => type", pasteFirst({ element: { role: "entry", name: "Search Amazon", in_doc: true } }), false);
check("omnibox NAME but inside the document => type (untrusted target)", pasteFirst({ element: { role: "entry", name: "Address and search bar", in_doc: true } }), false);
check("missing element => type (fails closed)", pasteFirst({ element: undefined }), false);

// Exclusion: combo/recovery targets — they restructure on focus and their
// recovery path is built around typing into the replacement input.
check("combo box target => type", pasteFirst({ element: { role: "combo box", name: "Address and search bar", in_doc: false } }), false);
check("wantRecovery true => type (recovery path owns this)", pasteFirst({ wantRecovery: true }), false);

// Exclusion: non-URL omnibox text — a search query, short and retry-tolerant.
check("plain search text in the omnibox => type", pasteFirst({ value: "running shoes" }), false);
check("bare hostname (omnibox will search/complete it) => type", pasteFirst({ value: "amazon.com" }), false);
check("about:blank => type", pasteFirst({ value: "about:blank" }), false);
check("javascript: URL => type", pasteFirst({ value: "javascript:alert(1)" }), false);
check("file:// URL => type", pasteFirst({ value: "file:///etc/hosts" }), false);
check("URL followed by extra words (it's a query) => type", pasteFirst({ value: "https://x.com two words" }), false);
check("empty value => type", pasteFirst({ value: "" }), false);
check("whitespace-only value => type", pasteFirst({ value: "   " }), false);
// Surrounding whitespace: the RAW value is what gets delivered, so a value
// that isn't already clean must classify as not-a-URL rather than be
// normalized (classification and delivered bytes must never disagree).
check("leading whitespace before a URL => type (raw !== raw.trim())", pasteFirst({ value: "  https://www.nike.com/" }), false);
check("trailing whitespace after a URL => type (raw !== raw.trim())", pasteFirst({ value: "https://www.nike.com/  " }), false);
check("leading AND trailing whitespace => type", pasteFirst({ value: "  https://www.nike.com/  " }), false);
check("leading newline/tab around a URL => type", pasteFirst({ value: "\n\thttps://www.nike.com/" }), false);
check("no args at all => type (fails closed)", shouldPasteUrlFirst(), false);

// --- enterValue: paste-first with a SINGLE wtype fallback -------------------
// Awaited by the final block below so the summary can never print before
// these checks have run.
const enterValueChecks = (async () => {
  let pastes = 0, types = 0;
  const paste = async () => { pastes++; };
  const type = async () => { types++; };
  const reject = async () => { pastes++; throw new Error("wl-copy could not set the selection"); };

  let m = await enterValue({ pasteFirst: true, paste, type });
  check("paste succeeds => reports clipboard paste", m, "clipboard paste");
  check("  ...pasted exactly once", pastes, 1);
  check("  ...and never typed", types, 0);

  pastes = 0; types = 0;
  m = await enterValue({ pasteFirst: true, paste: reject, type });
  check("paste REJECTED => falls back to typing", m, "typing (paste rejected)");
  check("  ...typed exactly once (one fallback, no loop)", types, 1);
  check("  ...paste attempted exactly once", pastes, 1);

  pastes = 0; types = 0;
  m = await enterValue({ pasteFirst: false, paste, type });
  check("pasteFirst false => types, clipboard untouched", m, "typing");
  check("  ...typed exactly once", types, 1);
  check("  ...never touched the clipboard", pastes, 0);
})();

// --- pasteValue failure path -----------------------------------------------
// wl-copy must REJECT (not silently proceed to ctrl+v pasting stale
// clipboard) when it cannot establish the selection. Point it at an env
// with no reachable Wayland display so wl-copy exits nonzero (or is
// missing) — either way pasteValue must throw.
(async () => {
  await enterValueChecks;
  const brokenEnv = { ...process.env, WAYLAND_DISPLAY: "wayland-nonexistent-xyz", XDG_RUNTIME_DIR: "/nonexistent-runtime-dir-xyz" };
  let threw = false;
  try {
    await pasteValue("regression-probe-value", brokenEnv);
  } catch {
    threw = true;
  }
  check("pasteValue rejects when wl-copy cannot set the selection", threw, true);

  // --- typing plan: segmented by distinct characters, sacrificial Shift_L head ---
const LONG = "Muéstrame ofertas actuales de tenis para correr en Dick's Sporting Goods; verifica en vivo el precio y la disponibilidad.";
check("segments concatenate to the original value", segmentForTyping(LONG).join(""), LONG);
check("every segment stays within the distinct-character budget", segmentForTyping(LONG).every((seg) => new Set(seg).size <= TYPING_MAX_DISTINCT), true);
check("the live sentence (29 distinct chars) splits into two segments", segmentForTyping(LONG).length, 2);
check("a short value is one segment", segmentForTyping("Dick's Sporting Goods").length, 1);
check("empty value → no segments", segmentForTyping("").length, 0);
check("a value of repeated characters never splits", segmentForTyping("a".repeat(500)).length, 1);
check("segmentation honours a custom budget exactly", segmentForTyping("abcdef", 2).join("|"), "ab|cd|ef");
let typingThrew = false; try { segmentForTyping("x", 0); } catch { typingThrew = true; } check("a non-positive budget is refused", typingThrew, true);
check("argv: settle, delay, sacrificial Shift_L, then the literal segment after --", JSON.stringify(wtypeTypingArgs("-leading dash", { delayMs: 80 })), JSON.stringify(["-s", "100", "-d", "80", "-k", "Shift_L", "--", "-leading dash"]));
typingThrew = false; try { wtypeTypingArgs("x", { delayMs: 5000 }); } catch { typingThrew = true; } check("an out-of-range delay is refused", typingThrew, true);
const plan = typingInvocations(LONG, { delayMs: 25 });
check("the plan has one invocation per segment, all Shift_L-headed", plan.length === 2 && plan.every((a) => a[4] === "-k" && a[5] === "Shift_L" && a[6] === "--"), true);
check("the plan reproduces the value in order", plan.map((a) => a[7]).join(""), LONG);
check("an empty value plans nothing", typingInvocations("").length, 0);

// --- rev 15 keymap-position oracle (INDEPENDENT of typing_plan.js): wtype 0.4 parse order + Chromium VKEY rule ---
const ORACLE_TYPEWRITER = new Set([2,3,4,5,6,7,8,9,10,11,12,13, 16,17,18,19,20,21,22,23,24,25,26,27, 30,31,32,33,34,35,36,37,38,39,40,41, 43,44,45,46,47,48,49,50,51,52,53, 57, 86]);
const ORACLE_NAMES = { 1: "ESC", 14: "BACKSPACE", 15: "TAB", 28: "ENTER", 29: "LEFTCTRL", 42: "LEFTSHIFT", 54: "RIGHTSHIFT", 55: "KPASTERISK", 56: "LEFTALT", 58: "CAPSLOCK" };
const oracleKeymap = (argv) => {
  const entries = []; const chars = new Set(); const keys = new Set(); let raw = false; let space = false;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!raw && a === "--") { raw = true; continue; }
    if (!raw && a === "-") { entries.push("<stdin>"); continue; }
    if (!raw && a.startsWith("-")) { if (a === "-k" || a === "-P" || a === "-p") { const k = "<" + argv[i + 1] + ">"; if (!keys.has(k)) { keys.add(k); entries.push(k); } } i++; space = false; continue; }
    const t = (space ? " " : "") + a; for (const ch of t) if (!chars.has(ch)) { chars.add(ch); entries.push(ch); } space = true;
  }
  return entries;
};
const oracleHazards = (argv) => oracleKeymap(argv).map((e, i) => (e.length === 1 && !/^[0-9A-Za-z]$/.test(e) && !ORACLE_TYPEWRITER.has(i + 1)) ? `${JSON.stringify(e)}@${i}=${ORACLE_NAMES[i + 1] || "evdev-" + (i + 1)}` : null).filter(Boolean);
const oracleText = (argv) => argv.slice(argv.indexOf("--") + 1).join(" ");
// --- attempt gating: ordinary path first for position-safe values; the planner otherwise; segmented on retry ---
const ORDINARY_VALUES = { email: "margarett.waelchi@example.net", password: "password", short: "abc", leadingDash: "-flag", apostrophe: LONG, unicodeQuotes: "\"quoted\" and 'single' and it’s — café", long: "x y ".repeat(100) };
// rev 15.1: attempt 1 is the pre-existing ordinary argv exactly when that argv is position-safe (its first-appearance
// keymap order parks no non-alphanumeric character on a non-typewriter position); otherwise — a value that could never
// land on its first pass — it is the position-safe segmented plan at the first-path pace. The oracle deciding "safe"
// here is the test-local one below (independent of typing_plan.js).
const ORDINARY_ARGV = (value) => ["-s", "100", "-d", "25", "--", value];
const ordinaryIsSafe = (value) => oracleHazards(ORDINARY_ARGV(value)).length === 0;
for (const [label, value] of Object.entries(ORDINARY_VALUES)) {
  const first = typingArgvPlan(value, { attempt: 1, delayMs: 25 });
  if (ordinaryIsSafe(value)) {
    check(`attempt 1 (${label}) is ONE ordinary invocation (position-safe)`, first.length, 1);
    check(`attempt 1 (${label}) carries no sacrificial key`, first[0].includes("Shift_L"), false);
    check(`attempt 1 (${label}) is exactly the pre-existing argv`, JSON.stringify(first[0]), JSON.stringify(ORDINARY_ARGV(value)));
  } else {
    check(`attempt 1 (${label}) switches to the position-safe plan at 25 ms/key (ordinary argv had ${oracleHazards(ORDINARY_ARGV(value)).join(" ")})`, JSON.stringify(first), JSON.stringify(typingInvocations(value, { delayMs: 25 })));
    check(`attempt 1 (${label}) planned argv is hazard-free and Shift_L-headed`, first.flatMap(oracleHazards).length === 0 && first.every((a) => a[3] === "25" && a[4] === "-k" && a[5] === "Shift_L"), true);
  }
  const retry = typingArgvPlan(value, { attempt: 2, delayMs: 80 });
  check(`attempt 2 (${label}) is the segmented Shift_L-headed plan`, retry.length >= 1 && retry.every((a) => a[4] === "-k" && a[5] === "Shift_L" && a[6] === "--" && a[3] === "80"), true);
  check(`attempt 2 (${label}) reproduces the value`, retry.map((a) => a[7]).join(""), value);
}
check("a leading-dash value is safe on the ordinary path too (after --)", ordinaryTypingArgs("-flag")[4] === "--" && ordinaryTypingArgs("-flag")[5] === "-flag", true);
check("attempt 0 / undefined / non-integer all mean the ordinary path", typingArgvPlan("v", { attempt: 0 }).length === 1 && typingArgvPlan("v", {}).length === 1 && typingArgvPlan("v", { attempt: 1.5 }).length === 1 && !typingArgvPlan("v", { attempt: 0 })[0].includes("Shift_L"), true);
check("rev 15.1: a hazard-free URL keeps the ordinary argv on attempt 1", JSON.stringify(typingArgvPlan("https://www.walmart.com/search?q=nike+running+shoes&sort=price_low", { attempt: 1, delayMs: 25 })), JSON.stringify([ORDINARY_ARGV("https://www.walmart.com/search?q=nike+running+shoes&sort=price_low")]));
check("rev 15.1: the 107-char live composer value keeps the ordinary argv on attempt 1", JSON.stringify(typingArgvPlan("Muéstrame tenis para correr en oferta con envío gratis, talla 27, y verifica el precio y la imagen en vivo.", { attempt: 1, delayMs: 25 })), JSON.stringify([ORDINARY_ARGV("Muéstrame tenis para correr en oferta con envío gratis, talla 27, y verifica el precio y la imagen en vivo.")]));
check("empty text plans nothing on either attempt", typingArgvPlan("", { attempt: 1 }).length === 0 && typingArgvPlan("", { attempt: 2 }).length === 0, true);
let ordThrew = false; try { ordinaryTypingArgs("x", { delayMs: -1 }); } catch { ordThrew = true; } check("ordinary argv refuses an out-of-range delay", ordThrew, true);

// --- rev 15: keymap-position safety, judged by an oracle INDEPENDENT of typing_plan.js ---
// wtype 0.4 (main.c parse_args/upload_keymap): one keymap per process, entries in first-appearance order over the whole
// argv, entry i = xkb keycode i+9 = evdev code i+1; `--` makes every later arg raw text (a space is injected between
// adjacent text args); -k/-P/-p add the named keysym; -s/-d/-M/-m consume one arg and add nothing. Chromium reads the VKEY
// of a non-alphanumeric character from that accidental physical key, so any such character parked on a non-typewriter
// evdev code (ESC 1, BACKSPACE 14, TAB 15, ENTER 28, LEFTCTRL 29, …) is executed as that key instead of being inserted.
const WALMART_QA = "[QA-rev131] Current rollback price on men's Nike running shoes at Walmart; verify price and image.";
const SYNTHETIC_EMAIL = "ana.perez+quick@example.org";
const COVERAGE = {
  leadingBracket: WALMART_QA,
  leadingQuote: "\"quoted\" and 'single' and it’s",
  leadingDash: "-flag",
  atSign13: SYNTHETIC_EMAIL,
  fixtureEmail: "margarett.waelchi@example.net",
  semicolon13: "g shoes at Walmart; verify price and image.",
  comma13: "g shoes at Walmart, verify price and image.",
  enter27: "[abcdefghijklmnopqrstuvwxy!",
  ctrl28: "[abcdefghijklmnopqrstuvwxy!?",
  dicks: LONG,
  unicodePunct: "¿Dónde está — el precio… «hoy»? ¡ya!",
  spaceFirst: " leading space and a tab-free tail",
};
// HEAD shape of the defect, for the record: the OLD segmented plan (27 distinct, Shift_L head) parks ";" of the 98-char
// value and "@" of an e-mail on index 13 = BACKSPACE, and the 27th distinct char of a segment on index 27 = ENTER.
for (const [label, value] of Object.entries(COVERAGE)) {
  const first = typingArgvPlan(value, { attempt: 1, delayMs: 25 });
  if (ordinaryIsSafe(value)) check(`rev15.1 attempt 1 (${label}) stays byte-identical to the shipped ordinary argv`, JSON.stringify(first), JSON.stringify([ORDINARY_ARGV(value)]));
  else check(`rev15.1 attempt 1 (${label}) is the position-safe plan at 25 ms/key (ordinary had ${oracleHazards(ORDINARY_ARGV(value)).join(" ")})`, JSON.stringify(first), JSON.stringify(typingInvocations(value, { delayMs: 25 })));
  check(`rev15.1 attempt 1 (${label}) parks no non-alphanumeric character on a hazardous keymap index`, first.flatMap(oracleHazards).join(" "), "");
  check(`rev15.1 attempt 1 (${label}) concatenates exactly`, first.map(oracleText).join(""), value);
  const retry = typingArgvPlan(value, { attempt: 2, delayMs: 80 });
  check(`rev15 attempt 2 (${label}) parks no non-alphanumeric character on a hazardous keymap index`, retry.flatMap(oracleHazards).join(" "), "");
  check(`rev15 attempt 2 (${label}) never assigns keymap index 27 or beyond (≤ 27 entries per invocation)`, retry.every((a) => oracleKeymap(a).length <= 27), true);
  check(`rev15 attempt 2 (${label}) keeps Shift_L (non-printable) as the only index-0 entry`, retry.every((a) => oracleKeymap(a)[0] === "<Shift_L>"), true);
  check(`rev15 attempt 2 (${label}) concatenates exactly to the value`, retry.map(oracleText).join(""), value);
}
check("rev15 the 98-char value now types in two position-safe invocations", typingArgvPlan(WALMART_QA, { attempt: 2, delayMs: 80 }).length, 2);
check("rev15 an e-mail on the retry path splits before its \"@\" would take index 13", oracleKeymap(typingArgvPlan(SYNTHETIC_EMAIL, { attempt: 2, delayMs: 80 })[0]).indexOf("@"), -1);
check("rev15 a segment closes before a punctuation mark would take index 27 (ENTER)", typingArgvPlan(COVERAGE.enter27, { attempt: 2, delayMs: 80 }).map((a) => oracleKeymap(a).length).join(","), "27,2");
check("rev15 letters and digits may sit on index 13/14 (their VKEY is position-independent)", oracleHazards(typingArgvPlan("abcdefghijklmnopqrstuvwxyz0123456789", { attempt: 2, delayMs: 80 })[0]).length === 0 && typingArgvPlan("abcdefghijklmnopqrstuvwxyz0123456789", { attempt: 2, delayMs: 80 }).length === 2, true);
// Seeded adversarial strings (fixed LCG seed, no wall clock): letters, digits, space, ASCII punctuation, Unicode punctuation.
{
  let seed = 0x5eed1234 >>> 0;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const ALPHABET = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789    !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~—¿…’«»€éñ¡"];
  let hazardFree = 0, exact = 0, bounded = 0, headed = 0, total = 0, agree = 0, firstSafe = 0, firstExact = 0, firstRule = 0, firstBounded = 0;
  const mod = await import("./typing_plan.js");
  for (let n = 0; n < 300; n++) {
    const len = 1 + Math.floor(rnd() * 140);
    let v = ""; for (let i = 0; i < len; i++) v += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    total++;
    const retry = typingArgvPlan(v, { attempt: 2, delayMs: 80 });
    if (retry.flatMap(oracleHazards).length === 0) hazardFree++;
    if (retry.map(oracleText).join("") === v) exact++;
    if (retry.every((a) => oracleKeymap(a).length <= 27)) bounded++;
    if (retry.every((a) => oracleKeymap(a)[0] === "<Shift_L>")) headed++;
    if (typeof mod.simulateWtypeKeymap === "function" && retry.every((a) => JSON.stringify(mod.simulateWtypeKeymap(a).map((e) => (e.kind === "keysym" ? "<" + e.value + ">" : e.value))) === JSON.stringify(oracleKeymap(a)))) agree++;
    const first = typingArgvPlan(v, { attempt: 1, delayMs: 25 });
    if (first.flatMap(oracleHazards).length === 0) firstSafe++;
    if (first.map(oracleText).join("") === v) firstExact++;
    if (ordinaryIsSafe(v) ? JSON.stringify(first) === JSON.stringify([ORDINARY_ARGV(v)]) : JSON.stringify(first) === JSON.stringify(typingInvocations(v, { delayMs: 25 }))) firstRule++;
    if (ordinaryIsSafe(v) || first.every((a) => oracleKeymap(a).length <= 27 && oracleKeymap(a)[0] === "<Shift_L>")) firstBounded++;
  }
  check("rev15.1 adversarial: attempt 1 parks no non-alphanumeric on a hazardous index", firstSafe, total);
  check("rev15.1 adversarial: attempt 1 concatenates exactly", firstExact, total);
  check("rev15.1 adversarial: attempt 1 is the ordinary argv iff it is position-safe, else the planned argv", firstRule, total);
  check("rev15.1 adversarial: a planned attempt 1 stays within 27 entries with a Shift_L head", firstBounded, total);
  check(`rev15 adversarial: ${total} seeded strings park no non-alphanumeric on a hazardous index`, hazardFree, total);
  check("rev15 adversarial: every plan concatenates exactly", exact, total);
  check("rev15 adversarial: every invocation stays within 27 keymap entries", bounded, total);
  check("rev15 adversarial: every invocation is Shift_L-headed", headed, total);
  check("rev15 adversarial: the module's wtype simulator agrees with the independent oracle", agree, total);
}

// --- rev 30b: omnibox inline autocomplete → one Delete, only on the exact evidence ----
{
  const base = { omnibox: true, match: "prefix", typedLength: 20, fieldLength: 47, selection: [20, 47] };
  check("autocomplete: omnibox + prefix + selection exactly the suffix → Delete", omniboxAutocompleteDeletion(base), true);
  check("autocomplete: an in-page field never", omniboxAutocompleteDeletion({ ...base, omnibox: false }), false);
  check("autocomplete: an exact match never", omniboxAutocompleteDeletion({ ...base, match: "exact" }), false);
  check("autocomplete: no selection never (today's refusal)", omniboxAutocompleteDeletion({ ...base, selection: null }), false);
  check("autocomplete: a selection that starts before the typed text never", omniboxAutocompleteDeletion({ ...base, selection: [19, 47] }), false);
  check("autocomplete: a selection that stops short of the field's end never", omniboxAutocompleteDeletion({ ...base, selection: [20, 40] }), false);
  check("autocomplete: a collapsed selection never", omniboxAutocompleteDeletion({ ...base, selection: [47, 47] }), false);
  check("autocomplete: the field must be longer than the typed value", omniboxAutocompleteDeletion({ ...base, fieldLength: 20, selection: [20, 20] }), false);
  check("autocomplete: malformed inputs never", omniboxAutocompleteDeletion({ ...base, selection: ["20", "47"] }) || omniboxAutocompleteDeletion({ ...base, typedLength: 0 }) || omniboxAutocompleteDeletion(), false);
  const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  check("source pin: index.js presses Delete in exactly one place", (source.match(/tapKey\("Delete"/g) || []).length, 1);
  check("source pin: that Delete is gated on omniboxAutocompleteDeletion and followed by a re-verify", /if \(found && omniboxAutocompleteDeletion\(\{ omnibox: targetCtx\.omnibox, match: found\.match, typedLength: found\.needle\.length, fieldLength: found\.text_length, selection: found\.selection \}\)\) \{\n\s+await tapKey\("Delete", \{ settle: false \}\);\n\s+const again = await verifyTyped\(\);/.test(source), true);
  check("source pin: the bridge reports the selection and the field length beside the match", /"text_length": n,\n\s+"selection": text_selection_span\(ti\),/.test(readFileSync(new URL("./atspi_bridge.py", import.meta.url), "utf8")), true);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
