#!/usr/bin/env python3
"""Pure unit tests for stateful-toggle selection (no AT-SPI).
Run: python3 test_choose_toggle.py

A toggle button is deliberately NOT a check box. Two things separate them and
both are asserted here: it carries PRESSED rather than CHECKED, and a click on
it follows the control's own advertised action instead of being reinterpreted as
an idempotent "select". Clicking an already-pressed toggle therefore unpresses
it -- that is what the control says it will do, and guessing that the caller
"probably meant to keep it on" would be inventing intent."""
import sys
from atspi_bridge import choose_toggle_action, state_key_for_role, TOGGLE_ROLES, CHECKABLE_ROLES

CHECK = [{"index": 0, "name": "check"}, {"index": 1, "name": "showContextMenu"}]
UNCHECK = [{"index": 0, "name": "uncheck"}, {"index": 1, "name": "showContextMenu"}]
BOTH = [{"index": 0, "name": "check"}, {"index": 1, "name": "uncheck"}]
DODEFAULT = [{"index": 0, "name": "doDefault"}]
PRESS = [{"index": 0, "name": "press"}]

cases = [
    # --- the two real directions ------------------------------------------------
    ("unpressed + advertises check -> invoke check, desired pressed",
     CHECK, "toggle button", False,
     {"decision": "invoke", "index": 0, "name": "check", "desired": True}),
    ("PRESSED + advertises uncheck -> invoke uncheck, desired UNpressed",
     UNCHECK, "toggle button", True,
     {"decision": "invoke", "index": 0, "name": "uncheck", "desired": False}),

    # --- the contradiction rule: the action must agree with the state -----------
    # A control that reports one state while offering only the action for the
    # other does not have a state model we understand. Trusting the action name
    # would mean acting on a control whose reported state we have just decided
    # to disbelieve.
    ("PRESSED but advertises only check -> contradiction, never invoked",
     CHECK, "toggle button", True,
     {"decision": "state_action_contradiction", "desired": False, "want": "uncheck",
      "offered": "check", "pre_pressed": True}),
    ("unpressed but advertises only uncheck -> contradiction, never invoked",
     UNCHECK, "toggle button", False,
     {"decision": "state_action_contradiction", "desired": True, "want": "check",
      "offered": "uncheck", "pre_pressed": False}),

    # --- nothing usable ---------------------------------------------------------
    ("only doDefault -> no activation action", DODEFAULT, "toggle button", False,
     {"decision": "no_activation_action", "desired": True, "want": "check"}),
    ("only press -> no activation action (press is not a state action)",
     PRESS, "toggle button", False,
     {"decision": "no_activation_action", "desired": True, "want": "check"}),
    ("no actions at all -> no activation action", [], "toggle button", False,
     {"decision": "no_activation_action", "desired": True, "want": "check"}),

    # --- ambiguity: refuse rather than pick the direction we happen to want -----
    ("BOTH directions at once -> ambiguous", BOTH, "toggle button", False,
     {"decision": "ambiguous_action", "desired": True}),
    ("BOTH directions while pressed -> ambiguous", BOTH, "toggle button", True,
     {"decision": "ambiguous_action", "desired": False}),
    ("duplicate check -> ambiguous",
     [{"index": 0, "name": "check"}, {"index": 1, "name": "check"}], "toggle button", False,
     {"decision": "ambiguous_action", "desired": True}),
    ("an entry with an empty name -> ambiguous (fail closed)",
     [{"index": 0, "name": "check"}, {"index": 1, "name": ""}], "toggle button", False,
     {"decision": "ambiguous_action", "desired": True}),
    ("an entry with a missing name -> ambiguous (fail closed)",
     [{"index": 0, "name": "check"}, {"index": 1}], "toggle button", False,
     {"decision": "ambiguous_action", "desired": True}),

    # --- unreadable state -------------------------------------------------------
    # Without a pre-state there is no way to derive what a click would do.
    ("unreadable pressed state -> refuse, no desired direction invented",
     CHECK, "toggle button", None, {"decision": "unreadable_state"}),

    # --- role gate --------------------------------------------------------------
    ("a check box never reaches this path", CHECK, "check box", False, {"decision": "unsupported_role"}),
    ("a radio button never reaches this path", CHECK, "radio button", False, {"decision": "unsupported_role"}),
    ("a plain button never reaches this path", CHECK, "button", False, {"decision": "unsupported_role"}),
]

fails = 0
for label, actions, role, pre, want in cases:
    got = choose_toggle_action(actions, role, pre)
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  got={got} want={want}"))
    if not ok:
        fails += 1

extra = []
# The role -> state mapping is the one place that decides WHICH state is being
# set, so a reader and a writer cannot disagree about it.
extra.append(("toggle button maps to `pressed`", state_key_for_role("toggle button") == "pressed"))
extra.append(("check box maps to `checked`", state_key_for_role("check box") == "checked"))
extra.append(("radio button maps to `checked`", state_key_for_role("radio button") == "checked"))
extra.append(("an unknown role maps to nothing, so callers must refuse",
              state_key_for_role("button") is None and state_key_for_role("") is None))
# The separation that keeps a toggle from inheriting checkbox/radio peer policy.
extra.append(("toggle button is NOT in CHECKABLE_ROLES", "toggle button" not in CHECKABLE_ROLES))
extra.append(("check box and radio button are NOT in TOGGLE_ROLES",
              not ({"check box", "radio button"} & set(TOGGLE_ROLES))))
# Clicking an already-pressed toggle must never be silently reinterpreted.
extra.append(("an already-pressed toggle is never reported 'already satisfied'",
              choose_toggle_action(UNCHECK, "toggle button", True)["decision"] == "invoke"))
for label, ok in extra:
    print(f"{'ok  ' if ok else 'FAIL'} {label}")
    if not ok:
        fails += 1

total = len(cases) + len(extra)
print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {total - fails}/{total}")
sys.exit(0 if fails == 0 else 1)
