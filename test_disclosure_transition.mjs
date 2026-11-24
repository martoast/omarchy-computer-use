import assert from "node:assert/strict";
import { diffDisclosureSignals } from "./disclosure_transition.js";

assert.deepEqual(diffDisclosureSignals({ linkKeys: ["Home|/"] }, { linkKeys: ["Home|/"], targetStates: ["focused"] }), []);
assert.deepEqual(diffDisclosureSignals({ targetStates: [] }, { targetStates: ["expanded"] }), ["target became expanded"]);
assert.deepEqual(diffDisclosureSignals({ targetStates: { expanded: false } }, { targetStates: { expanded: true } }), ["target became expanded"]);
assert.deepEqual(diffDisclosureSignals(
  { linkKeys: ["Home|/"] },
  { linkKeys: ["Home|/", "Sale|/collections/sale"] },
), ["new links: Sale|/collections/sale"]);
assert.deepEqual(diffDisclosureSignals(
  { linkKeys: [] },
  { linkKeys: ["Sale|/sale", "Sale|/sale"] },
), ["new links: Sale|/sale"]);

console.log("disclosure transition: 5 passed, 0 failed");
