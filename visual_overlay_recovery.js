export function classifyVisualOverlayRecovery({ beforeContent, expectedUrl, observedUrl, afterContent, afterDialogs } = {}) {
  let expected, observed;
  try { expected = new URL(expectedUrl); observed = new URL(observedUrl); } catch { return { success: false, reason: "url-unverified" }; }
  if (expected.origin !== observed.origin || expected.pathname.replace(/\/+$/, "") !== observed.pathname.replace(/\/+$/, "")) return { success: false, reason: "document-changed" };
  for (const [key, value] of expected.searchParams) if (observed.searchParams.get(key) !== value) return { success: false, reason: "document-changed" };
  if (beforeContent !== 0) return { success: false, reason: "page-was-already-readable" };
  if (afterDialogs !== 0) return { success: false, reason: "accessible-dialog-remains" };
  if (!(afterContent > 0)) return { success: false, reason: "page-still-unreadable" };
  return { success: true, reason: "page-readability-restored" };
}
