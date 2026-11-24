// Pure decision logic for read-time omnibox-popup recovery, extracted so the
// safety rules are unit-testable without a browser.
//
// Background: typing a URL into the address bar opens Chromium's suggestion
// dropdown, and it can keep keyboard focus after Enter. While it does, the
// navigated page's accessibility subtree is not exposed at all — read_page
// returns browser chrome only, which is indistinguishable from a dead site.
// One Escape dismisses the dropdown and the page becomes readable.
//
// The danger: Escape is ALSO Chromium's stop-loading shortcut. Measured — a
// live store landed on about:blank when it was pressed mid-navigation, and
// during a navigation's whole in-flight window the PREVIOUS document sits there
// with an unchanging URI and unchanging content. A stale page is perfectly
// stable, so "it looks settled" proves nothing. This build exposes no BUSY
// state and no completion signal of any kind.
//
// Therefore the only thing that licenses the keystroke is POSITIVE evidence
// that a navigation this harness started has already completed: the recovery
// token below. Absence of evidence never licenses it.

import { isAddressBarName } from "./submit_safety.js";

/** Tools whose effect can navigate the page, and which therefore invalidate a
 * recovery token. The rule is: anything that SYNTHESIZES INPUT or ACTIVATES a
 * control invalidates; pure observation does not. Scrolling counts — lazy
 * routing and infinite-scroll navigation are real. */
export const NAVIGATION_CAPABLE_TOOLS = new Set([
  "click", "click_element", "key_press", "move_mouse", "scroll",
  "scroll_to_element", "select_option", "type_into_element", "type_text",
]);

/** Observation-only tools: they never invalidate. */
export const READ_ONLY_TOOLS = new Set([
  "get_active_window", "get_active_workspace", "get_input_stats", "get_site_map",
  "list_known_sites", "list_windows", "read_page", "save_site_map", "screenshot",
  "wait_for_element",
]);

/** DEFAULT-DENY: only an explicitly classified observation-only tool preserves a
 * token. Anything else — including a tool added later that nobody remembered to
 * classify — invalidates. The alternative fails OPEN: a new input tool would
 * silently keep stale evidence alive and could license a keystroke. */
export function invalidatesToken(toolName) {
  return !READ_ONLY_TOOLS.has(toolName);
}

/** Is this token allowed to license exactly one Escape right now?
 * `token` is the stored state (or null/undefined when none exists). */
export function classifyRecoveryEligibility(token, currentPageUri) {
  if (!token) {
    // Absence of a record is absence of evidence, NOT proof of quiescence: the
    // page may have navigated by link, form submit, redirect, meta refresh,
    // script or history, none of which this harness would have recorded.
    return { eligible: false, reason: "no_navigation_record" };
  }
  if (token.state === "invalidated") return { eligible: false, reason: "token_invalidated" };
  if (token.state === "pending") return { eligible: false, reason: "navigation_possibly_in_flight" };
  if (token.state === "consumed") return { eligible: false, reason: "token_already_used" };
  if (token.state !== "resolved") return { eligible: false, reason: "token_unrecognized_state" };
  if (!token.resolvedPageUri) return { eligible: false, reason: "token_missing_resolved_uri" };
  if (!currentPageUri) return { eligible: false, reason: "no_page_document_uri" };
  if (currentPageUri !== token.resolvedPageUri) return { eligible: false, reason: "page_uri_mismatch" };
  return { eligible: true, reason: "resolved_and_matching" };
}

