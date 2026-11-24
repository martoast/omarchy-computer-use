#!/usr/bin/env python3
"""Pure tests for field_value_status (atspi_bridge.py): what an address suggestion wrote counts, nothing else does."""
from atspi_bridge import field_value_status
cases = [
    ("12345", "12345", "exact", "match"),
    ("12345", "12345-6789", "exact", "match"),
    ("12345", "12346", "exact", "differs"),
    ("12345", "", "exact", "empty"),
    ("Springfield", "springfield", "exact", "match"),
    ("Springfield", "San Diego", "exact", "differs"),
    ("123 Main St", "123 Main Street", "street", "match"),
    ("123 Main St", "123 Main St.", "street", "match"),
    ("123 Main St", "123 Main Street", "exact", "differs"),
    ("123 Main St", "175 Main Ave", "street", "differs"),
    ("123 Main St", "157 Vine St", "street", "differs"),
    ("6195550123", "(619) 555-0123", "exact", "match"),
]
fails = 0
for expect, text, mode, want in cases:
    got = field_value_status(expect, text, mode)
    if got != want:
        fails += 1
        print(f"FAIL {expect!r} vs {text!r} ({mode}): {got} != {want}")
print(f"{len(cases) - fails}/{len(cases)} pass")
raise SystemExit(1 if fails else 0)
