#!/usr/bin/env python3
"""Pure tests for masked_match (atspi_bridge.py): a password field verifies only by its mask length."""
from atspi_bridge import masked_match
cases = [
    ("abc123", "•" * 6, True),
    ("abc123", "●" * 6, True),
    ("abc123", "•" * 5, False),     # a character did not land
    ("abc123", "abc123", False),         # plain text is not a mask (exact compare handles that)
    ("", "", False),
    ("abc", "•a•", False),
]
fails = [c for c in cases if masked_match(c[0], c[1]) != c[2]]
for c in fails: print("FAIL", c)
print(f"{len(cases) - len(fails)}/{len(cases)} pass")
raise SystemExit(1 if fails else 0)
