// Pure parsing of a sway `get_tree` document, for DIAGNOSTICS only.
//
// This exists because the headless backend resolves its Chromium window PID
// exactly once, at spawn, and freezes it into HEADLESS_CHROMIUM_PID. Nothing
// re-resolves it, and the headless listWindows() returns a fixed stub, so if
// the window's owning process ever changes the harness asks about the original
// PID forever and every AT-SPI lookup misses. The hyprland backend re-reads
// hyprctl on every call and self-heals; headless structurally cannot notice.
//
// So when a lookup misses we want to SAY what the compositor currently reports.
// Nothing here changes behaviour: it reads PIDs and nothing else.
//
// PIDs ONLY, deliberately. A sway node also carries `name`, `title` and
// window_properties.title, and those are PAGE-CONTROLLED — a site picks its own
// document title. None of them is read here, so no page text can reach a
// diagnostic string.

const MAX_DEPTH = 64;
const MAX_NODES = 4096;

/** Every distinct Chromium window PID the tree reports, sorted. Malformed input
 * yields [] rather than throwing: a diagnostic must never become a second
 * failure. Depth and node budgets bound a pathological or cyclic document. */
export function chromiumWindowPids(tree) {
  const found = new Set();
  let visited = 0;
  const walk = (node, depth) => {
    if (visited >= MAX_NODES || depth > MAX_DEPTH) return;
    if (!node || typeof node !== "object") return;
    visited += 1;
    const isChromium = node.app_id === "chromium"
      || (node.window_properties && typeof node.window_properties === "object"
          && String(node.window_properties.class || "").toLowerCase() === "chromium");
    if (isChromium && Number.isInteger(node.pid) && node.pid > 0) found.add(node.pid);
    for (const key of ["nodes", "floating_nodes"]) {
      const children = node[key];
      if (!Array.isArray(children)) continue;
      for (const child of children) walk(child, depth + 1);
    }
  };
  walk(tree, 0);
  return [...found].sort((a, b) => a - b);
}

/** The SOLE Chromium window PID, or an explicit non-answer.
 * Fails closed on ambiguity: with more than one Chromium window there is no
 * single "the window" to compare the frozen PID against, and guessing which one
 * is meant is exactly the kind of assumption this diagnostic exists to replace.
 * Returns { state: "one", pid } | { state: "absent" } | { state: "ambiguous", count }. */
export function soleChromiumWindowPid(tree) {
  const pids = chromiumWindowPids(tree);
  if (pids.length === 0) return { state: "absent" };
  if (pids.length > 1) return { state: "ambiguous", count: pids.length };
  return { state: "one", pid: pids[0] };
}
