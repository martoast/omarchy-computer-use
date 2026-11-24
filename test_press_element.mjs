// pressRefusalFor (index.js): press_element's read-only gate — page provenance, opener roles only, never a link,
// never a control that changes the cart, the order or the account.
import assert from "node:assert/strict";
import { pressRefusalFor } from "./index.js";
import { prepareActionRefusal } from "./purchase_guard.mjs";
const p = (name, role = "button", doc_class = "page") => pressRefusalFor({ name, role, doc_class });
assert.equal(p("Select a size"), null);
assert.equal(p("Size: Choose", "combo box"), null);
assert.equal(p("Color", "push button"), null);
assert.equal(p("Details", "page tab"), null);
assert.equal(p("Waist", "toggle button"), null);
assert.match(p("Close", "push button", "chrome"), /press_element will not press it/, "browser UI is never pressed");
assert.match(p("Select a size", "button", "unknown"), /Refused/, "unknown provenance fails closed");
assert.match(p("Size guide", "link"), /not an option opener/, "links stay click_element's");
assert.match(p("M", "radio button"), /not an option opener/);
for (const name of ["Add to Cart", "ADD TO BAG", "Place order", "Buy now", "Pay now", "Checkout", "Continue to shipping", "Remove", "Sign In", "Notify me", "Shop Pay"]) {
  assert.match(p(name) || "", /Refused/, `${name} is refused`);
}
assert.match(prepareActionRefusal({ name: "press_element", targetName: "Place order" }) || "", /purchase guard/);
console.log("PASS — press_element gate");
process.exit(0);
