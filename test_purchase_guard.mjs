import assert from "node:assert/strict";
import { isPurchaseControl, isCardField, isPrivateDeliveryField, showsPaymentForm, prepareActionRefusal } from "./purchase_guard.mjs";

// Order and payment submitters, as retailers label them.
for (const name of ["Place order", "Place Your Order", "Buy Now", "Pay now", "Pay $143.31", "Complete order", "Complete Purchase",
  "Confirm and pay", "Submit Order", "Review & Pay", "Order now", "Purchase", "PayPal Checkout", "Shop Pay", "Buy with Apple Pay",
  "Google Pay", "Checkout with Afterpay", "Pay with Klarna"]) {
  assert.ok(isPurchaseControl(name), `${name} must be refused`);
}
// The reversible checkout path stays open.
for (const name of ["Checkout", "Check Out", "Continue to shipping", "Continue to payment", "Continue", "Continue as Guest",
  "Add to Cart", "View cart", "Apply", "Purchase protection details", "Shipping", "Save and continue"]) {
  assert.equal(isPurchaseControl(name), false, `${name} must be allowed`);
}

for (const name of ["Card number", "Credit Card Number", "CVV", "Security code", "Expiration date (MM / YY)", "Name on card", "Gift card or discount code"]) {
  assert.ok(isCardField(name), name);
}
assert.equal(isCardField("Shipping method"), false);
assert.equal(isCardField("ZIP Code"), false);

for (const name of ["First name", "Last Name", "Address", "Apartment, suite, etc. (optional)", "City", "ZIP code", "Phone", "Email", "Email address", "Mobile Phone Number"]) {
  assert.ok(isPrivateDeliveryField(name), name);
}
for (const name of ["Search", "Search by city or zip", "Discount code or gift card", "Address and search bar", "Promo code"]) {
  assert.equal(isPrivateDeliveryField(name), false, name);
}

assert.ok(showsPaymentForm("e12\tentry\t\"Card number\"\ne13\tentry\t\"Expiration date\""));
assert.equal(showsPaymentForm("Order summary Subtotal $98.00 Shipping $6.95"), false);

// prepareActionRefusal
assert.match(prepareActionRefusal({ name: "click_element", targetName: "Place order" }), /purchase guard/);
assert.equal(prepareActionRefusal({ name: "click_element", targetName: "Continue to payment" }), null);
assert.match(prepareActionRefusal({ name: "click_element", args: { text: "Pay now" } }), /purchase guard/, "text-addressed clicks are judged too");
assert.match(prepareActionRefusal({ name: "type_into_element", targetName: "Card number" }), /payment-card/);
assert.match(prepareActionRefusal({ name: "select_option", targetName: "Expiration month" }), /payment-card/);
assert.match(prepareActionRefusal({ name: "type_into_element", targetName: "ZIP code" }), /fill_private_delivery_address/);
assert.equal(prepareActionRefusal({ name: "type_into_element", targetName: "Discount code" }), null);
// Before the payment step, coordinates/typing/Enter are ordinary tools.
assert.equal(prepareActionRefusal({ name: "click", args: { x: 10, y: 400 } }), null);
assert.equal(prepareActionRefusal({ name: "key_press", args: { key: "Return" } }), null);
// On the payment step they are refused.
assert.match(prepareActionRefusal({ name: "click", args: { x: 10, y: 400 }, paymentStageSeen: true }), /payment step/);
assert.match(prepareActionRefusal({ name: "type_text", args: { text: "x" }, paymentStageSeen: true }), /payment step/);
assert.match(prepareActionRefusal({ name: "key_press", args: { key: "Return" }, paymentStageSeen: true }), /Enter/);
assert.equal(prepareActionRefusal({ name: "key_press", args: { key: "Escape" }, paymentStageSeen: true }), null);
assert.equal(prepareActionRefusal({ name: "read_page", args: {}, paymentStageSeen: true }), null);

assert.match(prepareActionRefusal({ name: "select_option", targetName: "STATE *" }), /delivery address/);
assert.match(prepareActionRefusal({ name: "select_option", targetName: "Country/Region" }), /delivery address/);
assert.equal(prepareActionRefusal({ name: "select_option", targetName: "Size" }), null);
assert.equal(prepareActionRefusal({ name: "select_option", targetName: "Item Quantity" }), null);
// Address verification: the suggestion is never taken; the entered address is kept.
for (const t of ["Use Suggested Address", "Suggested Address", "Use recommended address", "Select corrected address"]) {
  if (!prepareActionRefusal({ name: "click_element", targetName: t })) throw new Error(`suggested-address click allowed: ${t}`);
}
for (const t of ["Use address as entered", "Keep original address", "Use my address", "Continue"]) {
  if (prepareActionRefusal({ name: "click_element", targetName: t })) throw new Error(`keep-as-entered click refused: ${t}`);
}

// A one-page checkout with a saved card (live Sephora signed in): no card fields, yet the payment step.
{
  const { showsPaymentForm } = await import("./purchase_guard.mjs");
  assert.equal(showsPaymentForm('e2\tstatic\t"Mastercard *8365"\t@1,2'), true);
  assert.equal(showsPaymentForm('e3\tbutton\t"Place order for $16.31"\t@1,3'), true);
  assert.equal(showsPaymentForm('e3\tbutton\t"Checkout"\t@1,3\ne4\theading\t"3. Payment"\t@1,4'), false);
}

// An order button named by its id (live Nordstrom): refused; a "Continue to review order" step button is not.
{
  const { isPurchaseControl } = await import("./purchase_guard.mjs");
  assert.equal(isPurchaseControl("review-order-bottom"), true);
  assert.equal(isPurchaseControl("review-order-right"), true);
  assert.equal(isPurchaseControl("Continue to review order"), false);
}
console.log("test_purchase_guard: ok");

// The payment step is a card FIELD, not the words on a page (live Uniqlo: its cart tightened the guard).
{
  const { showsPaymentForm } = await import("./purchase_guard.mjs");
  const assert = (await import("node:assert/strict")).default;
  assert.equal(showsPaymentForm('e1\tstatic\t"We accept all cards. CVV required at payment."\t@1,1'), false);
  assert.equal(showsPaymentForm('e1\tentry\t"Gift card number"\t@1,1'), false);
  assert.equal(showsPaymentForm('e1\tentry\t"Card number"\t@1,1'), true);
  assert.equal(showsPaymentForm('e1\tentry\t"Security code (CVV)"\t@1,1'), true);
  console.log("test_purchase_guard: card field, not card words: ok");
}

// Pay-later and wallet buttons on a product page do not make it the payment step (live J.Crew); clicking them is
// still refused.
{
  const { showsPaymentForm, isPurchaseControl } = await import("./purchase_guard.mjs");
  const assert = (await import("node:assert/strict")).default;
  assert.equal(showsPaymentForm('e1\tbutton\t"Pay in 4 interest-free payments with Klarna. Learn more"\t@1,1\ne2\tbutton\t"Buy now with PayPal"\t@1,2'), false);
  assert.equal(isPurchaseControl("Buy now with PayPal"), true);
  assert.equal(showsPaymentForm('e1\tbutton\t"Place order"\t@1,1'), true);
  assert.equal(showsPaymentForm('e1\tbutton\t"Pay $24.04"\t@1,1'), true);
  console.log("test_purchase_guard: wallet buttons are not the payment step: ok");
}
