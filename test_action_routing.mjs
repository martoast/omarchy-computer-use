#!/usr/bin/env node
// Pure negative/positive-path tests for classifyActivation + the
// pointer-permission invariant (gh issue #4 review). No browser.
import { classifyActivation, activationAllowsPointer, classifyCheckable, classifyToggle, toggleAllowsPointer, checkableAllowsPointer } from "./action_routing.js";

let pass = 0, fail = 0;
function check(label, got, want) { const ok = got === want; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got=${got} want=${want}`}`); ok ? pass++ : fail++; }

// kind routing
check("invoked+do_action true -> invoked", classifyActivation({ invoked: true, do_action_returned: true }).kind, "invoked");
check("invoked+do_action FALSE -> error", classifyActivation({ invoked: true, do_action_returned: false }).kind, "error");
check("  ...reason do_action_false", classifyActivation({ invoked: true, do_action_returned: false }).reason, "do_action_false");
check("ambiguous_target -> error", classifyActivation({ ambiguous_target: true, match_count: 3 }).kind, "error");
check("ambiguous_action -> error", classifyActivation({ ambiguous_action: true, actions: [] }).kind, "error");
check("bridge error -> error", classifyActivation({ error: "do_action failed: boom" }).kind, "error");
// coordinate_fallback requires POSITIVE uniqueness: no_activation + match_count===1
check("no_activation + match_count 1 -> coordinate_fallback", classifyActivation({ no_activation_action: true, match_count: 1 }).kind, "coordinate_fallback");
check("no_activation MISSING count -> error (fail closed)", classifyActivation({ no_activation_action: true }).kind, "error");
check("  ...reason no_activation_unverified_identity", classifyActivation({ no_activation_action: true }).reason, "no_activation_unverified_identity");
check("no_activation count>1 -> error (fail closed)", classifyActivation({ no_activation_action: true, match_count: 2 }).kind, "error");
check("no_activation + error flag -> error (error wins)", classifyActivation({ no_activation_action: true, match_count: 1, error: "x" }).kind, "error");
check("no_activation + ambiguous_target -> error (ambiguity wins)", classifyActivation({ no_activation_action: true, match_count: 1, ambiguous_target: true }).kind, "error");
check("unrecognized shape -> error", classifyActivation({ something: "weird" }).kind, "error");
check("  ...reason unrecognized", classifyActivation({ something: "weird" }).reason, "unrecognized");
check("null -> error", classifyActivation(null).kind, "error");

// THE invariant: pointer allowed ONLY for a UNIQUE-proven coordinate_fallback
check("pointer allowed for no_activation + count 1", activationAllowsPointer(classifyActivation({ no_activation_action: true, match_count: 1 })), true);
check("pointer NOT allowed for no_activation missing count", activationAllowsPointer(classifyActivation({ no_activation_action: true })), false);
check("pointer NOT allowed for no_activation count>1", activationAllowsPointer(classifyActivation({ no_activation_action: true, match_count: 2 })), false);
check("pointer NOT allowed for no_activation + error", activationAllowsPointer(classifyActivation({ no_activation_action: true, match_count: 1, error: "x" })), false);
check("pointer NOT allowed for no_activation + ambiguous", activationAllowsPointer(classifyActivation({ no_activation_action: true, match_count: 1, ambiguous_action: true })), false);
check("pointer NOT allowed for invoked", activationAllowsPointer(classifyActivation({ invoked: true, do_action_returned: true })), false);
check("pointer NOT allowed for do_action false", activationAllowsPointer(classifyActivation({ invoked: true, do_action_returned: false })), false);
check("pointer NOT allowed for ambiguous_target", activationAllowsPointer(classifyActivation({ ambiguous_target: true })), false);
check("pointer NOT allowed for ambiguous_action", activationAllowsPointer(classifyActivation({ ambiguous_action: true })), false);
check("pointer NOT allowed for bridge error", activationAllowsPointer(classifyActivation({ error: "x" })), false);
check("pointer NOT allowed for unrecognized", activationAllowsPointer(classifyActivation({ weird: 1 })), false);
check("pointer NOT allowed for null", activationAllowsPointer(classifyActivation(null)), false);

