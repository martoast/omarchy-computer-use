#!/usr/bin/env node
// Pure tests for read-time recovery decisions (no browser).
//
// The whole safety argument rests on these rules: Escape dismisses the omnibox
// dropdown that swallows a page's accessibility tree, but Escape is ALSO
// Chromium's stop-loading shortcut, and this build exposes no signal that a
// navigation finished. So the keystroke is licensed ONLY by positive evidence
// that a navigation this harness started has already completed — and never by
// the absence of evidence.
import {
  invalidatesToken, classifyRecoveryEligibility, resolvesNavigation,
  observationsAgree, contentSignature, shouldAttemptRecovery, isSameTarget,
  NAVIGATION_CAPABLE_TOOLS, READ_ONLY_TOOLS, REFUSAL_TEXT,
  CONTENT_ROLES, isRefEligible, isSiteMemoryEligible, isClickAuthorized, elementCapability,
  ineligibleHandleLabel,
} from "./navigation_recovery.js";

let pass = 0, fail = 0;
const check = (label, got, want) => { const ok = got === want; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`); ok ? pass++ : fail++; };

// --- invalidation table -------------------------------------------------------
// The rule: anything that synthesizes input or activates a control invalidates;
// pure observation does not. Scrolling counts — lazy routing is real.
console.log("--- invalidation ---");
for (const t of ["click", "click_element", "key_press", "move_mouse", "scroll", "scroll_to_element", "select_option", "type_into_element", "type_text"])
  check(`${t} invalidates (can navigate)`, invalidatesToken(t), true);
for (const t of ["read_page", "get_site_map", "list_known_sites", "list_windows", "screenshot", "wait_for_element", "get_input_stats", "get_active_window"])
  check(`${t} does NOT invalidate (observation only)`, invalidatesToken(t), false);
check("scroll_to_element is treated as input, not observation", NAVIGATION_CAPABLE_TOOLS.has("scroll_to_element"), true);
check("wait_for_element stays observation-only", READ_ONLY_TOOLS.has("wait_for_element"), true);
check("the two sets never overlap", [...NAVIGATION_CAPABLE_TOOLS].some((t) => READ_ONLY_TOOLS.has(t)), false);
// DEFAULT-DENY. A hardcoded allowlist of input tools fails OPEN: a tool added
// later that nobody classified would silently preserve stale evidence.
check("an UNKNOWN future tool invalidates (default-deny, not fail-open)", invalidatesToken("some_future_tool_v2"), true);
check("an unknown tool that sounds read-only still invalidates", invalidatesToken("peek_at_page"), true);
check("every declared navigation-capable tool is outside the read-only set",
  [...NAVIGATION_CAPABLE_TOOLS].every((t) => invalidatesToken(t)), true);

// --- eligibility --------------------------------------------------------------
console.log("--- eligibility ---");
const resolved = { state: "resolved", prevPageUri: "https://a.test/", resolvedPageUri: "https://b.test/" };
check("resolved + matching URI -> eligible", classifyRecoveryEligibility(resolved, "https://b.test/").eligible, true);
check("NO record -> refuse (absence of evidence is not proof of quiescence)",
  classifyRecoveryEligibility(null, "https://b.test/").reason, "no_navigation_record");
check("pending -> refuse (navigation may be in flight)",
  classifyRecoveryEligibility({ state: "pending", prevPageUri: "https://a.test/" }, "https://a.test/").reason, "navigation_possibly_in_flight");
check("invalidated -> refuse",
  classifyRecoveryEligibility({ ...resolved, state: "invalidated" }, "https://b.test/").reason, "token_invalidated");
check("already consumed -> refuse (one-shot)",
  classifyRecoveryEligibility({ ...resolved, state: "consumed" }, "https://b.test/").reason, "token_already_used");
check("resolved but the page showing is a DIFFERENT url -> refuse",
  classifyRecoveryEligibility(resolved, "https://c.test/").reason, "page_uri_mismatch");
check("resolved but no current page uri -> refuse",
  classifyRecoveryEligibility(resolved, null).reason, "no_page_document_uri");
check("resolved with no stored uri -> refuse",
  classifyRecoveryEligibility({ state: "resolved" }, "https://b.test/").reason, "token_missing_resolved_uri");

// --- resolution ---------------------------------------------------------------
console.log("--- resolution ---");
// A -> B, with A as the known origin. Only ARRIVAL AT B resolves; an
// intermediate redirect hop C differs from A but proves nothing about the chain
// being finished, and the next hop could still be in flight.
const pending = { state: "pending", prevPage: { state: "known", uri: "https://a.test/" }, requestedUrl: "https://b.test/" };
check("known A + requested B + observed B -> resolves", resolvesNavigation(pending, "https://b.test/"), true);
check("known A + requested B + observed an INTERMEDIATE C -> refuses (chain may still be in flight)",
  resolvesNavigation(pending, "https://c.test/"), false);
check("known A + requested B + observed A -> refuses (still at the origin)",
  resolvesNavigation(pending, "https://a.test/"), false);
check("a reload (requested == origin) never resolves",
  resolvesNavigation({ state: "pending", prevPage: { state: "known", uri: "https://a.test/" }, requestedUrl: "https://a.test/" }, "https://a.test/"), false);
check("no observed uri does not resolve it", resolvesNavigation(pending, null), false);
check("an already-resolved token is not re-resolved", resolvesNavigation({ ...pending, state: "resolved" }, "https://b.test/"), false);
check("an invalidated token is never resolved", resolvesNavigation({ ...pending, state: "invalidated" }, "https://b.test/"), false);
// A MISSING observation is UNKNOWN, never "there was no previous page". If it
// resolved on any URI, a stale previous page reappearing mid-navigation would
// falsely resolve the token and license an Escape into an in-flight load.
check("prevPage UNKNOWN never resolves, whatever is observed",
  resolvesNavigation({ state: "pending", prevPage: { state: "unknown" } }, "https://b.test/"), false);
check("a token with no prevPage at all never resolves",
  resolvesNavigation({ state: "pending" }, "https://b.test/"), false);
// There is deliberately NO "absent" state: nothing available can prove a page
// did not exist. An unrecognized state must therefore refuse, not resolve.
check("a would-be ABSENT state does not resolve (the state no longer exists)",
  resolvesNavigation({ state: "pending", prevPage: { state: "absent" } }, "https://b.test/"), false);
// MEASURED: a fresh tab's document reports an EMPTY uri, not "about:blank", so
// the first navigation of a session has no known origin. The positive signal
// available there is arrival at the REQUESTED destination.
const fresh = (requestedUrl) => ({ state: "pending", prevPage: { state: "unknown" }, requestedUrl });
check("unknown origin + observed IS the requested destination -> resolves",
  resolvesNavigation(fresh("https://b.test/page"), "https://b.test/page"), true);
check("unknown origin + observed is some OTHER url (a stale page) -> refuses",
  resolvesNavigation(fresh("https://b.test/page"), "https://a.test/"), false);
check("unknown origin + no requested url -> refuses",
  resolvesNavigation({ state: "pending", prevPage: { state: "unknown" } }, "https://b.test/"), false);
check("a redirected landing url is NOT the requested destination -> refuses",
  resolvesNavigation(fresh("https://b.test/"), "https://c.test/"), false);
// Structural comparison, not string equality.
check("trailing slash does not make it a different target", isSameTarget("https://b.test/page/", "https://b.test/page"), true);
check("host case is ignored", isSameTarget("https://B.TEST/p", "https://b.test/p"), true);
check("a fragment is ignored", isSameTarget("https://b.test/p#top", "https://b.test/p"), true);
check("a different query IS a different target", isSameTarget("https://b.test/p?a=1", "https://b.test/p?a=2"), false);
check("a different path is a different target", isSameTarget("https://b.test/p", "https://b.test/q"), false);
check("a redirect to another host does not match (fail closed)", isSameTarget("https://c.test/", "https://b.test/"), false);
check("unparseable input never matches", isSameTarget("not a url", "https://b.test/"), false);
// A different URI alone is NOT enough any more — the destination must match.
check("prevPage KNOWN + a different uri that is NOT the destination -> refuses",
  resolvesNavigation({ state: "pending", prevPage: { state: "known", uri: "https://a.test/" }, requestedUrl: "https://b.test/" }, "https://x.test/"), false);
check("prevPage KNOWN does not resolve on the same uri",
  resolvesNavigation({ state: "pending", prevPage: { state: "known", uri: "https://a.test/" }, requestedUrl: "https://b.test/" }, "https://a.test/"), false);

// --- stability ----------------------------------------------------------------
console.log("--- stability ---");
const obs = (pageUri, signature) => ({ pageUri, signature });
check("same uri + same signature agree", observationsAgree(obs("u", "link:2"), obs("u", "link:2")), true);
check("different uri disagrees", observationsAgree(obs("u", "link:2"), obs("v", "link:2")), false);
check("different signature disagrees", observationsAgree(obs("u", "link:2"), obs("u", "link:3")), false);
check("signature is order-independent",
  contentSignature([{ role: "link" }, { role: "heading" }, { role: "link" }]),
  contentSignature([{ role: "heading" }, { role: "link" }, { role: "link" }]));
check("signature distinguishes different content", contentSignature([{ role: "link" }]) === contentSignature([{ role: "link" }, { role: "link" }]), false);

// --- the whole trigger ---------------------------------------------------------
console.log("--- trigger ---");
const stable = [obs("https://b.test/", "s"), obs("https://b.test/", "s")];
const base = { pageContentCount: 0, focusDocClass: "browser_internal", pageUri: "https://b.test/", token: resolved, observations: stable };
check("empty page + browser-internal focus + resolved token + stable -> ACT", shouldAttemptRecovery(base).act, true);
check("page has content -> refuse", shouldAttemptRecovery({ ...base, pageContentCount: 3 }).reason, "page_not_empty");
check("focus already in the page -> refuse", shouldAttemptRecovery({ ...base, focusDocClass: "page" }).reason, "focus_already_in_page");
check("no focus -> refuse (not proof the browser UI holds it)", shouldAttemptRecovery({ ...base, focusDocClass: "none" }).reason, "no_focus");
check("unknown focus document -> refuse", shouldAttemptRecovery({ ...base, focusDocClass: "unknown" }).reason, "focus_document_unknown");
check("no page uri -> refuse", shouldAttemptRecovery({ ...base, pageUri: null }).reason, "no_page_document_uri");
check("NO navigation record -> refuse", shouldAttemptRecovery({ ...base, token: null }).reason, "no_navigation_record");
check("pending navigation -> refuse", shouldAttemptRecovery({ ...base, token: pending }).reason, "navigation_possibly_in_flight");
check("invalidated -> refuse", shouldAttemptRecovery({ ...base, token: { ...resolved, state: "invalidated" } }).reason, "token_invalidated");
check("consumed -> refuse (the one permitted recovery is spent)", shouldAttemptRecovery({ ...base, token: { ...resolved, state: "consumed" } }).reason, "token_already_used");
check("unstable observations -> refuse", shouldAttemptRecovery({ ...base, observations: [obs("https://b.test/", "s"), obs("https://b.test/", "t")] }).reason, "page_unstable");
check("too few observations -> refuse", shouldAttemptRecovery({ ...base, observations: [obs("https://b.test/", "s")] }).reason, "insufficient_observations");

// Every refusal reason must have text a caller can act on.
console.log("--- reporting ---");
const reasons = ["page_not_empty", "focus_already_in_page", "no_focus", "focus_document_unknown", "no_page_document_uri",
  "no_navigation_record", "navigation_possibly_in_flight", "token_invalidated", "token_already_used",
  "token_missing_resolved_uri", "token_unrecognized_state", "page_uri_mismatch", "insufficient_observations", "page_unstable"];
check("every refusal reason has an explanation", reasons.every((r) => typeof REFUSAL_TEXT[r] === "string" && REFUSAL_TEXT[r].length > 20), true);

// --- what may carry a ref, and what may reach site memory ---------------------
console.log("--- collection eligibility ---");
const pageLink = { role: "link", name: "Shop", doc_class: "page" };
const popupBtn = { role: "button", name: "Ask AI Mode", doc_class: "browser_internal" };
// The omnibox must be POSITIVELY chrome and POSITIVELY outside a document.
const chromeEntry = { role: "entry", name: "Address and search bar", doc_class: "chrome", in_doc: false };
const unknownEl = { role: "link", name: "?", doc_class: "unknown" };
check("a page node may carry an actionable ref", isRefEligible(pageLink), true);
check("a BROWSER-INTERNAL node may NOT carry a ref", isRefEligible(popupBtn), false);
check("the trusted address bar keeps its ref — focus/type still needs it", isRefEligible(chromeEntry), true);

// --- provenance capability: the one rule shared by ref minting and clicking ---
// Measured (REI, 07e180c): the old rule denied refs ONLY to browser_internal, so
// the browser WINDOW's own Close button got an actionable ref, rendered like page
// content, and was activated — Chromium exited code 0 because that closed the
// only window. Every clause below is a POSITIVE requirement for that reason.
const chromeClose = { role: "button", name: "Close", doc_class: "chrome", in_doc: false };
const pageDialogClose = { role: "button", name: "Close", doc_class: "page", in_doc: true, in_dialog: true };
const iframeDialogClose = { role: "button", name: "Close", doc_class: "page", in_doc: true, in_dialog: true, doc_gen: "/doc/iframe-2" };

check("the browser WINDOW's Close gets NO ref", isRefEligible(chromeClose), false);
check("  ...and can never be clicked", isClickAuthorized(chromeClose), false);
check("a PAGE dialog's Close keeps its ref", isRefEligible(pageDialogClose), true);
check("  ...and stays clickable — this is the case that must keep working", isClickAuthorized(pageDialogClose), true);
check("a page dialog inside an IFRAME is still clickable", isClickAuthorized(iframeDialogClose), true);
check("the address bar is NOT click-authorized (type_into_element owns it)", isClickAuthorized(chromeEntry), false);
check("  ...but is capability 'omnibox', not 'none'", elementCapability(chromeEntry), "omnibox");

// A chrome BUTTON carrying the address-bar name must not inherit the exception.
check("a chrome BUTTON named like the address bar is refused (role must match)",
  isRefEligible({ role: "button", name: "Address and search bar", doc_class: "chrome", in_doc: false }), false);
// Nor may a PAGE input impersonate it into the chrome exception (it is page anyway).
check("a page entry named like the address bar is page-capable, not omnibox",
  elementCapability({ role: "entry", name: "Address and search bar", doc_class: "page", in_doc: true }), "page");

// MISSING provenance fails closed on BOTH sides — this is the legacy-cache case.
for (const [label, el] of [
  ["no doc_class at all", { role: "button", name: "Close" }],
  ["doc_class unknown", { role: "button", name: "Close", doc_class: "unknown" }],
  ["chrome entry with MISSING in_doc", { role: "entry", name: "Address and search bar", doc_class: "chrome" }],
  ["chrome entry with in_doc true", { role: "entry", name: "Address and search bar", doc_class: "chrome", in_doc: true }],
  ["null", null],
  ["a string", "button"],
]) {
  check(`${label}: no ref`, isRefEligible(el), false);
  check(`${label}: not clickable`, isClickAuthorized(el), false);
}

// The rendered handle distinguishes known browser UI from an unproven surface.
check("chrome renders as browser-ui", ineligibleHandleLabel(chromeClose), "(browser-ui)");
check("browser_internal renders as browser-ui", ineligibleHandleLabel(popupBtn), "(browser-ui)");
check("an unverified surface says so instead", ineligibleHandleLabel(unknownEl), "(unverified-ui)");
check("missing provenance is unverified, not browser-ui", ineligibleHandleLabel({ role: "button" }), "(unverified-ui)");
check("a page link reaches site memory", isSiteMemoryEligible(pageLink), true);
check("a browser-internal button NEVER reaches site memory", isSiteMemoryEligible(popupBtn), false);
check("browser chrome never reaches site memory either", isSiteMemoryEligible(chromeEntry), false);
check("an UNKNOWN-document node does not reach site memory (positive page required)", isSiteMemoryEligible(unknownEl), false);
check("a non-field, non-nav page node is not site knowledge", isSiteMemoryEligible({ role: "static", name: "x", doc_class: "page" }), false);
check("a modal counts as readable content", CONTENT_ROLES.has("dialog"), true);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
