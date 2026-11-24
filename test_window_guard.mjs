// The window guard (window_guard.mjs) over sway get_tree fixtures with a scripted swaymsg: the store
// window is learned when alone, extras are killed (bounded) and the store refocused, a vanished store
// is reported, and a compositor that does not answer is reported rather than thrown. No compositor.
import test from "node:test";
import assert from "node:assert/strict";
import { chromiumWindows, planSingleWindow, enforceSingleWindow, MAX_CLOSES_PER_CALL } from "./window_guard.mjs";

const con = (id, { pid = 4242, focused = false, app_id = "chromium", title = "page-controlled title" } = {}) => ({ id, pid, focused, app_id, name: title, nodes: [], floating_nodes: [] });
const tree = (...cons) => ({ id: 1, nodes: [{ id: 2, nodes: [{ id: 3, type: "workspace", nodes: cons, floating_nodes: [] }] }] });

test("chromiumWindows: every Chromium toplevel with id, pid and focus — by app_id or X11 class; other apps and malformed nodes are skipped", () => {
  assert.deepEqual(chromiumWindows(tree(con(10, { focused: true }), con(11, { pid: 77 }), { id: 12, app_id: "foot", nodes: [] }, { id: 13, window_properties: { class: "Chromium" }, pid: 5 })), [
    { id: 10, pid: 4242, focused: true }, { id: 11, pid: 77, focused: false }, { id: 13, pid: 5, focused: false },
  ]);
  assert.deepEqual(chromiumWindows(null), []);
  assert.deepEqual(chromiumWindows({ nodes: "nope" }), []);
});

test("planSingleWindow: alone = the store (learned); with a remembered id the others are extras (bounded) and a vanished store is missing; two windows and no memory is ambiguous", () => {
  assert.deepEqual(planSingleWindow(tree(con(10)), null), { store: 10, extras: [], missing: false, windows: 1, learned: true });
  assert.deepEqual(planSingleWindow(tree(con(10), con(11)), null), { store: null, extras: [], missing: false, windows: 2, learned: false, ambiguous: true });
  assert.deepEqual(planSingleWindow(tree(), null), { store: null, extras: [], missing: true, windows: 0, learned: false, ambiguous: false });
  assert.deepEqual(planSingleWindow(tree(con(10, { focused: false }), con(11, { focused: true })), 10), { store: 10, extras: [11], missing: false, windows: 2, learned: false, storeFocused: false });
  // The learned store window is gone: survivors are NOT extras to kill (a Gap-family store recreates its
  // toplevel under a new id on a same-window PDP nav). Report missing with the surviving count; the caller re-learns.
  assert.deepEqual(planSingleWindow(tree(con(11)), 10), { store: null, extras: [], missing: true, windows: 1, learned: false, storeFocused: false });
  assert.deepEqual(planSingleWindow(tree(con(11), con(12)), 10), { store: null, extras: [], missing: true, windows: 2, learned: false, storeFocused: false });
  const many = planSingleWindow(tree(con(10), ...Array.from({ length: 12 }, (_, i) => con(20 + i))), 10);
  assert.equal(many.extras.length, MAX_CLOSES_PER_CALL);
  assert.throws(() => planSingleWindow(tree(con(10)), 0), RangeError);
});

test("enforceSingleWindow: extras are killed through swaymsg and the store refocused; nothing to do keeps the store focused; a missing store and a failed query are reported, never thrown", async () => {
  const calls = [];
  const swaymsg = async (args) => { calls.push(args.join(" ")); };
  const popup = await enforceSingleWindow({ storeConId: 10, query: async () => JSON.stringify(tree(con(10), con(11, { focused: true }))), swaymsg });
  assert.deepEqual(popup, { available: true, windows: 2, store: 10, closed: [11], focused: true, missing: false, learned: false, ambiguous: false });
  assert.deepEqual(calls, ["[con_id=11] kill", "[con_id=10] focus"]);
  calls.length = 0;
  const quiet = await enforceSingleWindow({ storeConId: 10, query: async () => JSON.stringify(tree(con(10, { focused: true }))), swaymsg });
  assert.deepEqual(quiet, { available: true, windows: 1, store: 10, closed: [], focused: true, missing: false, learned: false, ambiguous: false });
  assert.deepEqual(calls, [], "a focused sole store window needs no command");
  const unfocused = await enforceSingleWindow({ storeConId: 10, query: async () => JSON.stringify(tree(con(10, { focused: false }))), swaymsg });
  assert.equal(unfocused.focused, true); assert.deepEqual(calls, ["[con_id=10] focus"]);
  const learned = await enforceSingleWindow({ query: async () => JSON.stringify(tree(con(10, { focused: true }))), swaymsg });
  assert.equal(learned.learned, true); assert.equal(learned.store, 10);
  const gone = await enforceSingleWindow({ storeConId: 10, query: async () => JSON.stringify(tree()), swaymsg });
  assert.deepEqual([gone.missing, gone.windows, gone.store], [true, 0, null]);
  // Learned store missing but a survivor remains (the store's recreated toplevel under a new id): report
  // missing, kill NOTHING — the caller re-learns it rather than destroying the live store window.
  calls.length = 0;
  const recreated = await enforceSingleWindow({ storeConId: 10, query: async () => JSON.stringify(tree(con(11, { focused: true }))), swaymsg });
  assert.deepEqual([recreated.missing, recreated.windows, recreated.store, recreated.closed], [true, 1, null, []]);
  assert.deepEqual(calls, [], "a missing anchor never kills the survivors");
  const failing = await enforceSingleWindow({ storeConId: 10, query: async () => { throw new Error("no socket"); }, swaymsg });
  assert.deepEqual(failing, { available: false, reason: "sway_query_failed", windows: 0, store: 10, closed: [], focused: false, missing: false });
  const killFails = await enforceSingleWindow({ storeConId: 10, query: async () => JSON.stringify(tree(con(10), con(11))), swaymsg: async (a) => { if (a[1] === "kill") throw new Error("gone"); } });
  assert.deepEqual([killFails.closed, killFails.focused], [[], true], "a container that vanished is not counted as closed; the store is still refocused");
  await assert.rejects(() => enforceSingleWindow({}), TypeError);
});
