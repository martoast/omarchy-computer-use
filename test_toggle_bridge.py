#!/usr/bin/env python3
"""Bridge-level tests for semantic_toggle_action, driven by a MOCK accessible
tree. Run: python3 test_toggle_bridge.py

choose_toggle_action is pure and separately tested, but passing it a tuple of
arguments proves nothing about whether semantic_toggle_action reaches it,
refuses BEFORE touching the action interface, or leaks a do_action on the way.
These cases count calls AT THE AT-SPI BOUNDARY rather than trusting the
harness's own tally, and the case that matters most is the one where the call
IS issued and then fails: a control whose do_action mutates its state and THEN
raises must be reported as possibly-partially-applied, never as a refusal.
"""
import sys
import atspi_bridge as ab

CALLS = []


class FakeActionIface:
    def __init__(self, names):
        self.names = names


class Node:
    """Duck-types the slice of Atspi.Accessible the toggle path touches. Its
    state is MUTABLE so an action can genuinely change it."""
    _next = [1]

    def __init__(self, role, name="", states=(), children=(), actions=None, uri=None):
        self.role, self._name = role, name
        self.states = set(states)
        self.uri = uri
        self.parent = None
        self.path = f"/org/a11y/atspi/accessible/{Node._next[0]}"
        Node._next[0] += 1
        self._ai = FakeActionIface(list(actions)) if actions is not None else None
        self.children = list(children)
        for c in self.children:
            c.parent = self

    def get_role_name(self): return self.role
    def get_name(self): return self._name
    def get_parent(self): return self.parent
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, i): return self.children[i]
    def get_attributes(self): return {}
    def get_document_iface(self):
        if self.uri is None:
            return None
        outer = self

        class D:
            def get_document_attribute_value(self, k):
                return outer.uri if k == "DocURL" else None
        return D()

    def get_action_iface(self): return self._ai

    def get_state_set(self):
        outer = self

        class SS:
            def contains(self, st): return st in outer.states
        return SS()


class FakeStateType:
    # Only the members _state_snapshot reads; identity is all that matters.
    SHOWING, ENABLED, SENSITIVE, FOCUSED = "showing", "enabled", "sensitive", "focused"
    CHECKED, PRESSED, SELECTED, EXPANDED, EDITABLE = "checked", "pressed", "selected", "expanded", "editable"


class PlainAction:
    @staticmethod
    def get_n_actions(ai): return len(ai.names)

    @staticmethod
    def get_action_name(ai, i): return ai.names[i]

    @staticmethod
    def do_action(ai, i):
        CALLS.append((ai, i))
        return True


class FakeAtspi:
    Action = PlainAction
    StateType = FakeStateType


ab.Atspi = FakeAtspi
# _STATE_MAP was built from the real enum at import; rebuild it against the mock
# so _state_snapshot reads the same keys the product does.
ab._STATE_MAP = {k: getattr(FakeStateType, k.upper()) for k in
                 ("showing", "enabled", "sensitive", "focused", "checked", "pressed",
                  "selected", "expanded", "editable")}

fails, total = [0], [0]


def check(label, cond, detail=""):
    total[0] += 1
    print(f"{'ok  ' if cond else 'FAIL'} {label}" + ("" if cond else f"  <<< {detail}"))
    if not cond:
        fails[0] += 1


def app_with(node):
    doc = Node("document web", "", children=[node], uri="https://store.test/p")
    return Node("frame", "win", children=[doc])


def run(app, node):
    CALLS.clear()
    return ab.semantic_toggle_action(app, None, None, node.path, ab.doc_gen_of(node))


BASE = ("showing", "enabled", "sensitive")

# ------------------------------------------------------ the happy path
t = Node("toggle button", "Opt", states=BASE, actions=["check", "showContextMenu"])
app = app_with(t)


class SettingAction(PlainAction):
    @staticmethod
    def do_action(ai, i):
        CALLS.append((ai, i))
        t.states.add("pressed")          # the control really changes
        t._ai.names = ["uncheck", "showContextMenu"]
        return True


ab.Atspi = type("A", (), {"Action": SettingAction, "StateType": FakeStateType})
r = run(app, t)
ab.Atspi = FakeAtspi
check("an unpressed toggle is set via its own check action", r.get("verified") is True, r)
check("  ...exactly ONE do_action reached the AT-SPI boundary", len(CALLS) == 1, CALLS)
check("  ...and the bridge reports invocation_count 1", r.get("invocation_count") == 1, r)
check("  ...with the desired state derived, not assumed", r.get("desired") is True, r)
check("  ...proven on the exact node's own pressed state",
      r["pre_on"] is False and r["post_states"]["pressed"] is True, r)
