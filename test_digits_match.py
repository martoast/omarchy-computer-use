#!/usr/bin/env python3
"""Pure tests for digits_match (atspi_bridge.py): a phone the page reformats still verifies; nothing else loosens."""
from atspi_bridge import digits_match
cases = [
    ("5550100199", "(555) 010-0199", True),
    ("5550100199", "+1 555-010-0199", True),
    ("+15550100199", "(555) 010-0199", False),   # the page dropped digits we typed: not the same value
    ("5550100199", "555-010-0198", False),
    ("5550100199", "", False),
    ("12345", "12345-6789", False),               # short values stay strict (prefix rule handles ZIP+4)
    ("5550100199", "Phone 5550100199", False),    # letters: not a reformat
    ("5550100199", "9995550100199 x", False),     # too many extra digits
]
fails = 0
for needle, text, want in cases:
    got = digits_match(needle, text)
    if got != want:
        fails += 1
        print(f"FAIL {needle!r} vs {text!r}: {got}")
print(f"{'PASS' if not fails else 'FAIL'} — {len(cases) - fails}/{len(cases)}")
raise SystemExit(1 if fails else 0)
