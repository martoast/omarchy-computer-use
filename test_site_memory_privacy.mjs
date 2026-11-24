import assert from "node:assert/strict";
import { isPrivateLocatorName, scrubPrivateLocators, isReviewControlName, isUnrememberableName } from "./site_memory_privacy.mjs";

assert.equal(isPrivateLocatorName("Ship to location: 12345"), true);
assert.equal(isPrivateLocatorName("Deliver to 12345-6789"), true);
assert.equal(isPrivateLocatorName("157 Example Avenue"), true);
assert.equal(isPrivateLocatorName("Change shipping address"), false);
assert.equal(isPrivateLocatorName("ASICS GEL-1130"), false);
const map = { nav: { private: { name: "Deliver to 12345" }, safe: { name: "Change location" } }, fields: { private: { name: "12345" }, safe: { name: "Zip code" } } };
scrubPrivateLocators(map);
assert.deepEqual(Object.keys(map.nav), ["safe"]);
assert.deepEqual(Object.keys(map.fields), ["safe"]);

// Review controls carry other shoppers' names (lead 2026-10-01): never remembered; ordinary controls are.
for (const n of ["Yes: 0 people found this review by Johnny O helpful.", "No: 0 people did not find this review helpful.", "Report review from Martha", "View more review text from Quentin", "Verified Purchase information"]) {
  assert.equal(isReviewControlName(n), true, n); assert.equal(isUnrememberableName(n), true, n);
}
for (const n of ["Add to bag", "Helpful Tips", "Reviews (6010)", "Shop by Category", "Size Guide"]) assert.equal(isUnrememberableName(n), false, n);
const rmap = { nav: { "button::Yes: 0 people found this review by Shoe lover helpful.": { role: "button", name: "Yes: 0 people found this review by Shoe lover helpful." }, "button::Add to bag": { role: "button", name: "Add to bag" } }, fields: {} };
scrubPrivateLocators(rmap);
assert.deepEqual(Object.keys(rmap.nav), ["button::Add to bag"], "a review button is dropped on load; a normal button is kept");
console.log("site-memory privacy tests passed");
