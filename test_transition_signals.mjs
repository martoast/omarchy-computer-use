#!/usr/bin/env node
// Pure tests for what counts as evidence that an action changed the control it
// was performed on (no browser).
//
// These exist because the failure they guard against was SILENT: `pressed` was
// missing from the compared states, so a toggle button — how variant pickers
// say "this one is chosen" — could flip with no detectable delta, and every
// such click reported "no transition observed" no matter what really happened.
// Nothing failed, because nothing pinned which states were read. Each key is
// asserted individually here, so removing one breaks a test by name.
import { TARGET_STATE_KEYS, diffTargetStates, isTargetRemovalObservation, TargetRemovalTracker,
         TARGET_REMOVED_STATUS, TARGET_REMOVAL_CONSECUTIVE_REQUIRED, TARGET_REMOVED_SIGNAL,
         urlObservedUnchanged, urlObservedChanged, dialogsObservedChanged, focusObservedChanged,
         hasUsableDocGen } from "./transition_signals.js";

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
// Every state false unless named, so each case changes exactly one thing.
const S = (over = {}) => ({ showing: true, enabled: true, checked: false, pressed: false,
                            selected: false, expanded: false, editable: false, ...over });
const ok = (states) => ({ avail: "ok", states });
const d = (pre, post) => diffTargetStates(ok(pre), ok(post));

console.log("--- pressed, the state this module exists for ---");
check("pressed false -> true is an exact transition",
  d(S(), S({ pressed: true })), ["pressed false->true"]);
check("pressed true -> false is an exact transition",
  d(S({ pressed: true }), S()), ["pressed true->false"]);
check("pressed unchanged (false) yields NO transition", d(S(), S()), []);
check("pressed unchanged (true) yields NO transition",
  d(S({ pressed: true }), S({ pressed: true })), []);

console.log("--- pressed and checked are INDEPENDENT ---");
// A toggle button sets PRESSED with CHECKED clear (measured). Folding them
// together would report a press as a check, and would hide a change in either.
check("a press does not report itself as a check",
  d(S(), S({ pressed: true })), ["pressed false->true"]);
check("a check does not report itself as a press",
  d(S(), S({ checked: true })), ["checked false->true"]);
check("both changing reports both, in key order",
  d(S(), S({ checked: true, pressed: true })), ["checked false->true", "pressed false->true"]);
check("checked changing while pressed holds reports only checked",
  d(S({ pressed: true }), S({ pressed: true, checked: true })), ["checked false->true"]);

console.log("--- every other compared state, pinned individually ---");
for (const key of ["showing", "enabled", "selected", "expanded", "editable"]) {
  const before = S({ [key]: false });
  check(`${key} is compared`, d(before, S({ [key]: true })), [`${key} false->true`]);
}
// The deliberate exclusion: a control gaining focus from its own activation is
// what pressing anything does, so it is not evidence of anything.
check("`focused` is NOT compared — self-focus proves nothing",
  d({ ...S(), focused: false }, { ...S(), focused: true }), []);
check("TARGET_STATE_KEYS does not contain focused", TARGET_STATE_KEYS.includes("focused"), false);
check("TARGET_STATE_KEYS contains pressed", TARGET_STATE_KEYS.includes("pressed"), true);
check("TARGET_STATE_KEYS contains checked", TARGET_STATE_KEYS.includes("checked"), true);

console.log("--- an unreadable observation can NEVER manufacture a transition ---");
// "We could not see the control" and "it did not change" are different facts.
// Only the second is evidence. A vanished or stale target must not look like a
// successful action.
check("a stale PRE observation yields nothing",
  diffTargetStates({ avail: "stale:stale_none", states: S() }, ok(S({ pressed: true }))), []);
check("a stale POST observation yields nothing",
  diffTargetStates(ok(S()), { avail: "stale:stale_doc", states: S({ pressed: true }) }), []);
check("both stale yields nothing",
  diffTargetStates({ avail: "stale:x", states: S() }, { avail: "stale:y", states: S({ pressed: true }) }), []);
check("missing PRE states yield nothing", diffTargetStates(ok(null), ok(S({ pressed: true }))), []);
check("missing POST states yield nothing", diffTargetStates(ok(S()), ok(null)), []);
check("a null observation yields nothing", diffTargetStates(null, ok(S({ pressed: true }))), []);
check("an undefined observation yields nothing", diffTargetStates(ok(S()), undefined), []);
// avail must be exactly "ok" — anything unrecognized fails closed.
check("an unrecognized avail value fails closed",
  diffTargetStates({ avail: "maybe", states: S() }, ok(S({ pressed: true }))), []);

console.log("--- shape of the reported delta ---");
check("a delta names the key and both values",
  d(S(), S({ expanded: true })), ["expanded false->true"]);
