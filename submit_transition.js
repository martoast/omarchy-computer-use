// In-page submit transition OBSERVATION: pure decision layer, extracted from
// index.js so every part is unit-testable without the MCP server (which
// connects to stdio at load) and without a browser.
//
// The problem this addresses: pressing Return in a page form may navigate, may
// update in place, or may do nothing, and the harness reported none of it. The
// model then acted on refs captured BEFORE the submit — a re-render silently
// stales them — and burned a turn discovering that. So after a submit we
// actually paid for, we spend a bounded look at the page document URI and
// report what was observed.
//
// EVIDENCE ONLY. This never claims the submit succeeded or failed: "unchanged"
// is equally consistent with a slow transition still in flight and with an
// in-place update, and neither of those is an error. The classification has
// exactly three outcomes and no others.
import { sanitizeInline } from "./text_serialization.js";

// How many windows may hold an armed token at once. A CAPACITY, not a deadline
// — the difference matters, because the deadline this replaced deleted LIVE
// tokens. 8 is twice the four-job headless ceiling this harness supports, so it
// bounds an abandoned token's leakage without constraining any concurrency that
// actually happens.
export const MAX_ARMED_TOKENS = 8;
// One post-press read is not enough — a form submit commits its navigation
// asynchronously, so a single immediate read reports the OLD url and would
// manufacture a false "unchanged". Poll instead, and stop the moment the URI
// changes so the common case costs one read.
export const TRANSITION_BUDGET_MS = 1800;
export const TRANSITION_POLL_MS = 250;

// May a verified type_into_element arm a token? Every clause is required.
// press_enter:true never arms (that call observes inline instead); the omnibox
// never arms (its navigation is already covered by the pending-token path); an
// unverified, prefix-matched or unfocused record never arms, which is exactly
// what submitSafe already encodes; and the match must be INSIDE the page
// document, so a same-valued Find-bar or side-panel match cannot arm.
export function canArmSubmitToken({ omnibox, pressEnter, found, submitSafe } = {}) {
  if (pressEnter) return false;
  if (omnibox) return false;
  if (!found || found.in_doc !== true) return false;
  return submitSafe === true;
}

// Roles that PLAINLY cannot accept typed text. A denylist rather than an
// allowlist on purpose: the failure this predicate exists to prevent is a
// MISSING baseline (which downgrades a real submit to "unobservable"), so an
// unfamiliar or newly-exposed editable role must default to capturing. The cost
// of a wrong `true` here is one page-URI read; the cost of a wrong `false` is
// the model acting on refs a re-render already staled. Contenteditable hosts
// (section/paragraph/document web) are deliberately NOT listed: Chromium
// exposes them inconsistently and they do accept text.
const NON_TEXT_ROLES = new Set([
  "push button", "button", "toggle button", "link", "check box", "checkbox",
  "radio button", "menu item", "check menu item", "radio menu item", "list item",
  "image", "heading", "static", "label", "tab", "tab list", "separator",
  "scroll bar", "progress bar", "tool bar", "menu", "menu bar",
]);

// Should this type_into_element pay for a PRE-TYPING page-URI reading?
//
// The baseline is evidence and nothing else: it is captured before the first
// synthetic input and is the only thing a later Return can be compared against.
// It was previously captured only for omnibox-SHAPED targets, so a site search
// addressed by its visible text ("Search") got none — and with no baseline the
// observer returns "unobservable" WITHOUT polling at all, which is precisely
// when the model is told to go and read a page whose navigation has not
// committed yet. That is the waste this widening removes.
//
// `role` is the RESOLVED role (an explicit one, else the ref's cached snapshot
// role), so a ref-addressed call is judged on what it actually points at
// without paying an extra tree walk to find out.
//
// This decides ONLY whether to spend a read. It grants no authorization: submit
// safety, provenance and token arming are unchanged and still gate every
// keystroke downstream.
export function needsSubmitBaseline({ role, pressEnter } = {}) {
  // A call that will itself press Return could submit whatever it typed, so it
  // always gets a baseline — including targets whose role is unknown here.
  if (pressEnter === true) return true;
  const r = String(role ?? "").trim().toLowerCase();
  if (!r) return true; // role unknown: capture, because a missing baseline is the costly error
  return !NON_TEXT_ROLES.has(r);
}

