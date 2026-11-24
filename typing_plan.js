// Keystroke typing plan for wtype, kept pure so it is unit-testable without the
// MCP server.
//
// WHY (measured locally, test_headless_punctuation.mjs, 2026-09-02): the live
// a probe could not submit the query containing "Dick's Sporting Goods"
// three times — type_into_element reported NOT VERIFIED — while the same
// sentence spelled "Dicks" verified. A direct wtype reproduction against an
// isolated headless Chromium textarea showed the typing itself was lossy,
// deterministically, and in two distinct ways:
//   (1) the FIRST key of an invocation can be dropped ("\"quoted\" …" lost its
//       leading quote; every chunk of a naively split sentence lost its leading
//       space), and
//   (2) a long sentence lost its LAST key once it carried one more distinct
//       character (the apostrophe) than an otherwise identical control.
// Slower pacing (-d 80), a longer start delay and clipboard paste did not help
// (paste lands nothing in in-document fields under the nested compositor).
// What did land every reproduction string exactly: type the value in segments
// bounded by DISTINCT characters, each invocation prefixed with a sacrificial
// Shift_L press that absorbs the first-key drop.
//
// SCOPE (live review 2026-09-02): that segmented plan is NOT the universal
// first path. Used first for everything it broke a login e-mail field
// (a reactive input: "margarett.waelchi@example.net" came back NOT VERIFIED
// twice, the password verified) while the ordinary single-invocation path had
// typed that field reliably for weeks. So: attempt 1 is always the ORDINARY
// plan (one wtype invocation, exactly the argv that shipped before), and the
// segmented plan is the bounded RETRY after the ordinary pass failed exact
// read-back verification — the one shape the reproduction proved needs it.
// The exact mechanism inside wtype/xkb is not attributed; verification and the
// safe-submit gate in index.js still judge every outcome.
//
// MECHANISM (rev 15, 2026-09-02, read from wtype 0.4 main.c, Chromium
// ui/events/ozone/layout/xkb/xkb_keyboard_layout_engine.cc and Blink
// core/editing/editing_behavior.cc, then matched against every measured drop):
// wtype builds ONE keymap per process at parse time, in first-appearance order
// over the whole argv (text characters and `-k` keysyms alike, deduplicated),
// and keymap index i becomes xkb keycode i+9, i.e. evdev code i+1. Chromium
// maps that evdev code to a PHYSICAL key (DomCode) and derives the legacy VKEY
// of an ASCII letter or digit from the character itself, but of any other
// character (punctuation, space, non-ASCII letters) from that accidental
// physical key. Blink runs keydown editing commands by VKEY and suppresses
// the keypress of a handled keydown. Measured in test_headless_punctuation.mjs
// (2026-09-02): a character parked on evdev 14 (KEY_BACKSPACE) runs
// DeleteBackward — it erases the PREVIOUS character and never lands itself; on
// evdev 1 (KEY_ESC) it is cancelled; on evdev 29 (KEY_LEFTCTRL) it arrives as a
// Ctrl-modified keydown ("Ctrl+.") and is not inserted; on evdev 28 (KEY_ENTER)
// it still lands and nothing submits, because Blink runs InsertNewline only
// from a keypress carrying a carriage return and this keypress carries the
// character. That is the whole story behind the "dropped" keys: the leading
// "[" / quote / "-" of an ordinary invocation (index 0 = ESC); ";" or "," as
// the 14th distinct keysym of a Shift_L-headed segment deleting the "t" before
// it (index 13 = BACKSPACE); "." as the 29th entry of a long sentence (index 28
// = LEFTCTRL); and the login e-mail "@" at index 13 when the segmented plan was
// tried first. The sacrificial Shift_L works only because it parks a
// NON-printable keysym on index 0 (its VKEY comes from the key name, not the
// position), and the old budget of 27 distinct characters was empirically
// dodging index 28 (LEFTCTRL) while still exposing index 27 (harmless) and 13.
//
// PLAN (rev 15): plan by EXACT keymap index, nothing else. An invocation holds
// at most TYPING_ENTRIES_PER_INVOCATION keymap entries: the Shift_L head at
// index 0 plus up to TYPING_MAX_DISTINCT distinct characters at indices 1..26
// (evdev 2..27), so index 27 (ENTER) and beyond are never assigned. Inside that
// range the only non-typewriter positions are 13 (BACKSPACE, measured) and 14
// (TAB, avoided on the same rule): an ASCII letter or digit may take them (its
// VKEY is position-independent); any other character must not, so the segment
// is closed BEFORE that character is assigned and it becomes index 1 of the
// next invocation. Every other non-typewriter position is avoided by the cap
// without a measurement of its own (conservative by design). No filler keys are
// inserted between text pieces: wtype's `--` turns every later argument into
// raw text (with a space injected between adjacent text arguments), and without
// `--` a piece starting with "-" would parse as an option, so a mid-text filler
// would need a second escape mechanism and its own inertness proof; closing the
// segment costs one extra invocation and proves nothing new. The ordinary
// attempt-1 argv is deliberately byte-identical to what shipped (its index-0
// exposure for a non-alphanumeric first character is documented above and left
// to the retry). No store names, no coordinates, no timeouts.
//
// evdev codes from /usr/include/linux/input-event-codes.h. The headless sway
// configuration written by headless_instance.mjs (swayConfig) declares no
// bindsym/bindcode, so a bare Shift_L press reaches the page and nothing else.