/** A navigation resolves ONLY by observing a page URI different from the one
 * showing BEFORE the harness touched the omnibox. A same-url reload can never
 * resolve, because nothing in this build distinguishes "reloaded" from "never
 * started".
 *
 * `token.prevPage` is two-valued, and deliberately has NO "absent":
 *   {state:"known", uri}  a document identity was POSITIVELY OBSERVED. MEASURED
 *                         on this build: a fresh tab's document reports an EMPTY
 *                         uri, so a fresh tab yields UNKNOWN, not "about:blank".
 *                         If a future build does report about:blank, it would be
 *                         treated as known like any other observed identity.
 *   {state:"unknown"}     nothing was positively observed
 * There is no "there was no previous page" state, because nothing available can
 * prove it: the observation comes from a depth/budget-capped tree walk that
 * swallows exceptions, so "found no page URI" can equally mean a hidden tree, a
 * capped traversal, or a failure. Treating that as absence would let ANY later
 * URI resolve the token — including a stale previous page reappearing while the
 * real destination is still in flight, which would license an Escape into a live
 * load.
 *
 * RESOLUTION REQUIRES ARRIVAL AT THE REQUESTED DESTINATION, for every token.
 * "The URI differs from where we started" is NOT enough: it proves that *a*
 * document committed, not that the requested chain finished. An HTTP or
 * client-side redirect hop is a different URI too, it can sit there stably for
 * longer than any settle window, and the NEXT hop is still in flight — so
 * Escape would cancel it. That is the missing-completion-signal problem again,
 * wearing a different hat.
 * A known origin is kept only as a NEGATIVE guard: still showing it means
 * definitely not arrived.
 * MEASURED: a fresh tab's document reports an EMPTY uri rather than
 * "about:blank", so the first navigation of a session has no known origin at
 * all. (The window title does say "about:blank", but a page can set its own
 * title, and trusting it would let a spoofed title stand in for a real previous
 * URL — reintroducing the hazard above.) Destination arrival covers that case
 * without inventing evidence.
 * CONSEQUENCE, accepted deliberately: a navigation that redirects to a different
 * canonical URL never resolves, so recovery is unavailable there until a real
 * completion or redirect signal exists. Fail-closed beats a cancelled load.
 *
 * RESIDUAL LIMITATION, stated rather than papered over: arriving at the requested
 * destination proves the requested navigation finished — it CANNOT prove the page
 * will not start another one. A script or meta-refresh navigation begun after
 * arrival is unobservable in advance, so an Escape could still land during it.
 * The one-shot token and the consecutive-observation stability gate narrow that
 * window; nothing available closes it. */
export function resolvesNavigation(token, observedPageUri) {
  if (!token || token.state !== "pending") return false;
  if (!observedPageUri) return false;
  const prev = token.prevPage;
  if (prev && prev.state === "known" && observedPageUri === prev.uri) return false;
  return isSameTarget(observedPageUri, token.requestedUrl);
}

/** Do two URLs address the same document, ignoring only the fragment? Compared
 * structurally, never as raw strings, so a trailing-slash or case difference in
 * the scheme/host cannot masquerade as a different page — or hide one. */
export function isSameTarget(observed, requested) {
  if (!observed || !requested) return false;
  const norm = (u) => {
    try {
      const p = new URL(String(u).trim());
      const path = p.pathname.replace(/\/+$/, "");
      return `${p.protocol}//${p.host}${path}${p.search}`;
    } catch { return null; }
  };
  const a = norm(observed), b = norm(requested);
  return a !== null && a === b;
}

/** Two observations agree closely enough to call the page settled. */
export function observationsAgree(a, b) {
  if (!a || !b) return false;
  if (a.pageUri !== b.pageUri) return false;
  return a.signature === b.signature;
}

/** A compact, comparable description of what the page is exposing. */
export function contentSignature(entries) {
  const byRole = {};
  for (const e of entries || []) byRole[e.role] = (byRole[e.role] || 0) + 1;
  return Object.keys(byRole).sort().map((r) => `${r}:${byRole[r]}`).join(",");
}

/** The whole trigger, in one place. Every refusal names a distinct reason so
 * the caller is told which rule stopped it. */
export function shouldAttemptRecovery({ pageContentCount, focusDocClass, pageUri, token, observations }) {
  if (pageContentCount > 0) return { act: false, reason: "page_not_empty" };
  if (focusDocClass !== "browser_internal") {
    return { act: false, reason: focusDocClass === "page" ? "focus_already_in_page"
      : focusDocClass === "none" ? "no_focus" : "focus_document_unknown" };
  }
  if (!pageUri) return { act: false, reason: "no_page_document_uri" };
  const elig = classifyRecoveryEligibility(token, pageUri);
  if (!elig.eligible) return { act: false, reason: elig.reason };
  if (!observations || observations.length < 2) return { act: false, reason: "insufficient_observations" };
  const [first, second] = observations.slice(-2);
  if (!observationsAgree(first, second)) return { act: false, reason: "page_unstable" };
  return { act: true, reason: "eligible" };
}

/** Human-readable explanation for each refusal, so a report never says merely
 * "not eligible". */