// Should key_press even look for a token? Pure, and deliberately the FIRST
// thing the handler asks, because a false answer must cost nothing: no window
// resolution, no bridge call, no extra await. Only a raw, unmodified Return
// can consume — every other key, and any modifier combination, is left byte
// for byte as it was.
export function isPlainReturn(canonical, modifiers) {
  return canonical === "Return" && Array.isArray(modifiers) && modifiers.length === 0;
}

/** Per-window token store. Single-use, capacity-bounded, and NEVER time-expired.
 *
 * It used to expire entries after a wall-clock TTL. MEASURED failure: a
 * verified, focused, in-page type armed a token, the model then spent 9469ms in
 * inference with no intervening tool at all, and the token was pruned before
 * the Return it existed for — so the submit went unobserved, silently, which is
 * the exact failure this whole mechanism exists to prevent.
 *
 * Removing expiry is safe because the token AUTHORIZES NOTHING. keyPressAction
 * sends the keystroke on all four of its paths; the token only decides whether
 * to OBSERVE a Return already being sent. (Not to be confused with
 * recoveryTokens in index.js, which does license an Escape and keeps every one
 * of its guards.) What still constrains this token: any non-read-only tool
 * clears the whole store before it runs, any non-plain key clears it,
 * consumption is single-use, and a Return reaching another window never spends
 * this one's.
 *
 * Staleness is reported rather than enforced: take() returns how old the
 * baseline is, and the caller carries that into the observation. An old
 * baseline weakens ATTRIBUTION, never the ref-staleness conclusion, and it
 * cannot manufacture a false "unchanged" — a URL equal to an old baseline is
 * still equal now.
 */
export class SubmitTokenStore {
  constructor(now = Date.now) {
    this.now = now;
    this.tokens = new Map();
  }
  get size() {
    return this.tokens.size;
  }
  /** Which key to drop when the store is full: the OLDEST armedAt, with
   * insertion order as the tie-break. Map order is NOT assumed to equal arming
   * order — an injected clock can hand two entries the same armedAt, so the
   * timestamp is compared explicitly and only ties fall back to insertion. */
  oldestKey() {
    let key = null;
    let oldest = Infinity;
    for (const [windowKey, token] of this.tokens) {
      const at = Number.isFinite(token?.armedAt) ? token.armedAt : -Infinity;
      if (at < oldest) { oldest = at; key = windowKey; } // strict <: first wins a tie
    }
    return key;
  }
  arm(windowKey, { baselineUri = null, target = null } = {}) {
    // Delete before set, so a RE-ARM moves the key to the end of the insertion
    // order. Map.set on an existing key keeps its original position, which
    // would leave insertion order disagreeing with arming order and make the
    // tie-break above wrong.
    this.tokens.delete(windowKey);
    if (this.tokens.size >= MAX_ARMED_TOKENS) {
      const evict = this.oldestKey();
      if (evict !== null) this.tokens.delete(evict);
    }
    this.tokens.set(windowKey, { baselineUri, target, armedAt: this.now() });
    return this.tokens.get(windowKey);
  }
  /** Consume: the token for THIS window, or null. Removed on the way out, so it
   * can never be spent twice. `ageMs` is how long the baseline has been held,
   * measured with THIS store's clock — never the caller's, since subtracting
   * across two clocks is its own bug. Clamped to a non-negative integer, and
   * null when either side is unreadable: a clock that moved backwards must not
   * fabricate a negative age, and an unmeasurable age is reported as unknown
   * rather than as zero. */
  take(windowKey) {
    const token = this.tokens.get(windowKey);
    if (!token) return null;
    this.tokens.delete(windowKey);
    const at = this.now();
    const ageMs = Number.isFinite(at) && Number.isFinite(token.armedAt)
      ? Math.max(0, Math.round(at - token.armedAt))
      : null;
    return { ...token, ageMs };
  }
  peek(windowKey) {
    return this.tokens.get(windowKey) || null;
  }
  invalidateAll() {
    this.tokens.clear();
  }
}