check("an absent key on one side is still reported rather than hidden",
  diffTargetStates(ok({ pressed: undefined }), ok({ pressed: true })), ["pressed undefined->true"]);

// --- exact-target REMOVAL as evidence ---------------------------------------
// Measured motivation (REI sign-in nudge): a Close button that genuinely
// vanished produced no signal at all, so the click burned the full 2s poll
// budget, reported UNVERIFIED, and cost a second turn to re-verify. stale_none
// is the one unreadable status that is a positive observation rather than
// blindness: the generation gate passed, so the page did NOT navigate, and the
// object path resolved to no node inside that surviving document.
const removal = (over = {}) => isTargetRemovalObservation({ preAvail: "ok", postAvail: TARGET_REMOVED_STATUS, urlObservedUnchanged: true, hadDocGen: true, ...over });

check("ok -> stale_none, same url, in-document => removal", removal(), true);

// Every exclusion, one case each.
check("stale_doc (the page navigated) => NOT removal", removal({ postAvail: "stale:stale_doc" }), false);
check("stale_mismatch => NOT removal", removal({ postAvail: "stale:stale_mismatch" }), false);
check("stale_ambiguous => NOT removal", removal({ postAvail: "stale:stale_ambiguous" }), false);
check("stale_noident => NOT removal", removal({ postAvail: "stale:stale_noident" }), false);
check("missing => NOT removal", removal({ postAvail: "missing" }), false);
check("identity-changed => NOT removal", removal({ postAvail: "identity-changed" }), false);
check("error => NOT removal", removal({ postAvail: "error" }), false);
check("still ok => NOT removal", removal({ postAvail: "ok" }), false);
check("blind BEFORE the click => NOT removal", removal({ preAvail: "missing" }), false);
check("pre stale => NOT removal", removal({ preAvail: "stale:stale_none" }), false);
check("url changed => NOT removal (navigation removes everything)", removal({ urlObservedUnchanged: false }), false);
check("url unknown => NOT removal (fails closed)", removal({ urlObservedUnchanged: undefined }), false);

// The URL clause is POSITIVE on purpose. Comparing two unreadable URLs with
// `!==` yields false, which would have made "we could not read it on either
// side" look identical to "it was observed to be the same" — failing open on
// exactly the blind case this gate exists to exclude.
check("both URLs readable and equal => observed unchanged", urlObservedUnchanged("https://a.test/x", "https://a.test/x"), true);
check("both URLs null => NOT observed unchanged", urlObservedUnchanged(null, null), false);
check("pre URL null => NOT observed unchanged", urlObservedUnchanged(null, "https://a.test/x"), false);
check("post URL null => NOT observed unchanged", urlObservedUnchanged("https://a.test/x", null), false);
check("both URLs empty => NOT observed unchanged", urlObservedUnchanged("", ""), false);
check("both URLs whitespace => NOT observed unchanged", urlObservedUnchanged("   ", "   "), false);
check("URLs differ => NOT observed unchanged (ordinary navigation evidence)", urlObservedUnchanged("https://a.test/x", "https://a.test/y"), false);
check("no arguments => NOT observed unchanged", urlObservedUnchanged(), false);

// urlObservedChanged is NOT the negation of urlObservedUnchanged. When either
// side is unreadable BOTH are false, and that third state is the honest one: a
// URL read on one side and not the other is a failed READ, not a navigation.
check("both readable and differing => observed changed", urlObservedChanged("https://a.test/x", "https://a.test/y"), true);
check("both readable and equal => NOT observed changed", urlObservedChanged("https://a.test/x", "https://a.test/x"), false);
check("both null => NOT observed changed (a failed read is not navigation)", urlObservedChanged(null, null), false);
check("pre null, post readable => NOT observed changed", urlObservedChanged(null, "https://a.test/x"), false);
check("pre readable, post null => NOT observed changed", urlObservedChanged("https://a.test/x", null), false);
check("empty vs readable => NOT observed changed", urlObservedChanged("", "https://a.test/x"), false);
check("whitespace vs readable => NOT observed changed", urlObservedChanged("   ", "https://a.test/x"), false);
check("no arguments => NOT observed changed", urlObservedChanged(), false);
for (const [pre, post] of [[null, null], [null, "https://a.test/x"], ["https://a.test/x", null], ["", ""], ["   ", "https://a.test/x"]]) {
  check(`unreadable pairing ${JSON.stringify([pre, post])} is NEITHER changed nor unchanged`,
    urlObservedChanged(pre, post) || urlObservedUnchanged(pre, post), false);
}

