#!/usr/bin/env node
// Pure tests for the dismissal VERDICT (no browser).
//
// Neither "the button reported success" nor "the dialog disappeared" proves the
// page was revealed: a second modal's own text and buttons would otherwise look
// exactly like restored storefront content, and a same-URL reload makes the
// target's disappearance meaningless while changing everything behind it.
import { classifyBridgeResult, classifyDocumentState, classifyTargetState, materiallyIncreased,
         classifyDismissOutcome, DISMISS_REFUSAL_TEXT, classifyEscapeTarget,
         escapeObservationsAgree, classifyEscapeOutcome, ESCAPE_REFUSAL_TEXT,
         documentIdentity } from "./dialog_dismissal.js";

let pass = 0, fail = 0;
const check = (label, got, want) => { const ok = got === want; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`); ok ? pass++ : fail++; };

console.log("--- what did the bridge actually do? (read before any refusal handling) ---");
const B = (res) => classifyBridgeResult(res).kind;
const BC = (res) => classifyBridgeResult(res).invocationCount;
check("invoked with exactly one call -> acted", B({ invoked: true, invocation_count: 1 }), "acted");
check("  ...and the count is mirrored, not recomputed", BC({ invoked: true, invocation_count: 1 }), 1);
check("a refusal with ZERO calls -> refused", B({ refused: true, reason: "not_inside_a_dialog", invocation_count: 0 }), "refused");
check("  ...contributing nothing to the tally", BC({ refused: true, reason: "x", invocation_count: 0 }), 0);
// THE BUG THIS EXISTS FOR: do_action was ISSUED and then raised. It may have
// applied. Calling that "refused / nothing was activated" would be false, and
// dropping it from the tally would hide a real mutation.
check("a refusal that DID issue a call -> partial, NEVER refused",
  B({ refused: true, reason: "do_action_failed: boom", invocation_count: 1 }), "partial");
check("  ...and the issued call still counts toward the tally",
  BC({ refused: true, reason: "do_action_failed: boom", invocation_count: 1 }), 1);
check("invoked but the bridge claims TWO calls -> unusable, not acted",
  B({ invoked: true, invocation_count: 2 }), "unusable");
check("invoked but the bridge claims ZERO calls -> unusable",
  B({ invoked: true, invocation_count: 0 }), "unusable");
check("no count reported at all -> unusable, never refused", B({ refused: true, reason: "x" }), "unusable");
check("  ...and nothing is added to the tally, since nothing is known", BC({ refused: true, reason: "x" }), null);
check("a non-integer count -> unusable", B({ invoked: true, invocation_count: "1" }), "unusable");
check("a negative count -> unusable", B({ invoked: true, invocation_count: -1 }), "unusable");
check("a null bridge result -> unusable", B(null), "unusable");

console.log("--- was the page document replaced under us? (generations, not URLs) ---");
const D = (before, after) => classifyDocumentState(before, after).state;
const DR = (before, after) => classifyDocumentState(before, after).reason;
const docs = (...gens) => gens.map((g) => ({ doc_gen: g, uri: "https://x.test/p" }));
check("the same generation is still present -> same", D("/doc/1", docs("/doc/1")), "same");
// Deliberately REVERSED from an earlier version of this rule: merely finding our
// generation among several is not proof, because a navigation transition shows
// the outgoing and incoming documents together.
check("found among several documents -> unknown, not same", D("/doc/1", docs("/doc/9", "/doc/1")), "unknown");
// THE CASE URL COMPARISON CANNOT SEE: a reload keeps the URL identical and
// replaces the document node, so only the generation reveals it.
check("a same-URL RELOAD replaced the generation -> changed", D("/doc/1", docs("/doc/2")), "changed");
// THE HOLE THIS CLOSES: during a navigation transition the outgoing and incoming
// documents can BOTH be present. Finding the old one is then no proof at all —
// "old target gone" plus "content grew" would otherwise read as a dismissal.
check("old AND new generations coexisting -> unknown, NOT same",
  D("/doc/1", docs("/doc/1", "/doc/2")), "unknown");
check("  ...and names the ambiguity", DR("/doc/1", docs("/doc/1", "/doc/2")), "multiple_page_documents");
check("two generations, neither of them ours -> unknown, not changed",
  D("/doc/1", docs("/doc/2", "/doc/3")), "unknown");
// A page with an iframe exposes more than one page document. Stated cost: it can
// never be verified, only ever UNVERIFIED.
check("an IFRAME (two page documents) -> unknown, the accepted cost of failing closed",
  D("/doc/1", docs("/doc/1", "/doc/iframe")), "unknown");
check("the same generation repeated with the SAME uri is still one document",
  D("/doc/1", docs("/doc/1", "/doc/1")), "same");
check("  ...and names the replacement", DR("/doc/1", docs("/doc/2")), "document_generation_replaced");
check("no post-action survey at all -> unknown, never 'same'", D("/doc/1", null), "unknown");
check("  ...and says the survey is missing", DR("/doc/1", null), "no_after_survey");
check("no page document afterwards -> unknown", D("/doc/1", []), "unknown");
check("documents with unreadable generations -> unknown", D("/doc/1", docs(null, undefined)), "unknown");
check("ONE readable generation alongside an unreadable one -> unknown, never same",
  D("/doc/1", docs("/doc/1", null)), "unknown");
check("  ...and says a generation could not be read", DR("/doc/1", docs("/doc/1", null)), "unreadable_page_generation");
check("an empty-string generation is not readable", D("/doc/1", docs("")), "unknown");
check("one generation reported against CONFLICTING uris -> unknown",
  D("/doc/1", [{ doc_gen: "/doc/1", uri: "https://a.test/" }, { doc_gen: "/doc/1", uri: "https://b.test/" }]),
  "unknown");
check("  ...and names the conflict",
  DR("/doc/1", [{ doc_gen: "/doc/1", uri: "https://a.test/" }, { doc_gen: "/doc/1", uri: "https://b.test/" }]),
  "conflicting_document_identity");
check("no BEFORE generation to compare against -> unknown", D(null, docs("/doc/1")), "unknown");

console.log("--- is the target dialog still there? (a failed probe is not a disappearance) ---");
const T = (p) => classifyTargetState(p).state;
check("the identity still resolves -> present", T({ found: true }), "present");
// stale_none is the ONLY status that proves absence: the document generation was
// found and searched, and the node was not in it.
check("stale_none -> provably gone", T({ found: false, status: "stale_none" }), "gone");
check("stale_doc (the document itself went) -> unknown, NOT gone", T({ found: false, status: "stale_doc" }), "unknown");
check("stale_ambiguous -> unknown", T({ found: false, status: "stale_ambiguous" }), "unknown");
check("stale_mismatch -> unknown", T({ found: false, status: "stale_mismatch" }), "unknown");
check("a thrown/absent probe -> unknown, NOT gone", T(null), "unknown");
check("  ...and says the probe failed", classifyTargetState(null).reason, "probe_failed");
check("a probe with no status at all -> unknown", T({ found: false }), "unknown");

console.log("--- what counts as revealed ---");
const c = (links, content, dialogs = 0) => ({ links, content, dialogs });
check("more links -> revealed", materiallyIncreased(c(0, 5), c(76, 300)), true);
check("more content with equal links -> revealed", materiallyIncreased(c(0, 5), c(0, 40)), true);
check("IDENTICAL counts -> NOT revealed (unchanged is not restoration)", materiallyIncreased(c(3, 9), c(3, 9)), false);
check("fewer links and content -> not revealed", materiallyIncreased(c(5, 20), c(1, 4)), false);
check("missing before/after -> not revealed", materiallyIncreased(null, c(1, 1)), false);

console.log("--- the verdict ---");
const V = (o) => classifyDismissOutcome(o).kind;
const R = (o) => classifyDismissOutcome(o).reason;
const base = { invoked: true, invocationCount: 1, targetState: "gone", documentState: "same",
               before: c(0, 5, 1), after: c(76, 300, 0) };
check("gone + same document + revealed -> success", V(base), "success");
check("dialog STILL resolves -> failed", V({ ...base, targetState: "present" }), "failed");
check("  ...and says the dialog is still present", R({ ...base, targetState: "present" }), "dialog_still_present");
check("gone but nothing revealed -> unverified", V({ ...base, after: c(0, 5, 0) }), "unverified");
check("  ...and says nothing was revealed", R({ ...base, after: c(0, 5, 0) }), "nothing_revealed");
// A same-URL reload makes the target's disappearance meaningless — content
// growing afterwards is the NEW document's content, not something this
// dismissal revealed.
check("the document was REPLACED -> unverified, not success", V({ ...base, documentState: "changed" }), "unverified");
check("  ...and says so, even though the target is gone and content grew", R({ ...base, documentState: "changed" }), "document_navigated");
check("an unprovable document identity -> unverified", V({ ...base, documentState: "unknown" }), "unverified");
check("  ...and says the document could not be re-identified", R({ ...base, documentState: "unknown" }), "document_identity_unverified");
check("document doubt outranks a still-present dialog too", V({ ...base, documentState: "changed", targetState: "present" }), "unverified");
// An inconclusive probe must never be credited as a dismissal.
check("an unknown target state -> unverified, never success", V({ ...base, targetState: "unknown" }), "unverified");
check("  ...and says the identity could not be verified", R({ ...base, targetState: "unknown" }), "target_identity_unverified");
check("nothing invoked -> refused", V({ ...base, invoked: false }), "refused");
// The bridge's own tally is the number of record; anything but exactly one
// invocation means the report cannot describe what happened.
check("zero invocations reported by the bridge -> unverified", V({ ...base, invocationCount: 0 }), "unverified");
check("more than one invocation -> unverified", V({ ...base, invocationCount: 2 }), "unverified");
check("a missing invocation count -> unverified", V({ ...base, invocationCount: undefined }), "unverified");
check("  ...and names the count as the problem", R({ ...base, invocationCount: 0 }), "invocation_count_unexpected");

console.log("--- reporting ---");
const reasons = ["stale_ref", "control_unreadable", "not_inside_a_dialog", "ambiguous_dialog_ancestry",
  "dialog_not_in_a_page_document", "substantive_choice_refused", "not_a_close_affordance", "role_not_a_button",
  "no_activation_action", "ambiguous_action", "control_has_no_name", "action_without_name", "not_invoked"];
check("every refusal reason has an explanation", reasons.every((r) => typeof DISMISS_REFUSAL_TEXT[r] === "string" && DISMISS_REFUSAL_TEXT[r].length > 20), true);
check("the consent refusal points at the deliberate alternative",
  /click_element/.test(DISMISS_REFUSAL_TEXT.substantive_choice_refused), true);

console.log("--- may ONE Escape be sent at this exact target, right now? ---");
// A context that passes every gate. Each row below spoils exactly one clause.
const GOOD = {
  target: { obj_path: "/d/1", doc_gen: "/doc/1", is_dialog_root: true, modal: true,
            in_page_document: true, tag: "div", xml_roles: "dialog" },
  page_dialog_roots: 1,
  focus: { doc_class: "page", doc_gen: "/doc/1", obj_path: "/f/1" },
  page_docs: [{ doc_gen: "/doc/1", uri: "https://x.test/" }],
  survey: { links: 1, content: 4, dialogs: 1 },
};
const ctx = (over) => ({ ...GOOD, ...over });
const E = (c) => classifyEscapeTarget(c).eligible;
const ER = (c) => classifyEscapeTarget(c).reason;
check("a sole modal dialog in the focused page document -> eligible", E(GOOD), true);
check("  ...and says WHY it qualified", ER(GOOD), "same_document_modal");
// Focus inside the target is strictly stronger and is reported as such.
check("focus INSIDE the target is also eligible, and named differently",
  ER(ctx({ focus: { ...GOOD.focus, inside_target: true } })), "focus_inside_target_modal");

// MODALITY MUST BE POSITIVE. Without it an Escape has no proven recipient — it
// could act on the page, the browser, or something else entirely.
check("a dialog that does NOT report itself modal -> refused", E(ctx({ target: { ...GOOD.target, modal: false } })), false);
check("  ...and says so", ER(ctx({ target: { ...GOOD.target, modal: false } })), "not_modal");
check("an unreadable modal flag -> refused", E(ctx({ target: { ...GOOD.target, modal: undefined } })), false);
check("a non-modal dialog with focus INSIDE that exact target -> eligible",
  E(ctx({ target: { ...GOOD.target, modal: false }, focus: { ...GOOD.focus, inside_target: true } })), true);
check("  ...and names the stronger focus proof",
  ER(ctx({ target: { ...GOOD.target, modal: false }, focus: { ...GOOD.focus, inside_target: true } })), "focus_inside_target_dialog");
// A tag of "div" (a scripted aria-modal overlay) is explicitly FINE — requiring
// a native <dialog> would exclude the very case this was built for.
check("a scripted div overlay is eligible when it reports modal",
  E(ctx({ target: { ...GOOD.target, tag: "div", xml_roles: "dialog" } })), true);
check("a native <dialog> is equally eligible",
  E(ctx({ target: { ...GOOD.target, tag: "dialog", xml_roles: null } })), true);

// THE MULTIPLE-DIALOG RULE. Escape goes to whichever modal the browser considers
// topmost; a ref cannot prove that is the one asked for. Pressing and finding
// out afterwards is exactly the wrong order.
check("more than one dialog root -> refused, no keypress", E(ctx({ page_dialog_roots: 2 })), false);
check("  ...and says the recipient is unprovable", ER(ctx({ page_dialog_roots: 2 })), "multiple_dialogs");
check("multiple roots are safe when focus is inside the exact requested dialog",
  E(ctx({ page_dialog_roots: 2, focus: { ...GOOD.focus, inside_target: true } })), true);
check("zero dialog roots (the target vanished between reads) -> refused", E(ctx({ page_dialog_roots: 0 })), false);

console.log("--- focus is a GATE, never something to change ---");
check("browser UI holding focus -> refused",
  ER(ctx({ focus: { doc_class: "browser_internal", doc_gen: null } })), "browser_ui_focus");
check("no focus at all -> refused", ER(ctx({ focus: null })), "no_focus");
check("an unidentifiable focus document -> refused",
  ER(ctx({ focus: { doc_class: "unknown", doc_gen: "/doc/1" } })), "focus_document_unknown");
// Compared by generation identity, never by URI text.
check("focus in a DIFFERENT page document -> refused",
  ER(ctx({ focus: { doc_class: "page", doc_gen: "/doc/9" } })), "focus_in_a_different_document");
check("focus whose document generation is unreadable -> refused",
  ER(ctx({ focus: { doc_class: "page", doc_gen: null } })), "focus_in_a_different_document");

console.log("--- the target itself must be the dialog ---");
check("a control INSIDE a dialog is not a dialog root -> refused",
  ER(ctx({ target: { ...GOOD.target, is_dialog_root: false } })), "not_a_dialog_root");
check("a dialog in browser UI -> refused",
  ER(ctx({ target: { ...GOOD.target, in_page_document: false } })), "dialog_not_in_a_page_document");
check("a ref that no longer resolves -> refused", ER({ ...GOOD, target: null }), "stale_ref");
check("no context at all -> refused", ER(null), "no_context");

console.log("--- settled means the WHOLE gate agrees, not just content counts ---");
check("two identical observations agree", escapeObservationsAgree(GOOD, ctx({})), true);
check("a replaced document does NOT agree",
  escapeObservationsAgree(GOOD, ctx({ page_docs: [{ doc_gen: "/doc/2", uri: "https://x.test/" }] })), false);
check("a changed URI does NOT agree",
  escapeObservationsAgree(GOOD, ctx({ page_docs: [{ doc_gen: "/doc/1", uri: "https://x.test/other" }] })), false);
// A modal that stopped being modal between observations is a page still moving.
check("a target that stopped being modal does NOT agree",
  escapeObservationsAgree(GOOD, ctx({ target: { ...GOOD.target, modal: false } })), false);
check("focus moving out of the target does NOT agree",
  escapeObservationsAgree(ctx({ focus: { ...GOOD.focus, inside_target: true } }), GOOD), false);
check("a dialog appearing between observations does NOT agree",
  escapeObservationsAgree(GOOD, ctx({ page_dialog_roots: 2 })), false);
check("changed content counts do NOT agree",
  escapeObservationsAgree(GOOD, ctx({ survey: { links: 9, content: 4, dialogs: 1 } })), false);
check("a missing observation never agrees", escapeObservationsAgree(GOOD, null), false);

console.log("--- what one Escape proved ---");
const eo = (o) => classifyEscapeOutcome({ escapesSent: 1, documentState: "same", targetState: "gone",
  before: { links: 0, content: 2, dialogs: 1 }, after: { links: 40, content: 90, dialogs: 0 }, ...o });
check("same document + target gone + content grew -> success", eo({}).kind, "success");
check("  ...and reports the content as revealed", eo({}).reason, "dismissed_and_content_revealed");
// CONTENT GROWTH IS CORROBORATION, NOT A REQUIREMENT: a promo overlay may leave
// the background exposed, so no increase does not mean Escape failed.
check("target gone but NO content growth is STILL a success",
  eo({ after: { links: 0, content: 2, dialogs: 0 } }).kind, "success");
check("  ...worded so it claims only what happened",
  eo({ after: { links: 0, content: 2, dialogs: 0 } }).reason, "dismissed_without_content_growth");
check("the dialog is STILL there -> failed", eo({ targetState: "present" }).kind, "failed");
check("an inconclusive identity probe -> unverified, never success",
  eo({ targetState: "unknown" }).reason, "target_identity_unverified");
check("the document was replaced -> unverified", eo({ documentState: "changed" }).reason, "document_navigated");
check("an ambiguous document -> unverified", eo({ documentState: "unknown" }).reason, "document_identity_unverified");
check("document doubt outranks a gone target", eo({ documentState: "changed", targetState: "gone" }).kind, "unverified");
check("zero Escapes sent -> unverified", classifyEscapeOutcome({ escapesSent: 0, documentState: "same", targetState: "gone" }).reason, "escape_count_unexpected");
check("two Escapes sent -> unverified", classifyEscapeOutcome({ escapesSent: 2, documentState: "same", targetState: "gone" }).reason, "escape_count_unexpected");

console.log("--- every Escape refusal explains itself ---");
const escReasons = ["no_context", "stale_ref", "not_a_dialog_root", "dialog_not_in_a_page_document",
  "not_modal", "multiple_dialogs", "no_focus", "browser_ui_focus", "focus_document_unknown",
  "focus_in_a_different_document", "page_unsettled"];
check("all of them have text", escReasons.every((r) => typeof ESCAPE_REFUSAL_TEXT[r] === "string" && ESCAPE_REFUSAL_TEXT[r].length > 20), true);
check("the multiple-dialog refusal says nothing was pressed", /nothing was pressed/i.test(ESCAPE_REFUSAL_TEXT.multiple_dialogs), true);
// The wording that carried my wrong "no close affordance means blocked" claim.
check("the no-close-affordance refusal now points at Escape instead of implying the page is blocked",
  /dialog_ref/.test(DISMISS_REFUSAL_TEXT.not_a_close_affordance), true);

console.log("--- ONE unambiguous document, proven BEFORE the key ---");
// The postcondition can only be evaluated against a single page document. With
// an iframe the verdict afterwards is "cannot tell" — so the ambiguity has to
// stop us BEFORE spending a hazardous keypress, not after.
const DI = (docs) => documentIdentity(docs).state;
const DIR = (docs) => documentIdentity(docs).reason;
check("one document -> single", DI([{ doc_gen: "/1", uri: "u" }]), "single");
check("the SAME document seen twice is still one document",
  DI([{ doc_gen: "/1", uri: "u" }, { doc_gen: "/1", uri: "u" }]), "single");
check("an IFRAME (two documents) -> ambiguous", DI([{ doc_gen: "/1", uri: "u" }, { doc_gen: "/2", uri: "v" }]), "ambiguous");
check("  ...and names the iframe case", DIR([{ doc_gen: "/1", uri: "u" }, { doc_gen: "/2", uri: "v" }]), "multiple_page_documents");
check("one generation with CONFLICTING uris -> ambiguous",
  DIR([{ doc_gen: "/1", uri: "u" }, { doc_gen: "/1", uri: "v" }]), "conflicting_document_identity");
check("an unreadable generation -> unusable", DIR([{ doc_gen: null, uri: "u" }]), "unreadable_page_document");
check("an empty-string generation -> unusable", DIR([{ doc_gen: "", uri: "u" }]), "unreadable_page_document");
check("no documents at all -> unusable", DIR([]), "no_page_document");
check("a non-array -> unusable", DIR(null), "no_page_document");
// The gate itself must refuse, not just the helper.
check("the GATE refuses an iframe page before any keypress",
  classifyEscapeTarget({ ...GOOD, page_docs: [{ doc_gen: "/doc/1", uri: "u" }, { doc_gen: "/doc/2", uri: "v" }] }).reason,
  "multiple_page_documents");
check("the GATE refuses an unreadable document",
  classifyEscapeTarget({ ...GOOD, page_docs: [{ doc_gen: null, uri: "u" }] }).reason, "unreadable_page_document");
check("the GATE still accepts a single document", classifyEscapeTarget(GOOD).eligible, true);

console.log("--- settled compares document RECORDS, not fields sorted apart ---");
// Sorting generations and URIs independently would call these two equal, because
// each sorted list matches — only the PAIRING differs.
const swappedA = { ...GOOD, page_docs: [{ doc_gen: "/a", uri: "one" }, { doc_gen: "/b", uri: "two" }] };
const swappedB = { ...GOOD, page_docs: [{ doc_gen: "/a", uri: "two" }, { doc_gen: "/b", uri: "one" }] };
check("a SWAPPED generation/URI pairing does NOT agree", escapeObservationsAgree(swappedA, swappedB), false);
check("the same pairing in a different order DOES agree",
  escapeObservationsAgree(swappedA, { ...GOOD, page_docs: [{ doc_gen: "/b", uri: "two" }, { doc_gen: "/a", uri: "one" }] }), true);

console.log("--- every added refusal explains itself ---");
const addedReasons = ["no_page_document", "unreadable_page_document", "multiple_page_documents", "conflicting_document_identity"];
check("all have text", addedReasons.every((r) => typeof ESCAPE_REFUSAL_TEXT[r] === "string" && ESCAPE_REFUSAL_TEXT[r].length > 20), true);
check("the iframe refusal explains that verification would be impossible, and that nothing was pressed",
  /could NOT be verified/.test(ESCAPE_REFUSAL_TEXT.multiple_page_documents) && /nothing was pressed/i.test(ESCAPE_REFUSAL_TEXT.multiple_page_documents), true);
// No unsupported prevalence claim anywhere in the user-facing text.
check("no refusal text claims Escape closes 'most' overlays",
  !Object.values(ESCAPE_REFUSAL_TEXT).concat(Object.values(DISMISS_REFUSAL_TEXT)).some((t) => /\bmost\b/i.test(t)), true);

console.log("--- an ambiguity refusal names the alternative that actually works ---");
// Both of these refuse for a reason a KEYPRESS cannot resolve: which dialog
// receives it, and whether the outcome can be read back. Neither reason applies
// to activating the overlay's own close control, so the refusal that stops the
// keypress must say so — otherwise the only remaining move looks like sending a
// raw Escape, which is the browser's stop-loading shortcut.
// Strip the PROHIBITION sentence, so what remains is only what the text
// actually recommends. Everything after "Do NOT send an Escape yourself" is
// that one clause, to the end of the string.
const advice = (t) => t.replace(/Do NOT send an Escape yourself.*/is, "");
for (const reason of ["multiple_dialogs", "multiple_page_documents"]) {
  const text = ESCAPE_REFUSAL_TEXT[reason];
  check(`${reason} names control_ref as the way forward`, /control_ref/.test(text), true);
  check(`  ${reason} names the tool to call it on`, /dismiss_dialog/.test(text), true);
  check(`  ${reason} explicitly forbids a hand-rolled Escape`, /Do NOT send an Escape yourself/.test(text), true);
  check(`  ${reason} says WHY Escape is not a workaround`, /stop-loading/.test(text), true);
  // Guidance only: the RECOMMENDATION itself — as distinct from the
  // explanation, where naming Escape is the whole point — offers no keystroke.
  const recommendation = (text.match(/Call dismiss_dialog[\s\S]*?(?=\. Do NOT send)/) || [""])[0];
  check(`  ${reason} states a recommendation`, recommendation.length > 40, true);
  check(`  ${reason} recommends no keystroke of any kind`, /\bkey_press\b|\bEscape\b/.test(recommendation), false);
  check(`  ${reason} still reports that nothing was pressed`, /nothing was pressed/i.test(text), true);
}
// The pre-existing wording these were modelled on is unchanged.
check("the no-close-affordance refusal still points at dialog_ref",
  /dialog_ref/.test(DISMISS_REFUSAL_TEXT.not_a_close_affordance), true);
// No refusal anywhere may RECOMMEND a bare Escape as a workaround. The gated
// tool sending one on the caller's behalf is a different thing and is allowed.
check("no refusal text tells the caller to press Escape themselves",
  !Object.values(ESCAPE_REFUSAL_TEXT).concat(Object.values(DISMISS_REFUSAL_TEXT))
    .some((t) => /\b(press|send|hit|try)\s+(a\s+|an\s+|one\s+)?Escape\b/i.test(advice(t))), true);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
