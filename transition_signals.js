// Pure comparison of a control's OWN state before and after an action —
// extracted so the evidence rule is unit-testable without a browser, and so the
// set of states that count as a transition cannot be silently narrowed.
//
// Why this exists as its own module: `pressed` was missing from that set, and
// nothing failed. A toggle button is how variant pickers (colour, size, width)
// say "this one is chosen", so its selection produced NO detectable delta and
// every such click reported "no transition observed" regardless of what really
// happened. The omission was invisible precisely because the comparison lived
// inline in a polling loop with no test that pinned which keys it read.

/** The states whose change counts as evidence the action did something.
 *
 * `focused` is deliberately ABSENT: a control gaining focus from its own
 * activation is what pressing anything does, so it proves nothing. Focus moving
 * to a DIFFERENT node is a separate, page-level signal.
 *
 * `pressed` and `checked` are BOTH here and are independent — MEASURED: an
 * aria-pressed toggle button sets PRESSED with CHECKED clear, so folding them
 * together would report a press as a check and, worse, let a control that
 * exposes only one of them look unchanged. */
export const TARGET_STATE_KEYS = [
  "showing", "enabled", "checked", "pressed", "selected", "expanded", "editable",
];

/** Exact state deltas on the control that was acted upon.
 *
 * Returns [] — never a transition — when either observation failed to read the
 * control. "We could not see it" and "it did not change" are different facts,
 * and only the second is evidence; manufacturing a delta from an unreadable
 * side would let a stale or resolved-away target look like a successful action.
 *
 * `pre`/`post` are {avail, states} where avail === "ok" means the control was
 * resolved and read. */
// REMOVAL OF THE EXACT TARGET, as a separate kind of evidence from a state
// delta. diffTargetStates above deliberately reports nothing when either side
// is unreadable, because "we could not see it" is not "it did not change" — and
// that stays true. But there is one unreadable shape that is not blindness at
// all: the bridge's `stale_none`, which means the document generation gate
// PASSED (the page did not navigate) and the object path resolved to no node
// inside that surviving document. That is a positive observation — the exact
// control we activated is gone — and it is the only stale_* status that is.
//
// Measured cost of not having this (REI sign-in nudge): a Close button that
// genuinely vanished produced no signal at all, so the click burned the full
// 2s poll budget, reported UNVERIFIED, and cost a second turn to re-verify.
export const TARGET_REMOVED_STATUS = "stale:stale_none";
export const TARGET_REMOVAL_CONSECUTIVE_REQUIRED = 2;
// The ONLY claim this evidence supports. Not "the dialog closed" and not "the
// action succeeded": an overlay can outlive its close button, and a control can
// be removed by something other than the action we invoked.
export const TARGET_REMOVED_SIGNAL = "the exact control was removed from the surviving page document";

/** Is ONE post-activation observation an exact-target removal?
 *
 * Every clause is required and each excludes a different way of being wrong:
 *   preAvail "ok"        — it was readable BEFORE, so absence is a change
 *                          rather than blindness we already had.
 *   hadDocGen            — an in-document target, so the generation gate is
 *                          meaningful; a chrome node is out of scope.
 *   urlObservedUnchanged — BOTH URL readings exist and are equal. A navigation
 *                          removes everything and proves nothing about the
 *                          activation (and reports itself separately), and two
 *                          UNREADABLE URLs are not evidence of staying put.
 *   postAvail exactly    — stale_doc means the page navigated, stale_mismatch /
 *   stale:stale_none       stale_ambiguous / stale_noident mean the probe could
 *                          not establish identity, and "missing" /
 *                          "identity-changed" / "error" are not removals of a
 *                          known-live node. None of them count. */
export function isTargetRemovalObservation({ preAvail, postAvail, urlObservedUnchanged, hadDocGen } = {}) {
  if (preAvail !== "ok") return false;
  if (hadDocGen !== true) return false;
  // POSITIVE and factual, not the negation of "changed". `!==` between two
  // unreadable URLs is false, which would have made "we could not read the URL
  // on either side" indistinguishable from "the URL was observed to be the
  // same" — failing OPEN on exactly the blind case this gate exists to exclude.
  if (urlObservedUnchanged !== true) return false;
  return postAvail === TARGET_REMOVED_STATUS;
}

/** A usable observation: a real, non-blank string. Anything else — null,
 * undefined, "", whitespace, a non-string — is an ABSENT reading, never a
 * value to compare. */
const usable = (value) => typeof value === "string" && value.trim() !== "";

/** Was the page URL OBSERVED to be the same on both sides? Requires both
 * readings to exist and to be equal. Two unreadable URLs are not evidence of
 * staying put, and a changed usable URL stays what it always was — ordinary
 * navigation evidence, reported by the caller's own url signal. */
export function urlObservedUnchanged(preUrl, postUrl) {
  return usable(preUrl) && usable(postUrl) && preUrl === postUrl;
}

/** Was the page URL OBSERVED to change? Also requires BOTH readings to exist:
 * a URL that could not be read on one side and was read on the other is a
 * failed READ, not a navigation, and reporting it as `url changed` invents a
 * transition out of a gap in observation. The two helpers are deliberately not
 * each other's negation — when either side is unreadable BOTH return false, and
 * that third state is the honest one. */
export function urlObservedChanged(preUrl, postUrl) {
  return usable(preUrl) && usable(postUrl) && preUrl !== postUrl;
}

/** A usable dialog COUNT: a real non-negative integer. `null` is what an
 * unreadable dialog snapshot leaves behind, and comparing it with `!==` against
 * a real 0 manufactured `dialogs null->0` out of a failed read. Negative and
 * fractional values are not counts either and fail closed. */
const usableCount = (value) => Number.isInteger(value) && value >= 0;

export function dialogsObservedChanged(preCount, postCount) {
  return usableCount(preCount) && usableCount(postCount) && preCount !== postCount;
}

/** A usable FOCUS observation. Note "none" is a perfectly good reading — it
 * means the tree was read and nothing held focus — whereas null/undefined means
 * the read itself failed. Treating those as interchangeable turned a failed
 * probe into `focus -> none`, a transition that never happened. */
export function focusObservedChanged(preFocus, postFocus) {
  return usable(preFocus) && usable(postFocus) && preFocus !== postFocus;
}

/** Does the target carry a usable document-generation identity? An empty or
 * blank doc_gen is not an in-document identity, so the generation gate that
 * makes stale_none meaningful would not actually have applied. */
export function hasUsableDocGen(docGen) {
  return usable(docGen);
}

/** Requires the removal to PERSIST across consecutive fresh probes, so a
 * mid-rerender blink (removed on one poll, back on the next) can never qualify.
 * Any other status resets the streak to zero rather than merely pausing it. */
export class TargetRemovalTracker {
  constructor(required = TARGET_REMOVAL_CONSECUTIVE_REQUIRED) {
    this.required = required;
    this.streak = 0;
  }
  observe(observation) {
    if (!isTargetRemovalObservation(observation)) {
      this.streak = 0;
      return false;
    }
    this.streak += 1;
    return this.streak >= this.required;
  }
}

export function diffTargetStates(pre, post) {
  if (!pre || !post) return [];
  if (pre.avail !== "ok" || post.avail !== "ok") return [];
  if (!pre.states || !post.states) return [];
  const out = [];
  for (const key of TARGET_STATE_KEYS) {
    if (pre.states[key] !== post.states[key]) {
      out.push(`${key} ${pre.states[key]}->${post.states[key]}`);
    }
  }
  return out;
}