check("  ...and the action flip is recorded as corroboration",
      r.get("post_actions") == ["uncheck", "showContextMenu"], r.get("post_actions"))

# -------------------------------- THE CASE THIS FILE EXISTS FOR: mutate, then raise
MUTATED = []
t2 = Node("toggle button", "Opt2", states=BASE, actions=["check", "showContextMenu"])
app2 = app_with(t2)


class MutateThenRaise(PlainAction):
    @staticmethod
    def do_action(ai, i):
        CALLS.append((ai, i))
        t2.states.add("pressed")         # a REAL mutation happens first
        MUTATED.append("state changed before the failure")
        raise RuntimeError("boom after mutating")


ab.Atspi = type("A", (), {"Action": MutateThenRaise, "StateType": FakeStateType})
r2 = run(app2, t2)
ab.Atspi = FakeAtspi
check("do_action that MUTATES then RAISES: exactly one call reached the boundary", len(CALLS) == 1, CALLS)
check("  ...the mutation really happened (this is not a no-op path)", len(MUTATED) == 1, MUTATED)
check("  ...invocation_count is 1, NOT 0 — it counts calls ISSUED, not calls that succeeded",
      r2.get("invocation_count") == 1, r2)
check("  ...it is NOT verified", r2.get("verified") is False, r2)
check("  ...and says the action raised, so a caller cannot read it as a refusal",
      r2.get("failure") == "action_raised" and "boom" in str(r2.get("raised")), r2)
check("  ...invoked is TRUE, so no consumer can classify it as 'nothing happened'",
      r2.get("invoked") is True, r2)
check("  ...and the BEFORE evidence survives for the caller to compare against",
      r2.get("pre_on") is False and isinstance(r2.get("pre_states"), dict), r2)

# ------------------------------------------------ refusals issue ZERO calls
def refusal(label, node, want_key):
    app = app_with(node)
    r = run(app, node)
    check(f"{label} -> {want_key}", r.get(want_key) is True, r)
    check("  ...ZERO do_action calls issued", len(CALLS) == 0, CALLS)
    check("  ...and invocation_count is explicitly 0", r.get("invocation_count") == 0, r)


refusal("a PRESSED toggle advertising only check (contradiction)",
        Node("toggle button", "C", states=BASE + ("pressed",), actions=["check"]),
        "state_action_contradiction")
refusal("an UNPRESSED toggle advertising only uncheck (contradiction)",
        Node("toggle button", "C2", states=BASE, actions=["uncheck"]),
        "state_action_contradiction")
refusal("both directions advertised at once",
        Node("toggle button", "C3", states=BASE, actions=["check", "uncheck"]),
        "ambiguous_action")
refusal("only doDefault advertised",
        Node("toggle button", "C4", states=BASE, actions=["doDefault"]),
        "no_activation_action")
refusal("no action interface at all",
        Node("toggle button", "C5", states=BASE, actions=None),
        "no_activation_action")
refusal("a check box never reaches the toggle path",
        Node("check box", "C6", states=BASE, actions=["check"]),
        "unsupported_role")
refusal("a radio button never reaches the toggle path",
        Node("radio button", "C7", states=BASE, actions=["check"]),
        "unsupported_role")
refusal("a plain button never reaches the toggle path",
        Node("button", "C8", states=BASE, actions=["press"]),
        "unsupported_role")

# A ref that resolves to nothing must not invoke anything either.
t9 = Node("toggle button", "C9", states=BASE, actions=["check"])
app9 = app_with(t9)
CALLS.clear()
r9 = ab.semantic_toggle_action(app9, None, None, "/org/a11y/atspi/accessible/999999", ab.doc_gen_of(t9))
check("a ref that resolves to nothing -> stale", bool(r9.get("stale_ref")), r9)
check("  ...ZERO do_action calls issued", len(CALLS) == 0, CALLS)
check("  ...and invocation_count is explicitly 0", r9.get("invocation_count") == 0, r9)

# ---------------------------------- invoked but the state does NOT change
t10 = Node("toggle button", "C10", states=BASE, actions=["check", "showContextMenu"])
app10 = app_with(t10)
ab.Atspi = FakeAtspi          # do_action returns true and changes nothing
r10 = run(app10, t10)
check("an action that returns true but changes nothing is NOT verified",
      r10.get("verified") is False and r10.get("failure") == "state_unchanged", r10)
check("  ...one call was still issued and is reported", r10.get("invocation_count") == 1 and len(CALLS) == 1, r10)
check("  ...and do_action's boolean is recorded as evidence, not treated as proof",
      r10.get("do_action_returned") is True, r10)

print(f"\n{'PASS' if fails[0] == 0 else 'FAIL'} — {total[0] - fails[0]}/{total[0]}")
sys.exit(0 if fails[0] == 0 else 1)
