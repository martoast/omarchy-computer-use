// Code-level purchase boundary for prepare mode.
//
// The prepare prompt already forbids placing an order; this module makes the
// boundary hold even when the model ignores the prompt. fast_agent consults it
// before dispatching every browser action in a prepare run, and a refusal is
// answered to the model as a tool error — the action never reaches the MCP
// server.
//
// What it refuses:
//   * clicking a control whose accessible name submits an order or a payment,
//     or opens an express/wallet payment (PayPal, Shop Pay, Apple Pay, ...);
//   * typing into, or selecting in, a payment-card field;
//   * typing a delivery/contact field by hand (only fill_private_delivery_address
//     may enter those, so the model never handles the values);
//   * once a payment form has been seen: coordinate clicks, raw typing and
//     Enter/space, because none of them can be judged by name.
//
// Reaching the payment step itself is allowed (some stores only show tax
// there); acting on it is not.

const PURCHASE_CONTROL = new RegExp([
  String.raw`\bplace (?:your |my )?order\b`,
  String.raw`\bbuy (?:it )?now\b`,
  String.raw`\bpay now\b`,
  String.raw`\bpay \$`,
  String.raw`\bcomplete (?:your |my )?(?:order|purchase|payment)\b`,
  String.raw`\bconfirm (?:and pay|purchase|order|payment)\b`,
  String.raw`\bsubmit (?:your )?(?:order|payment)\b`,
  String.raw`\breview (?:and|&) pay\b`,
  String.raw`\bfinish (?:order|purchase)\b`,
  String.raw`\border now\b`,
  String.raw`^\s*(?:purchase|pay)\s*$`,
  // An order button named by its id rather than its label (live Nordstrom's one-page checkout: "review-order-bottom",
  // "review-order-right" are its Place Order buttons).
  String.raw`^\s*(?:review|place|submit|complete)-order(?:-[a-z]+)?\s*$`,
  // express and wallet payments leave the store's reversible checkout
  String.raw`\b(?:pay ?pal|shop ?pay|apple ?pay|google ?pay|g ?pay|amazon ?pay|venmo|afterpay|klarna|affirm|sezzle|zip pay)\b`,
].join("|"), "i");

// What marks the PAYMENT STEP itself: an order-completing control. Not the wallet and pay-later buttons (every
// product page has "Pay in 4 with Klarna" / Afterpay: live J.Crew 2026-09-28 tightened the guard on its product page
// and then refused the typing its size list needed) and not "Buy now" (a product-page express button). Those stay
// refused as CLICKS (PURCHASE_CONTROL); they just do not mean "this is the payment step".
const PAYMENT_STEP_CONTROL = new RegExp([
  String.raw`\bplace (?:your |my )?order\b`,
  String.raw`\bpay now\b`,
  String.raw`\bpay \$`,
  String.raw`\bcomplete (?:your |my )?(?:order|purchase|payment)\b`,
  String.raw`\bconfirm (?:and pay|purchase|order|payment)\b`,
  String.raw`\bsubmit (?:your )?(?:order|payment)\b`,
  String.raw`\breview (?:and|&) pay\b`,
  String.raw`\bfinish (?:order|purchase)\b`,
  String.raw`^\s*(?:purchase|pay)\s*$`,
  String.raw`^\s*(?:review|place|submit|complete)-order(?:-[a-z]+)?\s*$`,
].join("|"), "i");

const CARD_FIELD = /\b(?:card ?number|credit ?card|debit ?card|cvv|cvc|csc|security code|expir\w*|exp\.? date|mm ?\/ ?yy|name on card|cardholder|gift ?card|pin)\b/i;

const PRIVATE_FIELD = /\b(?:first name|last name|full name|street|address|apt|apartment|suite|city|zip|postal|post code|postcode|phone|mobile|telephone|e-?mail)\b/i;
// Store search and promo-code boxes are legitimate model typing targets even
// when their labels mention an address word ("Search by city or zip").
const PRIVATE_FIELD_EXEMPT = /\b(?:search|promo|coupon|discount|gift card|address and search bar)\b/i;

const PAYMENT_FORM_SEEN = /\b(?:card ?number|credit card number|security code \(cvv\)|cvv|name on card)\b/i;

const ENTER_LIKE = /^(?:return|enter|kp_enter|space)$/i;

export function isPurchaseControl(name) {
  return PURCHASE_CONTROL.test(String(name || ""));
}

