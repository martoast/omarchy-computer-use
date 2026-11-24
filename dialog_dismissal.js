// Pure verdict logic for dismiss_dialog, kept out of the tool so the rules that
// decide "did dismissing this modal actually reveal the page" are testable
// without a browser.
//
// Context: a consent or promo modal can aria-hide the whole storefront behind
// it, so the page renders normally while its accessibility tree exposes only the
// modal. Dismissing the modal restores the rest — but "the button reported
// success" proves nothing, and neither does the dialog disappearing, because a
// SECOND modal's own text and buttons would otherwise look like restored page
// content, and a same-URL reload would make the old dialog vanish while
// replacing everything behind it.
//
// BEFORE and AFTER are both the bridge's `_page_survey` — one structural walk,
// the same instrument on both sides. They are never compared against a
// read_page snapshot, which is capped and name-gated and would make a truncated
// read look like a page that lost content.

/** What did the bridge actually do, read from ITS OWN count of do_action calls?
 * Called on EVERY bridge result, before any refusal handling, because one
 * refusal reason is not a refusal at all: `do_action_failed` means the call was
 * ISSUED and then raised, so it may have partially applied. Reporting that as
 * "nothing was activated" would be a lie, and dropping it from the tally would
 * hide a real mutation.
 *   acted    — invoked, exactly one call
 *   refused  — not invoked, zero calls: nothing happened, safe to say so
 *   partial  — not invoked, but calls WERE issued: unverified, never "nothing"
 *   unusable — the bridge reported no usable count, so nothing can be claimed */
export function classifyBridgeResult(res) {
  const raw = res?.invocation_count;
  const count = Number.isInteger(raw) && raw >= 0 ? raw : null;
  if (count === null) return { kind: "unusable", reason: "invocation_count_missing", invocationCount: null };
  if (res.invoked === true) {
    return count === 1
      ? { kind: "acted", reason: "invoked", invocationCount: count }
      : { kind: "unusable", reason: "invocation_count_unexpected", invocationCount: count };
  }
  const reason = res.reason ?? "unrecognized_result";
  return count === 0
    ? { kind: "refused", reason, invocationCount: 0 }
    : { kind: "partial", reason, invocationCount: count };
}

/** Was the target dialog's page document REPLACED under us?
 * Compares document GENERATIONS (object-path identity), never URL text: a
 * same-URL reload leaves the URL identical while replacing the document node,
 * so URL comparison reports "same page" for a page that is entirely new.
 *
 * FAILS CLOSED ON ANYTHING BUT A SINGLE UNAMBIGUOUS PAGE DOCUMENT. Merely
 * finding the old generation still present is NOT enough: during a navigation
 * transition the outgoing and incoming documents can BOTH be present, and then
 * "old target gone" plus "content grew" would read as a successful dismissal
 * when what actually happened was a page change.
 *   same    — exactly one readable page generation, and it is the one we started in
 *   changed — exactly one readable page generation, and it is a different one
 *   unknown — none, unreadable, conflicting, or more than one
 *
 * KNOWN COST, stated rather than hidden: a page with an IFRAME exposes more than
 * one page document, so it lands in `unknown` and dismiss_dialog can never
 * report success there — it reports UNVERIFIED and the caller re-reads. That is
 * the safe direction, but it is a real limitation on iframe-heavy stores. A
 * depth-aware rule (compare only the outermost page document) would lift it and
 * is not attempted here. */
export function classifyDocumentState(beforeDocGen, afterPageDocs) {
  if (!beforeDocGen) return { state: "unknown", reason: "no_before_generation" };
  if (!Array.isArray(afterPageDocs)) return { state: "unknown", reason: "no_after_survey" };
  if (afterPageDocs.length === 0) return { state: "unknown", reason: "no_page_document_after" };
  // A survey in which any page document's generation could not be read cannot
  // prove which documents exist, so none of it can be trusted.
  if (afterPageDocs.some((d) => typeof d?.doc_gen !== "string" || !d.doc_gen)) {
    return { state: "unknown", reason: "unreadable_page_generation" };
  }
  // One generation reported against conflicting URIs is not one document.
  const byGen = new Map();
  for (const d of afterPageDocs) {
    const uris = byGen.get(d.doc_gen) ?? new Set();
    uris.add(d.uri ?? null);
    byGen.set(d.doc_gen, uris);
  }
  for (const uris of byGen.values()) {
    if (uris.size > 1) return { state: "unknown", reason: "conflicting_document_identity" };
  }
  if (byGen.size > 1) return { state: "unknown", reason: "multiple_page_documents" };
  const only = [...byGen.keys()][0];
  return only === beforeDocGen
    ? { state: "same", reason: "same_document_generation" }
    : { state: "changed", reason: "document_generation_replaced" };
}