export const REFUSAL_TEXT = {
  page_not_empty: "the page already exposes content, so there is nothing to recover",
  focus_already_in_page: "keyboard focus is already inside the page document",
  no_focus: "nothing holds keyboard focus, which is not proof the browser's UI does",
  focus_document_unknown: "the focused node's document could not be identified",
  no_page_document_uri: "no page document URI could be read",
  no_navigation_record: "this harness has no record of navigating here, so it cannot prove no navigation is in flight — pressing Escape could cancel one",
  navigation_possibly_in_flight: "a navigation started here has not been observed to complete, and Escape is the browser's stop-loading shortcut",
  token_invalidated: "an action since the last navigation could itself have navigated, so the earlier evidence no longer holds",
  token_already_used: "the single permitted recovery for this navigation has already been used",
  token_missing_resolved_uri: "the navigation record carries no resolved page URL",
  token_unrecognized_state: "the navigation record is in an unrecognized state",
  page_uri_mismatch: "the page showing now is not the one the completed navigation resolved to",
  insufficient_observations: "the page could not be observed enough times to call it settled",
  page_unstable: "the page changed between consecutive observations, so it is not settled",
};

/** What counts as the page having something to read. `dialog` is included
 * deliberately: a consent or promo modal appearing IS restored readability —
 * the caller can see and act on it — even though the storefront behind it may
 * still be hidden. */
export const CONTENT_ROLES = new Set([
  "link", "heading", "static", "image", "paragraph", "button", "entry", "dialog",
]);

/** A ref is an ACTIONABLE handle. Browser WebUI nodes are shown for diagnosis
 * but must never receive one: offering a ref invites a caller to click browser
 * chrome believing it to be page content. */
/** ONE provenance decision, shared by ref minting and by click authorization so
 * the two cannot drift apart.
 *
 * Why it exists (measured, REI): the old rule denied refs only to
 * `browser_internal`, so EVERY other browser-chrome control — including the
 * window's own Close button — was handed an actionable ref, rendered
 * indistinguishably from page content, and activated without any provenance
 * check. The run ended with Chromium exiting code 0 at 18.5s: the click had
 * closed the browser window.
 *
 * Returns "page" | "omnibox" | "none".
 *   page    — positively inside a web document. Full capability.
 *   omnibox — the trusted address bar, and ONLY that: positively chrome,
 *             positively NOT in a document, role entry, and one of the
 *             address-bar names. It may carry a ref so focus/type can target
 *             it; it is still never click-authorized.
 *   none    — everything else, INCLUDING unknown and missing provenance.
 *             "We could not establish the surface" is not permission to act on
 *             it; that asymmetry is already the bridge's stated rule (the read
 *             side must not hide content, the act side must not act on an
 *             unproven surface).
 * Every clause requires a POSITIVE value, so a legacy cache entry or a response
 * that predates provenance stamping fails closed rather than inheriting trust
 * from an absent field. */
export function elementCapability(el) {
  if (!el || typeof el !== "object") return "none";
  if (el.doc_class === "page") return "page";
  if (el.doc_class === "chrome" && el.in_doc === false
      && el.role === "entry" && isAddressBarName(el.name)) {
    return "omnibox";
  }
  return "none";
}

/** May this node carry an ACTIONABLE ref? A ref is a handle a caller can act
 * through, so offering one for browser UI invites exactly the mistake above.
 * Chrome and unverified nodes stay VISIBLE — they simply carry no handle. */
export function isRefEligible(el) {
  return elementCapability(el) !== "none";
}

/** May click_element activate this node? Page content only. The omnibox is
 * deliberately excluded: it is reachable for focus/type through
 * type_into_element's own trusted path, and a generic click on browser UI is
 * the capability being removed. */
export function isClickAuthorized(el) {
  return elementCapability(el) === "page";
}

/** How an ineligible node is labelled where a ref would otherwise go. The two
 * cases are different facts and are not worth conflating: chrome is a known
 * browser surface, whereas unknown/missing means the surface could not be
 * established at all. */
export function ineligibleHandleLabel(el) {
  const cls = el?.doc_class;
  return cls === "chrome" || cls === "browser_internal" ? "(browser-ui)" : "(unverified-ui)";
}

/** Per-domain site memory records what a SITE exposes. A node from the browser's
 * own WebUI is not site knowledge — this is how Chromium's "Ask AI Mode" came to
 * be stored as a Victoria's Secret field. Positive page classification required;
 * "unknown" and chrome do not qualify. */
export function isSiteMemoryEligible(el) {
  if (el?.doc_class !== "page") return false;
  const isField = ["entry", "password text", "combo box"].includes(el.role);
  const isNav = el.role === "link" || el.role === "button";
  return isField || isNav;
}