// Keymap index i ⇒ xkb keycode i + WTYPE_KEYCODE_BASE ⇒ evdev code i + 1.
export const WTYPE_KEYCODE_BASE = 9;
// evdev codes of the plain typewriter keys: a printable character parked here is read by Chromium as an ordinary printable key.
export const TYPEWRITER_EVDEV_CODES = new Set([
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, // KEY_1..KEY_0, KEY_MINUS, KEY_EQUAL
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, // KEY_Q..KEY_P, KEY_LEFTBRACE, KEY_RIGHTBRACE
  30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, // KEY_A..KEY_L, KEY_SEMICOLON, KEY_APOSTROPHE, KEY_GRAVE
  43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, // KEY_BACKSLASH, KEY_Z..KEY_M, KEY_COMMA, KEY_DOT, KEY_SLASH
  57, // KEY_SPACE
  86, // KEY_102ND
]);
// Names for the non-typewriter evdev codes a keymap index can fall on (index = code − 1); anything not listed as typewriter is a hazard.
export const HAZARD_EVDEV_NAMES = Object.freeze({
  1: "ESC", 14: "BACKSPACE", 15: "TAB", 28: "ENTER", 29: "LEFTCTRL", 42: "LEFTSHIFT", 54: "RIGHTSHIFT", 55: "KPASTERISK", 56: "LEFTALT", 58: "CAPSLOCK",
  59: "F1", 60: "F2", 61: "F3", 62: "F4", 63: "F5", 64: "F6", 65: "F7", 66: "F8", 67: "F9", 68: "F10", 69: "NUMLOCK", 70: "SCROLLLOCK",
  71: "KP7", 72: "KP8", 73: "KP9", 74: "KPMINUS", 75: "KP4", 76: "KP5", 77: "KP6", 78: "KPPLUS", 79: "KP1", 80: "KP2", 81: "KP3", 82: "KP0", 83: "KPDOT",
  85: "ZENKAKUHANKAKU", 87: "F11", 88: "F12", 89: "RO", 90: "KATAKANA", 91: "HIRAGANA", 92: "HENKAN", 93: "KATAKANAHIRAGANA", 94: "MUHENKAN", 95: "KPJPCOMMA",
  96: "KPENTER", 97: "RIGHTCTRL", 98: "KPSLASH", 99: "SYSRQ", 100: "RIGHTALT", 101: "LINEFEED", 102: "HOME", 103: "UP", 104: "PAGEUP", 105: "LEFT", 106: "RIGHT",
  107: "END", 108: "DOWN", 109: "PAGEDOWN", 110: "INSERT", 111: "DELETE", 112: "MACRO", 113: "MUTE", 114: "VOLUMEDOWN", 115: "VOLUMEUP", 116: "POWER",
  117: "KPEQUAL", 118: "KPPLUSMINUS", 119: "PAUSE", 120: "SCALE", 121: "KPCOMMA", 122: "HANGEUL", 123: "HANJA", 124: "YEN", 125: "LEFTMETA", 126: "RIGHTMETA", 127: "COMPOSE",
});
/** Is keymap index `index` a position where a non-alphanumeric character would be read as a non-typewriter key? */
export function keymapIndexIsHazard(index) {
  if (!Number.isInteger(index) || index < 0) throw new TypeError("keymap index must be a non-negative integer");
  return !TYPEWRITER_EVDEV_CODES.has(index + 1);
}
/** Human name of the physical key a keymap index denotes. */
export function keymapIndexName(index) {
  return HAZARD_EVDEV_NAMES[index + 1] || (TYPEWRITER_EVDEV_CODES.has(index + 1) ? `typewriter-evdev-${index + 1}` : `evdev-${index + 1}`);
}
/** ASCII letters and digits get their VKEY from the character itself (Chromium AlphanumericKeyboardCode); every other character depends on its keymap position. */
export function isPositionIndependent(ch) {
  return /^[0-9A-Za-z]$/.test(ch);
}
export const TYPING_ENTRIES_PER_INVOCATION = 27; // Shift_L head + text entries; index 27 (ENTER) is never assigned
export const TYPING_MAX_DISTINCT = TYPING_ENTRIES_PER_INVOCATION - 1; // distinct text characters per invocation (indices 1..26)
export const TYPING_HEAD_ENTRIES = 1; // the sacrificial Shift_L at index 0
export const TYPING_SETTLE_MS = 100;