/** Is the target dialog still there? Read from an identity probe of the
 * dialog's own (doc_gen, obj_path).
 * A probe FAILURE is not a disappearance. Only `stale_none` proves absence:
 * that status means the document generation was found and searched and the
 * node was not in it. Every other outcome — the document itself gone
 * (stale_doc), an ambiguous or mismatched resolve, a thrown probe — leaves the
 * question open, and open must not be credited as success. */
export function classifyTargetState(probe) {
  if (!probe || typeof probe !== "object") return { state: "unknown", reason: "probe_failed" };
  if (probe.found === true) return { state: "present", reason: "identity_still_resolves" };
  if (probe.status === "stale_none") return { state: "gone", reason: "identity_absent_in_same_document" };
  if (probe.status) return { state: "unknown", reason: `probe_inconclusive:${probe.status}` };
  return { state: "unknown", reason: "probe_inconclusive" };
}

/** Did dismissing the modal actually reveal something? Deliberately strict and
 * deterministic: MORE links than before is the strong proof; otherwise a
 * strictly positive content delta outside every dialog. Never `>=` (unchanged
 * is not restoration) and never dialog content. */
export function materiallyIncreased(before, after) {
  if (!before || !after) return false;
  if (after.links > before.links) return true;
  return after.content > before.content;
}

/** The outcome of one dismissal attempt. Ordered so that anything unproven
 * short-circuits BEFORE the content comparison can be read as success. */
export function classifyDismissOutcome({ invoked, invocationCount, targetState, documentState, before, after }) {
  if (!invoked) return { kind: "refused", reason: "not_invoked" };
  if (invocationCount !== 1) return { kind: "unverified", reason: "invocation_count_unexpected" };
  if (documentState === "changed") return { kind: "unverified", reason: "document_navigated" };
  if (documentState !== "same") return { kind: "unverified", reason: "document_identity_unverified" };
  if (targetState === "present") return { kind: "failed", reason: "dialog_still_present" };
  if (targetState !== "gone") return { kind: "unverified", reason: "target_identity_unverified" };
  if (!materiallyIncreased(before, after)) return { kind: "unverified", reason: "nothing_revealed" };
  return { kind: "success", reason: "dialog_gone_and_content_revealed" };
}

/** Human-readable text for every refusal the bridge can return, so a report
 * never says merely "refused". */
export const DISMISS_REFUSAL_TEXT = {
  stale_ref: "that ref no longer identifies a live control — call read_page again and use a fresh one",
  control_unreadable: "the control could not be read",
  not_inside_a_dialog: "the control is not inside a dialog, so dismissing it is not what this tool does",
  ambiguous_dialog_ancestry: "the control sits inside more than one dialog, so which one it would close is ambiguous",
  expected_dialog_stale: "the named dialog identity is stale, so the control cannot be proven to belong to it",
  expected_dialog_mismatch: "the close control is not inside the exact dialog that was named",
  dialog_not_in_a_page_document: "the dialog is not in a page document (browser UI is never dismissed this way)",
  substantive_choice_refused:
    "that control makes a substantive choice (consent, subscription, or similar), not a dismissal. This tool only closes dialogs. Use click_element if that specific choice is genuinely intended",
  not_a_close_affordance: "the control's name is not a close affordance, and this tool will not guess which control closes a dialog. If the dialog exposes no close control at all, try dismiss_dialog with dialog_ref instead — it sends one Escape and verifies whether this overlay responds to it, which is worth trying on a consent banner that offers only Accept/Reject/Preferences",
  role_not_a_button: "the control is not a button (a link could navigate instead of closing)",
  no_activation_action: "the control exposes no activation action of its own, and no coordinate click will be attempted",
  ambiguous_action: "the control exposes an unclassifiable set of actions; not guessing which one to invoke",
  control_has_no_name: "the control has no accessible name to judge",
  action_without_name: "one of the control's actions has no name, so the set cannot be classified safely",
  not_invoked: "no action was performed",
  unrecognized_result: "the bridge returned a result this tool does not recognize",
  invocation_count_missing: "the bridge did not report how many actions it issued",
};


