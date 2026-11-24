#!/usr/bin/env python3
"""Pure unit tests for choose_checkable_action (no AT-SPI).
Run: python3 test_choose_checkable.py

The rule under test (issue #6): the DESIRED state is derived from the role --
a radio is always a request to select, a check box click is a toggle -- and the
action invoked must be the one matching that direction. An action set that
contradicts the derived desire is refused, never invoked."""
import sys
from atspi_bridge import choose_checkable_action

CHECK = [{"index": 0, "name": "check"}, {"index": 1, "name": "showContextMenu"}]
UNCHECK = [{"index": 0, "name": "uncheck"}, {"index": 1, "name": "showContextMenu"}]
DODEFAULT = [{"index": 0, "name": "doDefault"}, {"index": 1, "name": "showContextMenu"}]

cases = [
    # --- check box: a click toggles, so desired = NOT current -----------------
    ("unchecked check box -> invoke 'check'",
     CHECK, "check box", False,
     {"decision": "invoke", "index": 0, "name": "check", "desired": True}),
    ("checked check box -> invoke 'uncheck' (toggle-off is a real outcome)",
     UNCHECK, "check box", True,
     {"decision": "invoke", "index": 0, "name": "uncheck", "desired": False}),
    # --- radio: always a request to SELECT ------------------------------------
    ("unchecked radio -> invoke 'check'",
     CHECK, "radio button", False,
     {"decision": "invoke", "index": 0, "name": "check", "desired": True}),
    # The critical one: an already-selected radio exposes ONLY 'uncheck'
    # (measured). Choosing an action at all would DESELECT it, so the desired
    # state must short-circuit before any action is considered.
    ("already-selected radio -> already_satisfied, never invoke",
     UNCHECK, "radio button", True,
     {"decision": "already_satisfied", "desired": True}),
    ("radio offering ONLY 'uncheck' while unchecked -> refuse (contradiction)",
     UNCHECK, "radio button", False,
     {"decision": "no_activation_action", "desired": True, "want": "check"}),
    ("check box offering ONLY 'uncheck' while unchecked -> refuse (contradiction)",
     UNCHECK, "check box", False,
     {"decision": "no_activation_action", "desired": True, "want": "check"}),
    ("checked check box offering ONLY 'check' -> refuse (contradiction)",
     CHECK, "check box", True,
     {"decision": "no_activation_action", "desired": False, "want": "uncheck"}),
    # --- doDefault stays refused for checkables --------------------------------
    ("ARIA radio exposing only doDefault -> no activation",
     DODEFAULT, "radio button", False,
     {"decision": "no_activation_action", "desired": True, "want": "check"}),
    ("ARIA check box exposing only doDefault -> no activation",
     DODEFAULT, "check box", False,
     {"decision": "no_activation_action", "desired": True, "want": "check"}),
    # --- wrong role ------------------------------------------------------------
    ("button exposing 'check' -> unsupported_role (never set via this path)",
     CHECK, "button", False, {"decision": "unsupported_role"}),
    ("toggle button -> unsupported_role (aria-pressed is not the CHECKED state)",
     CHECK, "toggle button", False, {"decision": "unsupported_role"}),
    ("combo box -> unsupported_role",
     DODEFAULT, "combo box", False, {"decision": "unsupported_role"}),
    # --- ambiguity / malformed -------------------------------------------------
    # Both DIRECTIONS at once contradicts the measured contract (a control
    # exposes only the action matching its current state), so the state model is
    # untrusted and we refuse rather than pick the direction we happen to want.
    ("check box exposing BOTH 'check' and 'uncheck' -> ambiguous, no invoke",
     [{"index": 0, "name": "check"}, {"index": 1, "name": "uncheck"}], "check box", False,
     {"decision": "ambiguous_action", "desired": True}),
    ("checked check box exposing BOTH directions -> ambiguous, no invoke",
     [{"index": 0, "name": "check"}, {"index": 1, "name": "uncheck"}], "check box", True,
     {"decision": "ambiguous_action", "desired": False}),
    ("radio exposing BOTH directions -> ambiguous, no invoke",
     [{"index": 0, "name": "check"}, {"index": 1, "name": "uncheck"}], "radio button", False,
     {"decision": "ambiguous_action", "desired": True}),
    ("both 'check' and a duplicate 'check' -> ambiguous, no invoke",
     [{"index": 0, "name": "check"}, {"index": 1, "name": "check"}], "check box", False,
     {"decision": "ambiguous_action", "desired": True}),
    ("malformed entry (empty name) -> ambiguous (fail closed)",
     [{"index": 0, "name": "check"}, {"index": 1, "name": ""}], "check box", False,
     {"decision": "ambiguous_action", "desired": True}),
    ("malformed entry (missing name) -> ambiguous (fail closed)",
     [{"index": 0, "name": "check"}, {"index": 1}], "check box", False,
     {"decision": "ambiguous_action", "desired": True}),
    ("no actions at all -> no activation",
     [], "check box", False,
     {"decision": "no_activation_action", "desired": True, "want": "check"}),
]

fails = 0
for label, actions, role, pre_checked, want in cases:
    got = choose_checkable_action(actions, role, pre_checked)
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  got={got} want={want}"))
    if not ok:
        fails += 1
print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {len(cases)-fails}/{len(cases)}")
sys.exit(0 if fails == 0 else 1)