// --- classifyCheckable (issue #6) -------------------------------------------
// The bridge decides the verdict; this only routes its shape. do_action's
// boolean is deliberately NOT consulted anywhere below.
const inv = (o) => ({ invoked: true, invoked_name: "check", do_action_returned: true, ...o });
check("invoked + verified -> verified", classifyCheckable(inv({ verified: true })).kind, "verified");
check("invoked + NOT verified -> error", classifyCheckable(inv({ verified: false, failure: "state_unchanged" })).kind, "error");
check("  ...reason failed_unverified", classifyCheckable(inv({ verified: false, failure: "state_unchanged" })).reason, "failed_unverified");
check("do_action true but state unchanged -> STILL error (bool is not proof)", classifyCheckable(inv({ do_action_returned: true, verified: false, failure: "state_unchanged" })).kind, "error");
check("do_action FALSE but state verified -> verified (bool is not the verdict)", classifyCheckable(inv({ do_action_returned: false, verified: true })).kind, "verified");
check("post state unavailable -> error", classifyCheckable(inv({ verified: false, failure: "post_state_unavailable" })).reason, "failed_unverified");
check("peer still checked -> error", classifyCheckable(inv({ verified: false, failure: "peer_still_checked" })).reason, "failed_unverified");
check("peer unreadable -> error", classifyCheckable(inv({ verified: false, failure: "peer_unreadable" })).reason, "failed_unverified");
check("invoked with NO verdict field -> error (never assume success)", classifyCheckable(inv({})).kind, "error");
check("already_satisfied + verified -> already_satisfied", classifyCheckable({ already_satisfied: true, verified: true, invoked: false }).kind, "already_satisfied");
check("already_satisfied WITHOUT verified -> not a pass", classifyCheckable({ already_satisfied: true, invoked: false }).kind, "error");
check("stale_ref -> error", classifyCheckable({ stale_ref: true, status: "stale_none" }).reason, "stale_ref");
check("ambiguous_target -> error", classifyCheckable({ ambiguous_target: true, match_count: 3 }).reason, "ambiguous_target");
check("ambiguous_action -> error", classifyCheckable({ ambiguous_action: true }).reason, "ambiguous_action");
check("no_activation_action -> error (no coordinate fallback for checkables)", classifyCheckable({ no_activation_action: true }).reason, "no_activation_action");
check("ambiguous_group -> error (two options already selected)", classifyCheckable({ ambiguous_group: true, checked_peer_count: 2 }).reason, "ambiguous_group");
check("ambiguous_group is refused BEFORE invoking (no invoked flag to trust)", classifyCheckable({ ambiguous_group: true, invoked: true, verified: true }).reason, "ambiguous_group");
check("unsupported_role -> error", classifyCheckable({ unsupported_role: true }).reason, "unsupported_role");
check("bridge error -> error", classifyCheckable({ error: "boom" }).reason, "checkable_error");
check("unrecognized -> error", classifyCheckable({ weird: 1 }).reason, "unrecognized");
check("null -> error", classifyCheckable(null).reason, "no-result");

// THE invariant for checkables: pointer is NEVER permitted, for ANY outcome.
for (const [label, res] of [
  ["verified", inv({ verified: true })],
  ["failed_unverified", inv({ verified: false, failure: "state_unchanged" })],
  ["already_satisfied", { already_satisfied: true, verified: true }],
  ["no_activation_action", { no_activation_action: true, match_count: 1 }],
  ["ambiguous_group", { ambiguous_group: true, checked_peer_count: 2 }],
  ["stale_ref", { stale_ref: true }],
  ["null", null],
]) {
  check(`pointer NEVER allowed for checkable ${label}`, checkableAllowsPointer(classifyCheckable(res)), false);
}

console.log("--- classifyToggle: ACTION ACCOUNTING OUTRANKS EVERY NOMINAL FLAG ---");
const T = (res) => classifyToggle(res).kind;
const TR = (res) => classifyToggle(res).reason;
const TC = (res) => classifyToggle(res).invocationCount;

// Success requires the count to say exactly one call was issued. A result that
// calls itself verified while reporting 0 or 2 calls does not describe anything
// we understand, so it cannot be a success.
check("invoked+verified with exactly 1 call -> verified",
  T({ invoked: true, verified: true, invocation_count: 1 }), "verified");
check("invoked+verified with 0 calls -> NOT success",
  T({ invoked: true, verified: true, invocation_count: 0 }), "error");
check("  ...reported as an unexpected count", TR({ invoked: true, verified: true, invocation_count: 0 }), "invocation_count_unexpected");
check("invoked+verified with 2 calls -> NOT success",
  TR({ invoked: true, verified: true, invocation_count: 2 }), "invocation_count_unexpected");
check("invoked+verified with a MISSING count -> NOT success",
  TR({ invoked: true, verified: true }), "invocation_count_unusable");
check("invoked but NOT verified (with a valid count) -> failed_unverified",
  TR({ invoked: true, verified: false, invocation_count: 1, failure: "state_unchanged" }), "failed_unverified");
