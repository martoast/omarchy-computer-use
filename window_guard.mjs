// The manual session's window guard (REMOTE_BROWSER_PLAN.md §(d), piece 3): the store
// window must stay the ONLY Chromium toplevel on the instance. A popup or a new window
// (live: a survey popup opened by a click became a second toplevel, the nested sway
// tiled it beside the store and the customer's typing went to the survey) is closed
// through the instance's own compositor and the store window is refocused. Pure
// planning over a sway `get_tree` document plus one injected `swaymsg` runner; the
// instance's socket (HEADLESS_SWAYSOCK) is the caller's. PIDs, ids and counts only —
// a node's title is page-controlled and is never read.
const MAX_DEPTH = 64;
const MAX_NODES = 4096;
export const MAX_CLOSES_PER_CALL = 8;

// Every Chromium toplevel container in the tree: {id, pid, focused}, in document order.
export function chromiumWindows(tree) {
  const out = [];
  let visited = 0;
  const walk = (node, depth) => {
    if (visited >= MAX_NODES || depth > MAX_DEPTH || !node || typeof node !== "object") return;
    visited += 1;
    const isChromium = node.app_id === "chromium"
      || (node.window_properties && typeof node.window_properties === "object" && String(node.window_properties.class || "").toLowerCase() === "chromium");
    if (isChromium && Number.isInteger(node.id) && node.id > 0) out.push({ id: node.id, pid: Number.isInteger(node.pid) ? node.pid : null, focused: node.focused === true });
    for (const key of ["nodes", "floating_nodes"]) {
      const children = node[key];
      if (!Array.isArray(children)) continue;
      for (const child of children) walk(child, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

// The plan: which container is the store window, which are extras to close, whether the store is gone.
// With no remembered store id and exactly one window, that window IS the store (learned at driver init).
export function planSingleWindow(tree, storeConId = null) {
  const windows = chromiumWindows(tree);
  if (storeConId === null) {
    if (windows.length === 1) return { store: windows[0].id, extras: [], missing: false, windows: 1, learned: true };
    return { store: null, extras: [], missing: windows.length === 0, windows: windows.length, learned: false, ambiguous: windows.length > 1 };
  }
  if (!Number.isInteger(storeConId) || storeConId <= 0) throw new RangeError("invalid store window id");
  const store = windows.find((w) => w.id === storeConId) ?? null;
  // The learned store window is gone: do NOT list the survivors as extras to kill. A Gap-family store recreates
  // its toplevel SURFACE on a heavy same-window PDP nav, so a surviving window is the store under a NEW id, not a
  // popup — killing it here would destroy the live store window. Report missing and let the caller re-learn a
  // sole on-store window. Extras are only ever closed while the anchor store window is still present.
  if (store === null) return { store: null, extras: [], missing: true, windows: windows.length, learned: false, storeFocused: false };
  const extras = windows.filter((w) => w.id !== storeConId).map((w) => w.id).slice(0, MAX_CLOSES_PER_CALL);
  return { store: store.id, extras, missing: false, windows: windows.length, learned: false, storeFocused: store.focused };
}

// Read the tree, close every extra toplevel, refocus the store. `swaymsg(args)` runs the instance's
// swaymsg (the caller binds SWAYSOCK); `query()` returns the get_tree JSON text. Never throws for a
// compositor that answers oddly: the result says what was observed and what was done.
export async function enforceSingleWindow({ storeConId = null, query, swaymsg } = {}) {
  if (typeof query !== "function" || typeof swaymsg !== "function") throw new TypeError("query and swaymsg are required");
  let tree;
  try { tree = JSON.parse(await query()); } catch { return { available: false, reason: "sway_query_failed", windows: 0, store: storeConId, closed: [], focused: false, missing: false }; }
  const plan = planSingleWindow(tree, storeConId);
  const closed = [];
  for (const id of plan.extras) {
    try { await swaymsg([`[con_id=${id}]`, "kill"]); closed.push(id); } catch { /* a container that vanished between the read and the kill */ }
  }
  let focused = false;
  if (plan.store !== null && (closed.length || plan.storeFocused === false)) {
    try { await swaymsg([`[con_id=${plan.store}]`, "focus"]); focused = true; } catch { focused = false; }
  } else if (plan.store !== null) focused = true;
  return { available: true, windows: plan.windows, store: plan.store, closed, focused, missing: plan.missing, learned: plan.learned === true, ambiguous: plan.ambiguous === true };
}