// --- dialog counts: an unreadable snapshot is not a dialog appearing ---------
// captureSignals leaves dialogs null when the snapshot fails, and `null !== 0`
// reported that failed read as `dialogs null->0`.
check("0 -> 1 is an observed change", dialogsObservedChanged(0, 1), true);
check("2 -> 0 is an observed change", dialogsObservedChanged(2, 0), true);
check("equal counts are no change", dialogsObservedChanged(1, 1), false);
check("null pre => NOT observed changed (failed read)", dialogsObservedChanged(null, 0), false);
check("null post => NOT observed changed (failed read)", dialogsObservedChanged(0, null), false);
check("both null => NOT observed changed", dialogsObservedChanged(null, null), false);
check("undefined pre => NOT observed changed", dialogsObservedChanged(undefined, 1), false);
check("negative count fails closed", dialogsObservedChanged(-1, 0), false);
check("fractional count fails closed", dialogsObservedChanged(0.5, 1), false);
check("NaN count fails closed", dialogsObservedChanged(NaN, 1), false);
check("Infinity count fails closed", dialogsObservedChanged(Infinity, 1), false);
check("a numeric STRING is not a count", dialogsObservedChanged("0", 1), false);
check("no arguments => NOT observed changed", dialogsObservedChanged(), false);

// --- focus: "none" is a reading, null is a failed probe ----------------------
check("focus moving between two readings is an observed change", focusObservedChanged("none", "entry|Search"), true);
check("focus none -> none is no change", focusObservedChanged("none", "none"), false);
check("same node is no change", focusObservedChanged("button|Close", "button|Close"), false);
check("null pre vs none => NOT observed changed (failed probe)", focusObservedChanged(null, "none"), false);
check("none vs null post => NOT observed changed (failed probe)", focusObservedChanged("none", null), false);
check("both null => NOT observed changed", focusObservedChanged(null, null), false);
check("empty string is not a reading", focusObservedChanged("", "none"), false);
check("whitespace is not a reading", focusObservedChanged("   ", "none"), false);
check("no arguments => NOT observed changed", focusObservedChanged(), false);

check("a real doc_gen is usable", hasUsableDocGen("/doc/1"), true);
check("empty doc_gen is NOT usable", hasUsableDocGen(""), false);
check("whitespace doc_gen is NOT usable", hasUsableDocGen("   "), false);
check("null doc_gen is NOT usable", hasUsableDocGen(null), false);
check("undefined doc_gen is NOT usable", hasUsableDocGen(undefined), false);
check("a non-string doc_gen is NOT usable", hasUsableDocGen(0), false);
check("no doc_gen (chrome node) => NOT removal", removal({ hadDocGen: false }), false);
check("no arguments => NOT removal", isTargetRemovalObservation(), false);

// PERSISTENCE: one observation is never enough; a blink must reset the streak.
{
  const t = new TargetRemovalTracker();
  check("first removal observation alone does not qualify", t.observe({ preAvail: "ok", postAvail: TARGET_REMOVED_STATUS, urlObservedUnchanged: true, hadDocGen: true }), false);
  check("second CONSECUTIVE removal qualifies", t.observe({ preAvail: "ok", postAvail: TARGET_REMOVED_STATUS, urlObservedUnchanged: true, hadDocGen: true }), true);
}
{
  const t = new TargetRemovalTracker();
  t.observe({ preAvail: "ok", postAvail: TARGET_REMOVED_STATUS, urlObservedUnchanged: true, hadDocGen: true });
  // The control came back mid-rerender: the streak resets, it does not pause.
  check("a blink resets the streak", t.observe({ preAvail: "ok", postAvail: "ok", urlObservedUnchanged: true, hadDocGen: true }), false);
  check("  ...so the next removal is only the FIRST again", t.observe({ preAvail: "ok", postAvail: TARGET_REMOVED_STATUS, urlObservedUnchanged: true, hadDocGen: true }), false);
  check("  ...and only the one after that qualifies", t.observe({ preAvail: "ok", postAvail: TARGET_REMOVED_STATUS, urlObservedUnchanged: true, hadDocGen: true }), true);
}
check("the threshold is 2", TARGET_REMOVAL_CONSECUTIVE_REQUIRED, 2);
// The claim is bounded: removal of the exact control, nothing about the overlay.
check("signal names only removal", TARGET_REMOVED_SIGNAL, "the exact control was removed from the surviving page document");
check("signal never claims closure", /clos|dismiss|succeed/i.test(TARGET_REMOVED_SIGNAL), false);
// Removal is NOT a state delta: diffTargetStates must still report nothing, so
// this evidence can never leak into the toggle/checkable paths that use it.
check("diffTargetStates still yields no delta for a removed target",
  diffTargetStates({ avail: "ok", states: { showing: true } }, { avail: TARGET_REMOVED_STATUS, states: null }).length, 0);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
