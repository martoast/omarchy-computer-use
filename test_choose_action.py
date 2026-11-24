#!/usr/bin/env python3
"""Pure unit tests for choose_action (no AT-SPI). Run: python3 test_choose_action.py"""
import sys
from atspi_bridge import choose_action

cases = [
    ("unique press -> invoke",
     [{"index": 0, "name": "press"}, {"index": 1, "name": "showContextMenu"}],
     {"decision": "invoke", "index": 0, "name": "press"}),
    ("unique click (diff index) -> invoke",
     [{"index": 0, "name": "showContextMenu"}, {"index": 2, "name": "click"}],
     {"decision": "invoke", "index": 2, "name": "click"}),
    ("only showContextMenu -> no_activation_action",
     [{"index": 0, "name": "showContextMenu"}],
     {"decision": "no_activation_action"}),
    ("empty -> no_activation_action",
     [],
     {"decision": "no_activation_action"}),
    ("two allowed same tier (press+click) -> ambiguous",
     [{"index": 0, "name": "press"}, {"index": 1, "name": "click"}],
     {"decision": "ambiguous_action"}),
    ("two allowed same name -> ambiguous",
     [{"index": 0, "name": "activate"}, {"index": 1, "name": "activate"}],
     {"decision": "ambiguous_action"}),
    ("case/space-insensitive normalize -> invoke",
     [{"index": 3, "name": " Press "}, {"index": 4, "name": "showContextMenu"}],
     {"decision": "invoke", "index": 3, "name": " Press "}),
    # "jump" is Chromium's follow-a-link action and IS allowed (issue #5: a
    # ref-based link must activate its identity-resolved node, not a coordinate).
    ("link jump alone -> invoke",
     [{"index": 0, "name": "jump"}, {"index": 1, "name": "showContextMenu"}],
     {"decision": "invoke", "index": 0, "name": "jump"}),
    # "check"/"uncheck" and "doDefault" are deliberately NOT in this allowlist.
    # Checkable controls no longer come through here at all -- they go to
    # choose_checkable_action, which derives a desired state and verifies it
    # (issue #6, test_choose_checkable.py). "doDefault" stays refused everywhere.
    ("check box 'check' -> no activation (checkables use choose_checkable_action)",
     [{"index": 0, "name": "check"}, {"index": 1, "name": "showContextMenu"}],
     {"decision": "no_activation_action"}),
    ("combo box 'doDefault' -> no activation (doDefault refused everywhere)",
     [{"index": 0, "name": "doDefault"}, {"index": 1, "name": "showContextMenu"}],
     {"decision": "no_activation_action"}),
    ("malformed entry (empty name) -> ambiguous (fail closed)",
     [{"index": 0, "name": "press"}, {"index": 1, "name": ""}],
     {"decision": "ambiguous_action"}),
    ("malformed entry (missing name) -> ambiguous (fail closed)",
     [{"index": 0, "name": "press"}, {"index": 1}],
     {"decision": "ambiguous_action"}),
]

fails = 0
for label, actions, want in cases:
    got = choose_action(actions)
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  got={got} want={want}"))
    if not ok:
        fails += 1

role_cases = [
    ("button open -> invoke", "button", [{"index": 0, "name": "open"}], {"decision": "invoke", "index": 0, "name": "open"}),
    ("unscoped open -> refuse", None, [{"index": 0, "name": "open"}], {"decision": "no_activation_action"}),
    ("link open -> refuse", "link", [{"index": 0, "name": "open"}], {"decision": "no_activation_action"}),
    ("button open+press -> ambiguous", "button", [{"index": 0, "name": "open"}, {"index": 1, "name": "press"}], {"decision": "ambiguous_action"}),
]
for label, role, actions, want in role_cases:
    got = choose_action(actions, role)
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  got={got} want={want}"))
    if not ok:
        fails += 1
print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {len(cases)+len(role_cases)-fails}/{len(cases)+len(role_cases)}")
def test_select_only_item_is_selected():
    # Live Glossier: a country menu item that offers only "select".
    from atspi_bridge import choose_action
    acts = [{"index": 0, "name": "select"}, {"index": 1, "name": "showContextMenu"}]
    assert choose_action(acts, "menu item") == {"decision": "invoke", "index": 0, "name": "select"}
    assert choose_action(acts, "button") == {"decision": "no_activation_action"}
    assert choose_action([{"index": 0, "name": "select"}, {"index": 1, "name": "press"}], "menu item")["name"] == "press"


test_select_only_item_is_selected()
print("PASS — a select-only menu item is selected")
sys.exit(0 if fails == 0 else 1)