// --- Escape dismissal -------------------------------------------------------
// A modal overlay can be closed by the Escape key, which is often the ONLY way:
// a consent banner may expose no close affordance at all, only Accept/Reject/
// Preferences — controls this harness must never activate to clear a page.
//
// Escape is also Chromium's STOP-LOADING shortcut, which is why it is forbidden
// during navigation. This path is different and must stay different: it is
// addressed to ONE positively-identified modal on a settled page, and it is not
// permitted to run on the strength of "the page looks empty".
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO:
//   It never manipulates focus. No grab, no click, no pointer. The site and the
//   browser have already established the operative modal context; focus is
//   OBSERVED as a safety gate, because changing it would alter the very state
//   being reasoned about.
//   It never promises delivery. MODAL proves the target is a modal. It does NOT
//   prove the page will act on Escape — MEASURED: the overlay this was built for
//   is a scripted div with aria-modal, so its own keydown handler is what
//   closes it, and that is unknowable in advance. The key is sent into a
//   well-defined situation and the OUTCOME is then proven.


/** The page documents as IDENTITY RECORDS. A generation and a URI are only
 * meaningful together: comparing sorted generations against sorted URIs
 * separately would call two observations equal even if the pairing had swapped.
 * Identical duplicate records (the same document seen twice in one walk) are
 * normalized to one — that is the same document, not two. */
export function documentIdentity(pageDocs) {
  if (!Array.isArray(pageDocs)) return { state: "unusable", reason: "no_page_document" };
  if (pageDocs.length === 0) return { state: "unusable", reason: "no_page_document" };
  if (pageDocs.some((d) => typeof d?.doc_gen !== "string" || !d.doc_gen)) {
    return { state: "unusable", reason: "unreadable_page_document" };
  }
  const records = [...new Set(pageDocs.map((d) => JSON.stringify([d.doc_gen, d.uri ?? null])))];
  if (records.length > 1) {
    // Either several documents (an iframe), or one generation reported against
    // conflicting URIs. Both make the postcondition unevaluable.
    const gens = new Set(pageDocs.map((d) => d.doc_gen));
    return { state: "ambiguous", reason: gens.size > 1 ? "multiple_page_documents" : "conflicting_document_identity", records };
  }
  return { state: "single", reason: "single_page_document", records };
}

/** Is this exact target eligible for one Escape, right now?
 * `ctx` is the bridge's read-only context. Every clause is a positive
 * requirement; anything unreadable refuses. */
export function classifyEscapeTarget(ctx) {
  if (!ctx || typeof ctx !== "object") return { eligible: false, reason: "no_context" };
  const t = ctx.target;
  if (!t) return { eligible: false, reason: "stale_ref" };
  if (!t.is_dialog_root) return { eligible: false, reason: "not_a_dialog_root" };
  if (!t.in_page_document) return { eligible: false, reason: "dialog_not_in_a_page_document" };
  const f = ctx.focus;
  if (!f) return { eligible: false, reason: "no_focus" };
  if (f.doc_class === "browser_internal") return { eligible: false, reason: "browser_ui_focus" };
  if (f.doc_class !== "page") return { eligible: false, reason: "focus_document_unknown" };
  // A non-modal ARIA dialog has no browser-enforced Escape recipient. Focus
  // INSIDE that exact dialog is an equally strong, directly measured recipient:
  // the key is delivered to a descendant and can be handled by the dialog's
  // own keydown listener. Same-page focus alone is insufficient.
  const focusInsideTarget = f.inside_target === true;
  if (t.modal !== true && !focusInsideTarget) return { eligible: false, reason: "not_modal" };
  // Escape goes to the browser's TOPMOST modal. A caller-supplied ref does not
  // prove which of several roots would receive it, so with more than one we
  // refuse rather than press and discover afterwards that the wrong one closed.
  if (ctx.page_dialog_roots !== 1 && !focusInsideTarget) return { eligible: false, reason: "multiple_dialogs" };
  // The postcondition can only be evaluated against ONE unambiguous page
  // document. With an iframe there are several, and the verdict afterwards would
  // be "cannot tell" — so the ambiguity has to stop us BEFORE the key, not after
  // a hazardous keypress has already been spent on an unverifiable situation.
  const docs = documentIdentity(ctx.page_docs);
  if (docs.state !== "single") return { eligible: false, reason: docs.reason };
  // Focus must be in the SAME page document as the dialog, compared by
  // generation identity rather than URI text.
  if (!f.doc_gen || !t.doc_gen || f.doc_gen !== t.doc_gen) {
    return { eligible: false, reason: "focus_in_a_different_document" };
  }
  return {
    eligible: true,
    reason: focusInsideTarget ? (t.modal === true ? "focus_inside_target_modal" : "focus_inside_target_dialog") : "same_document_modal",
  };
}