/**
 * Split a value into segments for Shift_L-headed invocations: at most
 * `maxDistinct` distinct characters each (never more than
 * TYPING_ENTRIES_PER_INVOCATION − 1, so no index ≥ 27 is ever assigned), and a
 * segment is closed BEFORE a non-alphanumeric character would take a hazardous
 * keymap index (13 = BACKSPACE, 14 = TAB); concatenation is the original value.
 */
export function segmentForTyping(value, maxDistinct = TYPING_MAX_DISTINCT) {
  const text = String(value ?? "");
  if (!Number.isInteger(maxDistinct) || maxDistinct < 1) throw new TypeError("maxDistinct must be a positive integer");
  if (maxDistinct + TYPING_HEAD_ENTRIES > TYPING_ENTRIES_PER_INVOCATION) throw new RangeError(`maxDistinct must leave every keymap index below ${TYPING_ENTRIES_PER_INVOCATION}`);
  const segments = [];
  let current = "";
  let seen = new Set();
  for (const ch of text) {
    if (!seen.has(ch)) {
      const index = TYPING_HEAD_ENTRIES + seen.size; // the keymap index this new character would take
      if (seen.size >= maxDistinct || (keymapIndexIsHazard(index) && !isPositionIndependent(ch))) {
        segments.push(current);
        current = "";
        seen = new Set();
      }
    }
    current += ch;
    seen.add(ch);
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * Keymap entries wtype 0.4 will assign for an argv, in order (mirrors parse_args:
 * `--` makes every later argument raw text with a space injected between
 * adjacent text arguments; `-k`/`-P`/`-p` add the named keysym; `-s`, `-d`,
 * `-M`, `-m` take one argument and add nothing; entries are deduplicated by
 * character or keysym name). Entry i is evdev code i + 1.
 */
export function simulateWtypeKeymap(argv) {
  const entries = [];
  const seenChars = new Set();
  const seenKeys = new Set();
  const addChar = (ch) => { if (!seenChars.has(ch)) { seenChars.add(ch); entries.push({ kind: "char", value: ch }); } };
  const addKey = (name) => { if (!seenKeys.has(name)) { seenKeys.add(name); entries.push({ kind: "keysym", value: name }); } };
  let rawText = false;
  let prefixWithSpace = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (!rawText && arg === "--") { rawText = true; continue; }
    if (!rawText && arg === "-") { entries.push({ kind: "stdin", value: "-" }); continue; }
    if (!rawText && arg.startsWith("-")) {
      const next = argv[i + 1];
      if (arg === "-k" || arg === "-P" || arg === "-p") addKey(String(next));
      i++; // -s, -d, -M, -m consume their argument and add no entry
      prefixWithSpace = false;
      continue;
    }
    if (prefixWithSpace) addChar(" ");
    for (const ch of arg) addChar(ch);
    prefixWithSpace = true;
  }
  return entries;
}

/** Non-alphanumeric characters an argv would park on hazardous keymap indices: [{ index, char, key }]. Empty means the invocation is position-safe. */
export function keymapHazardsOf(argv) {
  const hazards = [];
  simulateWtypeKeymap(argv).forEach((entry, index) => {
    if (entry.kind !== "char" || isPositionIndependent(entry.value)) return;
    if (keymapIndexIsHazard(index)) hazards.push({ index, char: entry.value, key: keymapIndexName(index) });
  });
  return hazards;
}

/** argv for ONE wtype invocation: settle, per-key delay, sacrificial Shift_L, then the segment as literal text (after `--`, so a leading dash is never an option). */
export function wtypeTypingArgs(segment, { delayMs = 25, settleMs = TYPING_SETTLE_MS } = {}) {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1000) throw new TypeError("delayMs out of range");
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 5000) throw new TypeError("settleMs out of range");
  return ["-s", String(settleMs), "-d", String(delayMs), "-k", "Shift_L", "--", String(segment)];
}