// MONOTONIC by default. Date.now is wall-clock: an NTP step or a suspend/resume
// mid-observation could make the elapsed figure this now REPORTS a negative or
// wildly inflated number, and it also decides when the budget expires. The
// clock stays injectable, so tests are unaffected; `performance.now` matches
// what headless_instance.mjs already uses for the same reason.
const monotonicNow = () => performance.now();

// How many per-poll records the observation retains. Diagnostic only — never
// shown to the model — and bounded so a future longer budget cannot grow this
// without bound. The FIRST N are kept and `polls` always carries the exact
// total, so a truncated list never misrepresents how many reads happened.
export const MAX_TRANSITION_SAMPLES = 12;

// Bounded, evidence-only observation. Reads the page document URI until it
// differs from the pre-typing baseline or the budget runs out, whichever comes
// first. `readUri` supplies the reading (null when it cannot be read), `sleep`
// and `now` are injected so the whole loop is deterministic in tests.
//
// It also reports what it ACTUALLY SPENT: `elapsedMs` and `polls`, plus a
// bounded `samples` trail of when each read landed and what it saw. The note
// used to quote TRANSITION_BUDGET_MS, which is the budget rather than the
// spend — and the budget is not even a wall-clock bound, since it only decides
// whether a NEW read may start, so a read beginning just under the deadline
// still runs to completion. None of this changes a classification; it exists so
// a late commit can be attributed instead of guessed at.
// `baselineAgeMs` is EVIDENCE IN TRANSIT: how long the baseline had been held
// when the keypress landed. This function performs no logic on it and never
// lets it affect a classification — it is carried through so the note and the
// diagnostic can report it. null means "not applicable" (the direct in-page
// path captured its baseline in the same call) rather than zero, which would be
// a claim about elapsed time nobody measured.
export async function observeSubmitTransition({
  baselineUri,
  readUri,
  sleep,
  now = monotonicNow,
  budgetMs = TRANSITION_BUDGET_MS,
  intervalMs = TRANSITION_POLL_MS,
  baselineAgeMs = null,
} = {}) {
  // No pre-interaction baseline means there is nothing to compare against.
  // Polling could not classify anything, so it is not performed at all — and
  // the zero elapsed/zero polls below say exactly that, rather than leaving
  // "we never looked" indistinguishable from "we looked and saw nothing".
  if (!baselineUri) {
    return { classification: "unobservable", missing: "baseline", baselineUri: null, observedUri: null, polls: 0, elapsedMs: 0, samples: [], baselineAgeMs };
  }
  const started = now();
  const elapsed = () => now() - started;
  const samples = [];
  // `read` is a classification of the READING, never the URI itself: URIs are
  // page-influenced, and this trail must stay a fixed-size record of facts
  // rather than a place a site's own string can accumulate.
  const sample = (read) => { if (samples.length < MAX_TRANSITION_SAMPLES) samples.push({ atMs: elapsed(), read }); };
  let polls = 0;
  let sawAnyReading = false;
  let lastReading = null;
  // Set only by B2 below, and only ever once: it converts the final sleep from
  // wasted time into one last sample.
  let finalRead = false;
  while (true) {
    let uri = null;
    try { uri = await readUri(); } catch { uri = null; }
    polls += 1;
    if (uri) {
      sawAnyReading = true;
      lastReading = uri;
      if (uri !== baselineUri) {
        sample("different");
        return { classification: "navigated", missing: null, baselineUri, observedUri: uri, polls, elapsedMs: elapsed(), samples, baselineAgeMs };
      }
      sample("same");
    } else {
      sample("unreadable");
    }
    // That read WAS the final one (the deadline was crossed during the sleep
    // below). Stop unconditionally — the only way past this point is the
    // navigated return above.
    if (finalRead) break;
    // B1: we have just read and time is up. No extra read here — reading twice
    // in a row observes nothing new, and a read that itself crossed the budget
    // has already told us everything the budget was going to buy.
    if (elapsed() >= budgetMs) break;
    await sleep(intervalMs);
    // B2: the deadline fell INSIDE the sleep we just paid for. Previously this
    // broke here, so the sleep bought nothing: MEASURED on REI, the fifth read
    // landed at 1753ms, this loop slept 250ms specifically in order to sample
    // again, and then exited at 2003ms without reading. That made the last
    // interval of EVERY watch unobserved by construction. Now the already-paid
    // sleep is consumed by exactly one more read, and the flag guarantees it is
    // exactly one: no budget change, no second sleep, no way to set this twice.
    if (elapsed() >= budgetMs) finalRead = true;
  }
  if (!sawAnyReading) return { classification: "unobservable", missing: "current", baselineUri, observedUri: null, polls, elapsedMs: elapsed(), samples, baselineAgeMs };
  return { classification: "unchanged", missing: null, baselineUri, observedUri: lastReading, polls, elapsedMs: elapsed(), samples, baselineAgeMs };
}