export function isCardField(name) {
  return CARD_FIELD.test(String(name || ""));
}

export function isPrivateDeliveryField(name) {
  const text = String(name || "");
  return PRIVATE_FIELD.test(text) && !PRIVATE_FIELD_EXEMPT.test(text);
}

/** True when page text shows a payment-card form (the payment stage). */
// A saved card on file ("Mastercard *8365", "Visa ending in 4242").
const SAVED_CARD = /\b(?:visa|mastercard|master card|amex|american express|discover)\b[^"\n]{0,20}(?:\*{1,4}\s?\d{4}|ending (?:in )?\d{4}|•{2,}\s?\d{4})/i;

export function showsPaymentForm(pageText) {
  const text = String(pageText || "");
  // A card FIELD, not the words anywhere (live Uniqlo 2026-09-28: the guard tightened on the cart page, three
  // turns in, and then refused the coordinate clicks its size buttons needed). A gift-card box is not payment.
  const fields = [...text.matchAll(/^\S+\t(?:entry|password text|text|spin button|combo box)\t"([^"]*)"/gm)].map((m) => m[1]);
  if (fields.some((name) => PAYMENT_FORM_SEEN.test(name) && !/\bgift\b/i.test(name))) return true;
  // A one-page checkout with a SAVED card has no card fields but can place the order in one press (live Sephora
  // signed in, 2026-09-27: "Mastercard *8365" and a live "Place order for $16.31" on the shipping page). Either one
  // on the page is the payment step: Enter, space and coordinate clicks are refused from here on.
  if (SAVED_CARD.test(text)) return true;
  return [...text.matchAll(/^\S+\t(?:button|push button|link)\t"([^"]*)"/gm)].some((m) => PAYMENT_STEP_CONTROL.test(m[1]));
}

/**
 * Judge one prepare-mode browser action.
 * @returns {null | string} null to allow, or the refusal text for the model.
 */
export function prepareActionRefusal({ name, args = {}, targetName = "", paymentStageSeen = false }) {
  const target = String(targetName || args.text || "");
  if ((name === "click_element" || name === "press_element") && isPurchaseControl(target)) {
    return `Refused by the purchase guard: "${target.slice(0, 80)}" submits an order or a payment. This run never buys anything. Report the totals you can see now with report_cart_preparation.`;
  }
  // An address-verification pop-up never gets its
  // suggestion taken; the address stays exactly as entered.
  if (name === "click_element" && /\b(?:use|select|choose|accept|confirm)\b[^"]{0,20}\b(?:suggested|recommended|corrected|verified|standardi[sz]ed)\b|\b(?:suggested|recommended|corrected)\s+address\b/i.test(target)) {
    return `Refused: "${target.slice(0, 80)}" takes the store's suggested address. Keep the address exactly as entered: choose the option that keeps it ("Use address as entered", "Keep original address"), or close the pop-up with its Close/X button.`;
  }
  if ((name === "type_into_element" || name === "select_option") && isCardField(target)) {
    return "Refused by the purchase guard: payment-card fields are never touched. Report the totals you can see now; if tax is only disclosed after payment, report blockers [\"payment_stage_required_for_total\"].";
  }
  // Choosing the state or country is address data too (live Victoria's Secret:
  // the model tried to pick a state itself after the private fill).
  if (name === "select_option" && /\b(?:state|province|region|country|territory)\b/i.test(target)) {
    return `Refused: "${target.slice(0, 80)}" is part of the delivery address. Only fill_private_delivery_address sets it. If the form shows the wrong value, report it (blockers ["destination_unverified"]) instead of changing it.`;
  }
  if (name === "type_into_element" && isPrivateDeliveryField(target)) {
    return `Refused: "${target.slice(0, 80)}" is a delivery/contact field. Only fill_private_delivery_address may fill it (it fills every matching field on the visible form). Call it now instead of typing.`;
  }
  if (paymentStageSeen) {
    if (name === "click" || name === "type_text") {
      return "Refused by the purchase guard: the payment step is visible, so coordinate clicks and raw typing are disabled. Use read_page and report the totals you can see.";
    }
    if (name === "key_press" && ENTER_LIKE.test(String(args.key || "").trim())) {
      return "Refused by the purchase guard: Enter/space are disabled on the payment step because they can submit the order form. Report the totals you can see.";
    }
  }
  return null;
}