// do_action's boolean is evidence, never proof, and is not consulted.
check("invoked + do_action true but unverified is still an error",
  T({ invoked: true, do_action_returned: true, verified: false, invocation_count: 1 }), "error");

// THE CASE THAT MATTERS MOST: a nominal refusal that ALSO issued a call. The
// call may have partially applied, so calling this a refusal would be false.
check("a refusal reporting 0 calls is an ordinary refusal",
  TR({ ambiguous_action: true, invocation_count: 0 }), "ambiguous_action");
check("a refusal reporting 1 ISSUED call is NOT a refusal",
  TR({ ambiguous_action: true, invocation_count: 1 }), "refusal_after_invocation");
check("  ...and the issued call is still counted", TC({ ambiguous_action: true, invocation_count: 1 }), 1);
check("a state/action contradiction that issued a call is also not a refusal",
  TR({ state_action_contradiction: true, invocation_count: 1 }), "refusal_after_invocation");
check("a stale result that issued a call is also not a refusal",
  TR({ stale_ref: true, status: "stale_none", invocation_count: 2 }), "refusal_after_invocation");

// A malformed count must never reach the stats tally — a negative one would
// silently DECREMENT the record of how many actions were performed.
check("a NEGATIVE count is unusable", TR({ invoked: true, verified: true, invocation_count: -1 }), "invocation_count_unusable");
check("  ...and contributes NOTHING to the tally", TC({ invoked: true, verified: true, invocation_count: -1 }), null);
check("a fractional count is unusable", TR({ invoked: true, verified: true, invocation_count: 1.5 }), "invocation_count_unusable");
check("a string count is unusable", TR({ ambiguous_action: true, invocation_count: "1" }), "invocation_count_unusable");
check("a null count is unusable", TR({ ambiguous_action: true, invocation_count: null }), "invocation_count_unusable");
check("a null result is unusable", TR(null), "no-result");
check("  ...and contributes nothing to the tally", TC(null), null);
// Every count that DOES reach the tally is a non-negative integer.
const counted = [{ invoked: true, verified: true, invocation_count: 1 }, { ambiguous_action: true, invocation_count: 0 },
  { ambiguous_action: true, invocation_count: 3 }, { invoked: true, verified: false, invocation_count: 1 }];
check("every usable count is a non-negative integer",
  counted.every((r) => { const c = TC(r); return Number.isInteger(c) && c >= 0; }), true);
const unusable = [null, {}, { invocation_count: -1 }, { invocation_count: 1.5 }, { invocation_count: "1" }];
check("every unusable count is null, so nothing is ever added",
  unusable.every((r) => TC(r) === null), true);

console.log("--- classifyToggle: refusal shapes (all with a zero count) ---");
check("an unreadable pressed state is its own refusal", TR({ unreadable_state: true, invocation_count: 0 }), "unreadable_state");
check("a state/action contradiction is its own refusal", TR({ state_action_contradiction: true, invocation_count: 0 }), "state_action_contradiction");
check("no usable action refuses", TR({ no_activation_action: true, invocation_count: 0 }), "no_activation_action");
check("a stale ref refuses", TR({ stale_ref: true, status: "stale_none", invocation_count: 0 }), "stale_ref");
check("an ambiguous target refuses", TR({ ambiguous_target: true, match_count: 3, invocation_count: 0 }), "ambiguous_target");
check("a wrong role refuses", TR({ unsupported_role: true, invocation_count: 0 }), "unsupported_role");
check("a bridge error refuses", TR({ error: "boom", invocation_count: 0 }), "toggle_error");
check("an unrecognized shape refuses", TR({ something: true, invocation_count: 0 }), "unrecognized");
// A toggle has no group semantics, so it must never reach a group outcome.
check("a group flag is NOT honoured on this path (toggles declare no group)",
  TR({ ambiguous_group: true, invocation_count: 0 }), "unrecognized");

// The invariant that matters most: nothing here can ever grant pointer input.
check("NO toggle outcome permits pointer input", toggleAllowsPointer(), false);
const everyToggleShape = [null, {}, { error: "x" }, { stale_ref: true }, { ambiguous_target: true },
  { unsupported_role: true }, { unreadable_state: true }, { state_action_contradiction: true },
  { ambiguous_action: true }, { no_activation_action: true }, { invoked: true, verified: false },
  { invoked: true, verified: true }, { ambiguous_action: true, invocation_count: 1 }];
check("...for any result shape whatsoever", everyToggleShape.every(() => toggleAllowsPointer() === false), true);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);