// --- the diagnostic record ---------------------------------------------------
// The samples trail was built and then discarded: nothing read it, so it could
// not support the post-mortem it was added for. A trail nobody consumes is not
// evidence, it is dead weight — so it now has exactly one consumer, and this is
// the fixed schema that reaches it.
//
// PAGE-FREE BY CONSTRUCTION, not by convention. Every field is either a number
// or a member of a closed enum; there is no branch on which a URI, an element
// name, or any other page-controlled string can appear, even if a caller hands
// this a hostile object. That is why the enums are clamped here rather than
// trusted from the result: the guarantee has to hold on the input as given.
const CLASSIFICATIONS = new Set(["navigated", "unchanged", "unobservable"]);
const MISSING_KINDS = new Set(["baseline", "current"]);
const READ_KINDS = new Set(["same", "different", "unreadable"]);
const clampInt = (value) => (Number.isFinite(value) ? Math.round(value) : null);

/** A DURATION: a non-negative finite integer, or null when it is not one.
 *
 * The store already clamps the age it measures, but that is not where the
 * guarantee has to hold. Both reporting boundaries below accept a result object
 * from a caller, and a result carrying baselineAgeMs: -10 would otherwise be
 * serialized into the diagnostic and worded to the model as "-10ms" — a claim
 * that time ran backwards, from a layer whose whole contract is that its output
 * is sanitized evidence. So the sanitizing happens HERE, on the value as given,
 * exactly like the enum clamping beside it.
 *
 * Null rather than zero for every invalid input: an unmeasurable duration is
 * unknown, and reporting it as 0 would assert the keypress followed the
 * baseline instantly. A numeric STRING is also null — this coerces nothing, so
 * no caller-supplied text can reach a numeric field. A valid 0 IS a duration
 * and is kept. */
