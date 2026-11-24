// node test_ref_epoch_stale.mjs — a ref read before the page changed address (a size button that changed the URL).
import assert from "node:assert/strict";
import { observePageEpoch, refFromEarlierEpoch, sameControlIn } from "./ref_epoch.js";

// The real sequence (paced probe 2026-09-30, 997 SL): read → "Select Size 8 (8)" → "Transition observed: url changed".
const before = "https://www.newbalance.com/pd/997-sl/MG997S.html?dwvar_MG997S_style=MG997SCG";
const after = "https://www.newbalance.com/pd/997-sl/MG997S.html?dwvar_MG997S_style=MG997SCG#dwvar_MG997S_size=8&dwvar_MG997S_style=MG997SCG&dwvar_MG997S_width=D&pid=MG997S&quantity=1";
const epochs = new Map();
observePageEpoch(epochs, 7, before, 1000);
const addRef = { role: "button", name: "Add to bag", obj_path: "/org/a11y/atspi/accessible/109", doc_gen: "/doc/1", page_epoch: epochs.get(7).seq };
assert.equal(refFromEarlierEpoch(addRef, epochs.get(7)), false, "same address: the ref stands");
const { changed } = observePageEpoch(epochs, 7, after, 2000);
assert.equal(changed, true, "the size click's address change is an epoch");
assert.equal(refFromEarlierEpoch(addRef, epochs.get(7)), true, "the Add-to-bag ref from the read before the size click is from an earlier epoch");
assert.equal(refFromEarlierEpoch({ ...addRef, page_epoch: epochs.get(7).seq }, epochs.get(7)), false, "neg: a ref read after the change stands");
assert.equal(refFromEarlierEpoch({ role: "button", name: "x" }, epochs.get(7)), false, "neg: an unstamped ref is not judged here");
assert.equal(refFromEarlierEpoch(addRef, null), false, "neg: no observed page, nothing to judge");

// Re-finding it in the current page: the read after the size click had exactly one "Add to bag" (e599 @1348,446).
const read2 = [
  { role: "button", name: "Select Size 8 (8) ", doc_class: "page", obj_path: "/a/568" },
  { role: "button", name: "Add to bag", doc_class: "page", obj_path: "/a/599", doc_gen: "/doc/1" },
  { role: "link", name: "Bag 0 Items", doc_class: "page", obj_path: "/a/777" },
];
assert.equal(sameControlIn(read2, { role: "button", name: "Add to bag" })?.obj_path, "/a/599", "the one Add to bag in the current page");
assert.equal(sameControlIn([...read2, { role: "button", name: "Add to bag", doc_class: "page", obj_path: "/a/1201" }], { role: "button", name: "Add to bag" }), null, "neg: two (a sticky bar's twin) → refused, never guessed");
assert.equal(sameControlIn(read2, { role: "button", name: "Add to Bag" }), null, "neg: another name is another control");
assert.equal(sameControlIn([{ role: "button", name: "Add to bag", doc_class: "browser", obj_path: "/b/1" }], { role: "button", name: "Add to bag" }), null, "neg: never the browser's own UI");
console.log("ref epoch stale tests passed");
