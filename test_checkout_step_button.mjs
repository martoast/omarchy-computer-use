// isCheckoutStepButton (index.js): which clicks get the longer (7 s) transition watch.
import assert from "node:assert/strict";
import { isCheckoutStepButton } from "./index.js";
const b = (name, role = "button") => isCheckoutStepButton({ name, role });
assert.equal(b("Checkout"), true);
assert.equal(b("Check Out as a Guest"), true);
assert.equal(b("CONTINUE TO SHIPPING"), true);
assert.equal(b("Use This Address"), true);
assert.equal(b("Go to billing"), true);
assert.equal(b("Place order for $15.00"), false, "never an order-placing button");
assert.equal(b("Pay now"), false);
assert.equal(b("Complete order"), false);
assert.equal(b("Add to Basket"), false);
assert.equal(b("Checkout", "link"), false, "links have their own rule");
console.log("PASS — checkout step buttons");
process.exit(0);