export function nonNegativeInt(value) {
  // Sign is judged BEFORE rounding. Math.round(-0.4) is -0, and -0 >= 0 is
  // true, so rounding first would let a negative duration through as a
  // negative zero. The final normalisation exists for the same reason: -0 is
  // not a value this should ever hand to a caller.
  if (!Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

export function submitTransitionDiagnostic(result) {
  if (!result || typeof result !== "object") return null;
  const samples = Array.isArray(result.samples) ? result.samples.slice(0, MAX_TRANSITION_SAMPLES) : [];
  return {
    classification: CLASSIFICATIONS.has(result.classification) ? result.classification : "unrecognized",
    missing: MISSING_KINDS.has(result.missing) ? result.missing : null,
    elapsedMs: clampInt(result.elapsedMs),
    polls: clampInt(result.polls),
    // Carried on EVERY classification, unlike the user-facing note which states
    // it only where it changes how the claim should be read. A post-mortem
    // wants the age regardless of what the observation concluded. Sanitized as
    // a DURATION, not merely as a number: a negative age is not evidence.
    baselineAgeMs: nonNegativeInt(result.baselineAgeMs),
    samples: samples.map((s) => ({
      atMs: clampInt(s?.atMs),
      read: READ_KINDS.has(s?.read) ? s.read : "unrecognized",
    })),
  };
}

// One line, prefixed so it can be grepped out of a session's stderr.
export const SUBMIT_DIAGNOSTIC_PREFIX = "[submit-transition]";
export function formatSubmitTransitionDiagnostic(result) {
  const record = submitTransitionDiagnostic(result);
  return record ? `${SUBMIT_DIAGNOSTIC_PREFIX} ${JSON.stringify(record)}` : "";
}

// EVERY outcome ends by requiring a fresh read before any pre-submit ref is
// trusted. Describing uncertainty without saying what to do about it is what
// let the model act on refs a re-render had already staled — the defect this
// whole observation exists to catch. "Unchanged" and "unobservable" are exactly
// the cases where the refs are least trustworthy, so they need this most.
const REFRESH_INSTRUCTION = "Do ONE broad read_page before trusting or acting on any previously listed ref.";

// One line, always. URIs are page-influenced (a site can push arbitrary history
// entries), so both sides go through sanitizeInline and the note is never
// marker-shaped — it must not be readable as a trusted marker line by the fast
// agent's parsers.
export function formatSubmitTransitionNote(result) {
  if (!result) return "";
  const from = sanitizeInline(result.baselineUri || "");
  const to = sanitizeInline(result.observedUri || "");
  // What was ACTUALLY spent, not the budget. Both numbers come from the
  // observation itself; neither is a claim about the page. Older callers that
  // built a result without them get no spend clause rather than a fabricated 0.
  const reads = Number.isFinite(result.polls) ? result.polls : null;
  const ms = Number.isFinite(result.elapsedMs) ? Math.round(result.elapsedMs) : null;
  const spent = reads === null || ms === null ? "" : ` (watched ${ms}ms across ${reads} read${reads === 1 ? "" : "s"})`;
  if (result.classification === "navigated") {
    // AGE IS STATED HERE AND NOWHERE ELSE, and the condition is the
    // classification rather than a millisecond cutoff nobody could justify.
    // This is the one outcome where age changes how the claim should be read:
    // the longer the baseline was held, the weaker the implied attribution of
    // the URL change to this keypress. "Unchanged" is unaffected — a URL equal
    // to an old baseline is still equal now — and "unobservable" compared
    // nothing at all.
    // Same duration sanitizer as the diagnostic, so the two boundaries cannot
    // disagree. `!== null` rather than a truthiness check, because 0 is a valid
    // duration and must still be stated.
    const ageMs = nonNegativeInt(result.baselineAgeMs);
    const age = ageMs !== null
      ? ` The baseline was captured ${ageMs}ms before this keypress, so a change that old may predate the submit.`
      : "";
    return ` [submit transition — NAVIGATED: the page URL changed from ${from} to ${to}${spent}, so element refs read before the submit are now STALE.${age} ${REFRESH_INSTRUCTION} For a known destination, read_after_navigation with that URL does the same job.]`;
  }
  if (result.classification === "unchanged") {
    return ` [submit transition — UNCHANGED: the page URL is still ${from}${spent}. Either a transition is still in flight or the page updated in place. This is NOT evidence the submit succeeded, and NOT evidence it failed. ${REFRESH_INSTRUCTION}]`;
  }
  if (result.missing === "baseline") {
    return ` [submit transition — UNOBSERVABLE: no pre-submit page URL was captured to compare against, so the page was never read after the keypress and there is no transition evidence either way. ${REFRESH_INSTRUCTION}]`;
  }
  return ` [submit transition — UNOBSERVABLE: the page URL could not be read after the keypress${spent}, so there is no transition evidence either way. ${REFRESH_INSTRUCTION}]`;
}
