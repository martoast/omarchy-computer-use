// Pure decision function extracted from index.js so it can be unit-tested
// without importing the MCP server (which connects to stdio at load time).
//
// Given a verify_text match record AND context about the ORIGINAL resolved
// target, decide whether it is safe to press Return after typing. Safe
// requires the EXACT value (a prefix means autocomplete extended it, so
// Enter would submit something other than what was asked) AND an
// unambiguous destination for the keypress:
//   - the matching field is actually FOCUSED, or
//   - it is the SOLE match, lives in browser chrome (found.in_doc === false),
//     AND the caller was deliberately targeting the omnibox (target.omnibox).
//
// The chrome escape hatch is bound to BOTH sides on purpose (gh issue #1
// follow-up): `found.in_doc === false` alone proves only "some chrome
// editable", and Chrome exposes other editable controls (Find bar, side
// panel, Ask AI) that verify_text — which searches the whole app by value —
// could match. Requiring the ORIGINAL target to be the address bar means a
// type attempt aimed at an in-page Search field can never be "rescued" into
// submitting via a same-valued Find-bar match. A sole match INSIDE the page
// never qualifies via this hatch: focus can sit on a clear-X/button while a
// still-showing input retains the text — the VS clear-button class.
export function isSubmitSafe(found, target = {}) {
  if (!found || found.match !== "exact") return false;
  if (found.focused) return true;
  return found.candidates === 1 && found.in_doc === false && target.omnibox === true;
}

// Is the ORIGINAL resolved target the Chromium address bar / omnibox? It is
// browser chrome (not inside the page document), an editable entry, and
// carries the omnibox's well-known accessible name. Page inputs never carry
// that exact name, so this identifies the omnibox specifically rather than
// any chrome field.
const ADDRESS_BAR_NAMES = new Set(["address and search bar", "address bar"]);

/** The ONE authoritative address-bar name check, exported as a PREDICATE rather
 * than as the Set itself: an exported Set is mutable policy, and Object.freeze
 * would not stop add/delete on it. Callers get the decision, never the list. */
export function isAddressBarName(name) {
  return ADDRESS_BAR_NAMES.has(String(name ?? "").trim().toLowerCase());
}
export function isOmniboxTarget(element) {
  if (!element || element.role !== "entry") return false;
  if (element.in_doc === true) return false; // must be chrome, not page content
  return isAddressBarName(element.name);
}

// rev 30b — OMNIBOX INLINE AUTOCOMPLETE. Chromium completes a typed URL prefix
// in the address bar by appending the rest of a history entry as SELECTED
// text; one Delete removes exactly that selection and leaves what was typed.
// Live (2026-09-03): the typed homepage came back "prefix" and the tool refused
// Return, costing a retype turn. The Delete is pressed ONLY when the evidence
// is exactly that shape — the omnibox target, a prefix match, and a selection
// that covers precisely the suffix beyond the typed value. Anything else (no
// selection, a selection elsewhere, an in-page field) keeps today's refusal.
export function omniboxAutocompleteDeletion({ omnibox = false, match = null, typedLength = 0, fieldLength = 0, selection = null } = {}) {
  if (omnibox !== true || match !== "prefix") return false;
  if (!Number.isInteger(typedLength) || !Number.isInteger(fieldLength) || typedLength <= 0 || fieldLength <= typedLength) return false;
  if (!Array.isArray(selection) || selection.length !== 2 || !selection.every((n) => Number.isInteger(n))) return false;
  return selection[0] === typedLength && selection[1] === fieldLength;
}
