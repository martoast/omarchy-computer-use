// node test_key_combo.mjs — a key combo written as one key ("Alt+Left") is split into its modifiers (prod Amazon checkout 2026-10-06).
import assert from "node:assert/strict";
import { splitKeyCombo, keyPressAction } from "./index.js";

assert.deepEqual(splitKeyCombo("Alt+Left"), { key: "Left", modifiers: ["alt"] });
assert.deepEqual(splitKeyCombo("ctrl+shift+Tab"), { key: "Tab", modifiers: ["ctrl", "shift"] });
assert.deepEqual(splitKeyCombo("Control+a", ["ctrl"]), { key: "a", modifiers: ["ctrl"] }, "no modifier twice");
assert.deepEqual(splitKeyCombo("Left", ["alt"]), { key: "Left", modifiers: ["alt"] }, "already split: unchanged");
assert.deepEqual(splitKeyCombo("+"), { key: "+", modifiers: [] }, "a lone plus is a key");
assert.deepEqual(splitKeyCombo("ctrl++"), { key: "ctrl++", modifiers: [] }, "neg: a key that only ends in + is left alone");
assert.deepEqual(splitKeyCombo("Foo+Left"), { key: "Foo+Left", modifiers: [] }, "neg: an unknown modifier is not guessed");

// the action presses the split key with the modifiers held
const runs = [];
const r = await keyPressAction({ key: "Alt+Left" }, { runKey: async (a) => runs.push(a), store: { invalidateAll() {}, size: 0 } });
assert.deepEqual(runs[0], ["-s", "100", "-M", "alt", "-k", "Left", "-m", "alt"]);
assert.equal(r.content[0].text, "Pressed alt+Left");
console.log("test_key_combo: ok");
process.exit(0);