/** Do two observations describe the same settled situation? Compares the whole
 * gate, not just content counts: a modal that stopped being modal, a dialog
 * that came or went, or a document that was replaced between observations all
 * mean the page is still moving. */
export function escapeObservationsAgree(a, b) {
  if (!a || !b) return false;
  // Documents compared as PAIRED records: sorting generations and URIs
  // independently would let a swapped pairing compare equal.
  const key = (c) => JSON.stringify({
    docs: (c.page_docs || []).map((d) => [d?.doc_gen ?? null, d?.uri ?? null])
      .map((r) => JSON.stringify(r)).sort(),
    target: c.target ? [c.target.obj_path, c.target.doc_gen, c.target.modal, c.target.is_dialog_root] : null,
    focus: c.focus ? [c.focus.obj_path, c.focus.doc_gen, c.focus.doc_class, c.focus.inside_target === true] : null,
    roots: c.page_dialog_roots,
    survey: c.survey ? [c.survey.links, c.survey.content, c.survey.dialogs] : null,
  });
  return key(a) === key(b);
}

/** The outcome of one Escape.
 * Content growth is CORROBORATION, not a requirement: a promo overlay may leave
 * the background exposed, so no increase does not mean Escape failed. What is
 * required is that the document did not change under us and the exact target is
 * provably gone. */
export function classifyEscapeOutcome({ escapesSent, documentState, targetState, before, after }) {
  if (escapesSent !== 1) return { kind: "unverified", reason: "escape_count_unexpected" };
  if (documentState === "changed") return { kind: "unverified", reason: "document_navigated" };
  if (documentState !== "same") return { kind: "unverified", reason: "document_identity_unverified" };
  if (targetState === "present") return { kind: "failed", reason: "dialog_still_present" };
  if (targetState !== "gone") return { kind: "unverified", reason: "target_identity_unverified" };
  return {
    kind: "success",
    reason: materiallyIncreased(before, after) ? "dismissed_and_content_revealed" : "dismissed_without_content_growth",
  };
}

/** Human-readable text for every Escape refusal. */
export const ESCAPE_REFUSAL_TEXT = {
  no_context: "the page state could not be read",
  stale_ref: "that ref no longer identifies a live element — call read_page again and use a fresh one",
  not_a_dialog_root: "that ref is not a dialog root. Pass the dialog itself, not a control inside it",
  dialog_not_in_a_page_document: "the dialog is not in a page document (browser UI is never dismissed this way)",
  not_modal: "the dialog does not report itself as modal and keyboard focus is not inside that exact dialog, so an Escape has no proven recipient",
  multiple_dialogs: "more than one dialog is present. Escape goes to whichever the browser considers topmost, which this ref cannot prove is the one you asked for — nothing was pressed. Call dismiss_dialog with control_ref naming that dialog's OWN close control instead: a close control belongs to exactly one dialog, so which overlay closes is proven rather than assumed. Do NOT send an Escape yourself with key_press — Escape is also the browser's stop-loading shortcut, and pressing it outside this tool can abort a navigation that is still in flight",
  no_focus: "nothing holds keyboard focus, so there is no proven context to send a key into",
  browser_ui_focus: "the browser's own UI holds keyboard focus, so an Escape would act on the browser rather than the page",
  focus_document_unknown: "the focused node's document could not be identified",
  focus_in_a_different_document: "keyboard focus is in a different document than the dialog",
  page_unsettled: "the page changed between two observations, so it is not settled enough to act on",
  no_page_document: "no page document could be read, so there is nothing to verify the outcome against",
  unreadable_page_document: "a page document's identity could not be read, so the outcome could not be verified afterwards",
  multiple_page_documents: "this page exposes more than one document (an iframe, for example), so whether the overlay closed could NOT be verified afterwards — nothing was pressed rather than spending a keypress on an unverifiable situation. Call dismiss_dialog with control_ref naming the overlay's OWN close control instead: activating a named control is verified by that control, so a second document does not make the outcome unreadable. Do NOT send an Escape yourself with key_press — Escape is also the browser's stop-loading shortcut, and pressing it outside this tool can abort a navigation that is still in flight",
  conflicting_document_identity: "the page document reported conflicting identities, so the outcome could not be verified afterwards",
};
