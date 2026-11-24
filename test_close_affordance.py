#!/usr/bin/env python3
"""Pure unit tests for the close-affordance policy (no AT-SPI).
Run: python3 test_close_affordance.py

AT-SPI exposes NO "this is the close control" property — only role, accessible
name, and ancestry. So this rule is name-based, which makes it the weakest link
in dialog dismissal, and it is constrained accordingly:
  DENY wins, checked first, on SUBSTRING — over-matching is safe here, because
  the cost of a false ALLOW is making a consent or subscription decision on the
  user's behalf.
  ALLOW is EXACT whole-name only, so "close and accept all" can never normalize
  into "close"."""
import sys
from atspi_bridge import classify_close_affordance, normalize_control_name

PRESS = [{"index": 0, "name": "press"}, {"index": 1, "name": "showContextMenu"}]

cases = [
    # --- genuine close affordances ---------------------------------------------
    ("Close -> allowed", "Close", "button", PRESS, True, None),
    ("Close dialog -> allowed", "Close dialog", "button", PRESS, True, None),
    ("Dismiss -> allowed", "Dismiss", "push button", PRESS, True, None),
    ("a bare multiplication-sign x -> allowed", "×", "button", PRESS, True, None),
    ("a bare letter x -> allowed", "X", "button", PRESS, True, None),
    ("whitespace and case are normalized", "  CLOSE   DIALOG ", "button", PRESS, True, None),
    # cart drawers name their close for what they close (benchmark 2026-09-25)
    ("Close cart -> allowed", "Close cart", "button", PRESS, True, None),
    ("Close minicart -> allowed", "Close minicart", "button", PRESS, True, None),
    ("Close bag drawer -> allowed", "Close Bag Drawer", "button", PRESS, True, None),
    ("close cart and checkout -> not exact, refused", "Close cart and checkout", "button", PRESS, False, "not_a_close_affordance"),

    # --- substantive choices: DENY WINS, even when close-ish --------------------
    ("Accept -> refused", "Accept", "button", PRESS, False, "substantive_choice_refused"),
    ("Accept All Cookies -> refused", "Accept All Cookies", "button", PRESS, False, "substantive_choice_refused"),
    ("Reject Non-Essential -> refused", "Reject Non-Essential", "button", PRESS, False, "substantive_choice_refused"),
    ("Preferences -> refused", "Preferences", "button", PRESS, False, "substantive_choice_refused"),
    ("Subscribe -> refused", "Subscribe", "button", PRESS, False, "substantive_choice_refused"),
    ("Sign Up -> refused", "Sign Up", "button", PRESS, False, "substantive_choice_refused"),
    ("Continue -> refused", "Continue", "button", PRESS, False, "substantive_choice_refused"),
    # THE case the exact-match rule exists for: it starts with "Close" but also
    # accepts. A substring allowlist would have let this through.
    ("Close and accept all -> refused (deny beats a close-looking prefix)",
     "Close and accept all", "button", PRESS, False, "substantive_choice_refused"),
    ("Close and continue -> refused", "Close and continue", "button", PRESS, False, "substantive_choice_refused"),
    # Declining is still a substantive choice, so it is NOT a dismissal.
    ("No thanks -> refused (declining marketing is still a choice)",
     "No thanks", "button", PRESS, False, "substantive_choice_refused"),
    ("Not now -> refused", "Not now", "button", PRESS, False, "substantive_choice_refused"),

    # --- not a close affordance at all ------------------------------------------
    ("Shop Now -> refused", "Shop Now", "button", PRESS, False, "not_a_close_affordance"),
    ("Closet -> refused (exact match, not substring)", "Closet", "button", PRESS, False, "not_a_close_affordance"),
    ("Close the deal -> refused (exact match only)", "Close the deal", "button", PRESS, False, "not_a_close_affordance"),
    ("an empty name -> refused", "", "button", PRESS, False, "control_has_no_name"),

    # --- role gate ---------------------------------------------------------------
    ("a LINK named Close -> refused (it could navigate)", "Close", "link", PRESS, False, "role_not_a_button"),
    ("a check box named Close -> refused", "Close", "check box", PRESS, False, "role_not_a_button"),

    # --- action gate -------------------------------------------------------------
    ("no activation action -> refused",
     "Close", "button", [{"index": 0, "name": "showContextMenu"}], False, "no_activation_action"),
    ("a checkable's check action is not an activation -> refused",
     "Close", "button", [{"index": 0, "name": "check"}], False, "no_activation_action"),
    ("TWO allowlisted actions -> refused as ambiguous (equivalence unproven)",
     "Close", "button", [{"index": 0, "name": "press"}, {"index": 1, "name": "click"}], False, "ambiguous_action"),
    ("an action with no name -> refused",
     "Close", "button", [{"index": 0, "name": "press"}, {"index": 1, "name": ""}], False, "ambiguous_action"),
    ("no actions at all -> refused", "Close", "button", [], False, "no_activation_action"),
]

fails = 0
for label, name, role, actions, want_ok, want_reason in cases:
    got = classify_close_affordance(name, role, actions)
    ok = got["ok"] == want_ok and (want_reason is None or got["reason"] == want_reason)
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  got={got}"))
    if not ok:
        fails += 1

# The allowed case must carry the exact action to invoke — never a guess.
got = classify_close_affordance("Close", "button", PRESS)
ok = got["ok"] and got["index"] == 0 and got["action"] == "press"
print(f"{'ok  ' if ok else 'FAIL'} an allowed control names the exact action and index to invoke")
if not ok:
    fails += 1

ok = normalize_control_name("  Close   Dialog  ") == "close dialog" and normalize_control_name(None) == ""
print(f"{'ok  ' if ok else 'FAIL'} normalization collapses whitespace and tolerates a missing name")
if not ok:
    fails += 1

total = len(cases) + 2
print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {total - fails}/{total}")
sys.exit(0 if fails == 0 else 1)
