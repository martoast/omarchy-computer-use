// Pure routing of a bridge semantic_activate result to a click_element
// decision — extracted so the safety-critical routing is unit-testable
// without a live browser (gh issue #4 review). The ONLY decision that
// permits any pointer input is "coordinate_fallback"; every other outcome,
// including any unrecognized result shape, must be a no-pointer error.
export function classifyActivation(act) {
  if (!act || typeof act !== "object") return { kind: "error", reason: "no-result" };
  // Error/contradiction FIRST — before any path that could grant pointer
  // input (gh issue #4 review v2). A result carrying an error, or any
  // ambiguity flag, is never a fallback candidate even if it also carries
  // no_activation_action.
  if (act.error) return { kind: "error", reason: "activation_error", detail: act.error };
  if (act.ambiguous_target) return { kind: "error", reason: "ambiguous_target" };
  if (act.ambiguous_action) return { kind: "error", reason: "ambiguous_action" };
  if (act.invoked === true) {
    return act.do_action_returned ? { kind: "invoked" } : { kind: "error", reason: "do_action_false" };
  }
  if (act.no_activation_action) {
    // Coordinate fallback is the ONLY pointer-granting outcome, so it needs
    // POSITIVE uniqueness proof: exactly one matching target and no
    // contradictory flags (already excluded above). Missing/contradictory
    // identity data fails closed to an error, never pointer.
    if (act.match_count === 1) return { kind: "coordinate_fallback" };
    return { kind: "error", reason: "no_activation_unverified_identity" };
  }
  return { kind: "error", reason: "unrecognized" };
}

// The single source of truth for "is pointer input allowed for this result".
export function activationAllowsPointer(cls) {
  return cls.kind === "coordinate_fallback";
}

// Pure routing of a bridge semantic_set_checkable result to a click_element
// decision (issue #6). Like classifyActivation, NO outcome here permits pointer
// input: a checkable control that cannot be set semantically fails closed
// rather than falling back to a coordinate click, which could land on a
// different duplicate and would in any case not be verifiable.
//
// The bridge decides the verdict atomically on the live object; this function
// only routes its shape. `do_action_returned` is deliberately not consulted --
// it is evidence, never proof.
export function classifyCheckable(res) {
  if (!res || typeof res !== "object") return { kind: "error", reason: "no-result" };
  if (res.error) return { kind: "error", reason: "checkable_error", detail: res.error };
  if (res.stale_ref) return { kind: "error", reason: "stale_ref", detail: res.status };
  if (res.ambiguous_target) return { kind: "error", reason: "ambiguous_target" };
  if (res.ambiguous_action) return { kind: "error", reason: "ambiguous_action" };
  if (res.ambiguous_group) return { kind: "error", reason: "ambiguous_group" };
  if (res.unsupported_role) return { kind: "error", reason: "unsupported_role" };
  if (res.no_activation_action) return { kind: "error", reason: "no_activation_action" };
  if (res.already_satisfied === true && res.verified === true) return { kind: "already_satisfied" };
  if (res.invoked === true) {
    // Verified ONLY when the bridge observed the exact node reach the desired
    // state (and, where a peer was captured, observed the peer leave it).
    return res.verified === true
      ? { kind: "verified" }
      : { kind: "error", reason: "failed_unverified", detail: res.failure || "unverified" };
  }
  return { kind: "error", reason: "unrecognized" };
}

// Same single source of truth as activationAllowsPointer: never.
export function checkableAllowsPointer() {
  return false;
}

// Pure routing of a bridge semantic_toggle result (a stateful aria-pressed
// control). Kept SEPARATE from classifyCheckable rather than folded into it:
// a toggle has no peer policy at all, so it must not be able to reach the
// group-related outcomes, and it has two refusal shapes a checkable does not.
//
// ACTION ACCOUNTING COMES FIRST, before any nominal flag. The bridge reports how
// many do_action calls it ISSUED, and that number outranks every self-description
// in the result: a result that calls itself a refusal while reporting an issued
// call is NOT a refusal, and must never be described as "nothing was invoked" —
// the call may have partially applied. Equally, a result that calls itself
// invoked-and-verified while reporting 0 or 2 calls does not describe something
// we understand, so it cannot be a success.
//
// As with the others, NO outcome here permits pointer input. A toggle that
// cannot be set semantically fails closed; there is no coordinate or keyboard
// fallback, because neither could be verified.
export function classifyToggle(res) {
  if (!res || typeof res !== "object") {
    return { kind: "error", reason: "no-result", invocationCount: null };
  }
  // A count is usable ONLY as a non-negative integer. Anything else — missing,
  // fractional, negative, a string — is unusable, and in particular must never
  // reach the stats tally, where a negative would silently DECREMENT the record
  // of how many actions this harness has performed.
  const raw = res.invocation_count;
  const count = Number.isInteger(raw) && raw >= 0 ? raw : null;
  if (count === null) {
    return { kind: "error", reason: "invocation_count_unusable", invocationCount: null };
  }
  const invoked = res.invoked === true;
  if (invoked) {
    if (count !== 1) {
      return { kind: "error", reason: "invocation_count_unexpected", invocationCount: count };
    }
    // Verified ONLY when the bridge observed the exact node reach the desired
    // state. `do_action_returned` is deliberately not consulted.
    return res.verified === true
      ? { kind: "verified", reason: "verified", invocationCount: count }
      : { kind: "error", reason: "failed_unverified", detail: res.failure || "unverified", invocationCount: count };
  }
  // NOT invoked, but calls were issued: evidence outranks the label.
  if (count > 0) {
    return { kind: "error", reason: "refusal_after_invocation", invocationCount: count };
  }
  if (res.error) return { kind: "error", reason: "toggle_error", detail: res.error, invocationCount: 0 };
  if (res.stale_ref) return { kind: "error", reason: "stale_ref", detail: res.status, invocationCount: 0 };
  if (res.ambiguous_target) return { kind: "error", reason: "ambiguous_target", invocationCount: 0 };
  if (res.unsupported_role) return { kind: "error", reason: "unsupported_role", invocationCount: 0 };
  if (res.unreadable_state) return { kind: "error", reason: "unreadable_state", invocationCount: 0 };
  // The control advertises the direction OPPOSITE to its own reported state.
  if (res.state_action_contradiction) return { kind: "error", reason: "state_action_contradiction", invocationCount: 0 };
  if (res.ambiguous_action) return { kind: "error", reason: "ambiguous_action", invocationCount: 0 };
  if (res.no_activation_action) return { kind: "error", reason: "no_activation_action", invocationCount: 0 };
  return { kind: "error", reason: "unrecognized", invocationCount: 0 };
}

// The single source of truth for "is pointer input allowed for a toggle result".
// It is a constant: never.
export function toggleAllowsPointer() {
  return false;
}