/** The segmented plan: one argv per segment, in order. Empty text → no invocations. */
export function typingInvocations(value, { delayMs = 25, settleMs = TYPING_SETTLE_MS, maxDistinct = TYPING_MAX_DISTINCT } = {}) {
  return segmentForTyping(value, maxDistinct).map((segment) => wtypeTypingArgs(segment, { delayMs, settleMs }));
}

/** The ORDINARY plan: exactly the single invocation that shipped before (no sacrificial key, value after `--`). */
export function ordinaryTypingArgs(value, { delayMs = 25, settleMs = TYPING_SETTLE_MS } = {}) {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1000) throw new TypeError("delayMs out of range");
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 5000) throw new TypeError("settleMs out of range");
  return ["-s", String(settleMs), "-d", String(delayMs), "--", String(value ?? "")];
}

/**
 * Which invocations to run for a given attempt. Attempt 1 (and anything not a
 * positive integer) is the ordinary single invocation — byte for byte the argv
 * that shipped — whenever that argv is position-safe, i.e. its own
 * first-appearance keymap order parks no non-alphanumeric character on a
 * non-typewriter position (rev 15.1: a value whose ordinary argv carries such
 * a hazard could never land on its first pass — its leading "[" / quote / "-"
 * sat on index 0 = ESC, or a later punctuation mark on 13 = BACKSPACE / 28 =
 * LEFTCTRL — so for exactly those values the first pass is the position-safe
 * segmented plan at the first-path pace; every value that landed before keeps
 * its identical argv). Attempt 2+ — the retry after exact read-back failed —
 * is always the segmented plan. The decision reads keymap indices only. Empty
 * text → no invocations either way.
 */
export function typingArgvPlan(value, { attempt = 1, delayMs = 25, settleMs = TYPING_SETTLE_MS, maxDistinct = TYPING_MAX_DISTINCT } = {}) {
  const text = String(value ?? "");
  if (!text) return [];
  if (!Number.isInteger(attempt) || attempt <= 1) {
    const ordinary = ordinaryTypingArgs(text, { delayMs, settleMs });
    if (keymapHazardsOf(ordinary).length === 0) return [ordinary];
  }
  return typingInvocations(text, { delayMs, settleMs, maxDistinct });
}
