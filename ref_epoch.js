// Page NAVIGATION EPOCHS for ref-stability decisions, kept pure so they are
// unit-testable without AT-SPI.
//
// WHY (a live run): the probe
// clicked the app's "Buscar con IA" nav button (a real page-level SPA route
// change to /app/search), the very next wait_for_element found the composer
// (e122 entry "Escribe tu mensaje"), and type_into_element on that ref came
// back NOT VERIFIED: the freshly mounted page replaced the editable node
// right after it was found (a remount race in normal post-navigation async
// work), so the keystrokes went to a node that no longer existed. The existing
// retry re-resolves the SAME identity (stale) and focus-recovery is scoped to
// combo boxes, so nothing re-found the new, unique editable.
//
// The fix is a ONE-time extra cycle in type_into_element, gated on EVIDENCE
// that the ref was found in the unsettled moment right after a navigation:
//   - an epoch: the page document URI observed by a snapshot differs from the
//     previously observed URI for that window (seq increments, `at` is the
//     observation time). The first observation is a baseline, not an epoch.
//   - a ref minted by a snapshot inside POST_NAV_SWAP_WINDOW_MS of that epoch
//     (or a text-addressed call resolved inside it), or
//   - a document-identity transition: the ref's document generation no longer
//     resolves (the bridge's stale_doc), which is a reload/navigation by
//     construction.
// Never a wall-clock sleep, never a site name.
//
// rev 13.2 (a live run): the text-addressed branch also
// bounded `now - minted_at` by the window, but that clock was read AFTER focus,
// the typing pass and the read-back, so a demo-length value (98 chars → typing
// floor 100 + 98 × 25 = 2550 ms) always exceeded the 2500 ms window and the
// gate was dead in the live flow. A target resolved by the very call that types
// is current by construction; its eligibility is epoch equality alone, and the
// replacement is proven by the swap's unique-different-node requirement.
export const POST_NAV_SWAP_WINDOW_MS = 2500;

/** Observe a page URI for a window. Returns the epoch record after the observation; `changed` is true when a navigation was observed. */
export function observePageEpoch(epochs, pid, uri, now = Date.now()) {
  if (typeof uri !== "string" || !uri) return { record: epochs.get(pid) || null, changed: false };
  const current = epochs.get(pid);
  if (!current) {
    const record = { seq: 0, uri, at: now };
    epochs.set(pid, record);
    return { record, changed: false };
  }
  if (current.uri === uri) return { record: current, changed: false };
  const record = { seq: current.seq + 1, uri, at: now };
  epochs.set(pid, record);
  return { record, changed: true };
}

/**
 * Should type_into_element spend its ONE post-navigation re-resolve cycle?
 * `minted` is the provenance of the ACTUAL resolved target ({ page_epoch,
 * minted_at }): for a ref-addressed call the caller's pre-existing ref (its
 * snapshot stamp decides — a ref found on a settled page stays ineligible);
 * for a text-addressed call (`resolvedNow`) the node this very call resolved
 * moments before typing, which is judged ONLY by being minted in the CURRENT
 * observed epoch: never by the epoch's age (rev 13.1) and never by a clock
 * that includes the typing and read-back (rev 13.2).
 * `epoch` is the window's current record; `docTransition` is true when the
 * ref's document generation failed to resolve (stale_doc).
 */
export function postNavigationRefSwapEligible({ minted = null, epoch = null, now = Date.now(), docTransition = false, resolvedNow = false, windowMs = POST_NAV_SWAP_WINDOW_MS } = {}) {
  if (docTransition === true) return { eligible: true, reason: "document-identity-transition" };
  if (!epoch || !(epoch.seq > 0)) return { eligible: false, reason: "no-observed-navigation" };
  if (resolvedNow === true) {
    if (!minted || minted.page_epoch !== epoch.seq) return { eligible: false, reason: "resolution-not-in-current-epoch" };
    return { eligible: true, reason: "resolved-now-in-current-epoch" };
  }
  if (!minted) return { eligible: false, reason: "no-target-provenance" };
  if (minted.page_epoch !== epoch.seq) return { eligible: false, reason: "ref-from-an-earlier-epoch" };
  if (typeof minted.minted_at !== "number" || minted.minted_at - epoch.at > windowMs) return { eligible: false, reason: "ref-minted-after-the-settle-window" };
  return { eligible: true, reason: "ref-minted-within-post-navigation-window" };
}

/**
 * A ref read BEFORE the page's latest observed address change (a size button, "Select Size 8 (8)",
 * changed the URL, the next click pressed the "Add to bag" ref from the read before it and nothing happened — the tool
 * called it merely UNVERIFIED). Such a ref must be re-found in the current page or refused, never pressed as it was.
 * `minted` is the ref's stamp ({ page_epoch }), `epoch` the window's current record. Pure.
 */
export function refFromEarlierEpoch(minted, epoch) {
  return !!(minted && epoch && typeof minted.page_epoch === "number" && typeof epoch.seq === "number" && minted.page_epoch < epoch.seq);
}

/** The one control in `elements` that is the same labelled control: exact role AND exact name, in the page document,
 * with an identity. Null unless exactly one — duplicates (a sticky bar's twin, a rail's) stay refused. Pure. */
export function sameControlIn(elements, { role, name }) {
  const same = (elements || []).filter((el) => el && el.role === role && el.name === name && el.doc_class === "page" && el.obj_path);
  return same.length === 1 ? same[0] : null;
}
