#!/usr/bin/env python3
"""Bridge-level tests for dismiss_dialog_action and _page_survey, driven by a
MOCK accessible tree.
Run: python3 test_dismiss_bridge.py

Why this file exists: classify_close_affordance is pure and already tested, but
passing it a tuple of arguments proves nothing about whether
dismiss_dialog_action reaches it, refuses BEFORE touching the action interface,
or leaks a do_action on the way. These cases assert the thing that actually
matters on every refusal path -- that ZERO do_action calls were issued -- by
counting them at the AT-SPI boundary rather than trusting the harness's tally.
"""
import sys
import atspi_bridge as ab

CALLS = []  # every do_action the bridge issues, in order


class FakeActionIface:
    def __init__(self, names):
        self.names = names  # a None entry models an action with no name


class FakeDocIface:
    def __init__(self, uri):
        self.uri = uri

    def get_document_attribute_value(self, key):
        return self.uri if key == "DocURL" else None


class Node:
    """Duck-types the slice of Atspi.Accessible the dismissal path touches."""
    _next = [1]

    def __init__(self, role, name="", attrs=None, children=(), actions=None, uri=None, no_path=False):
        self.role, self._name = role, name
        self.attrs = attrs or {}
        self.uri = uri
        self.parent = None
        self.path = None if no_path else f"/org/a11y/atspi/accessible/{Node._next[0]}"
        Node._next[0] += 1
        self._ai = FakeActionIface(actions) if actions is not None else None
        self.children = list(children)
        for c in self.children:
            c.parent = self

    # --- the Accessible surface ---
    def get_role_name(self): return self.role
    def get_name(self): return self._name
    def get_parent(self): return self.parent
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, i): return self.children[i]
    def get_attributes(self): return dict(self.attrs)
    def get_document_iface(self): return FakeDocIface(self.uri) if self.uri is not None else None
    def get_action_iface(self): return self._ai


class FakeAction:
    @staticmethod
    def get_n_actions(ai): return len(ai.names)

    @staticmethod
    def get_action_name(ai, i): return ai.names[i]

    @staticmethod
    def do_action(ai, i):
        CALLS.append((ai, i))
        return True


class FakeAtspi:
    Action = FakeAction


ab.Atspi = FakeAtspi  # the ONLY global the dismissal path reaches through

fails = [0]


total = [0]


def check(label, cond, detail=""):
    total[0] += 1
    print(f"{'ok  ' if cond else 'FAIL'} {label}" + ("" if cond else f"  <<< {detail}"))
    if not cond:
        fails[0] += 1


def app_with(dialog_children, dialog_attrs=None, dialog_role="dialog", uri="https://store.test/p",
             outside=(), nested=False):
    """A window -> page document -> [background content] + dialog(...)."""
    dlg = Node(dialog_role, "TheModal", attrs=dialog_attrs or {}, children=list(dialog_children))
    if nested:
        dlg = Node("dialog", "OuterModal", children=[dlg])
    doc = Node("document web", "", children=[*outside, dlg], uri=uri)
    return Node("frame", "win", children=[doc]), dlg


def run(app, control):
    CALLS.clear()
    return ab.dismiss_dialog_action(app, control.path, ab.doc_gen_of(control), None)


PRESS = ["press", "showContextMenu"]

# ---------------------------------------------------------------- happy path
btn = Node("button", "Close", actions=PRESS)
app, _ = app_with([btn], outside=[Node("link", "StoreLink")])
r = run(app, btn)
check("a close button inside a page dialog is invoked", r.get("invoked") is True, r)
check("  ...exactly ONE do_action was issued at the AT-SPI boundary", len(CALLS) == 1, CALLS)
check("  ...at the index of the control's OWN press action", CALLS and CALLS[0][1] == 0, CALLS)
check("  ...and the bridge reports invocation_count 1", r.get("invocation_count") == 1, r)
check("  ...carrying the page document GENERATION for the caller's postcondition",
      isinstance(r["before"].get("page_doc_gen"), str) and r["before"]["page_doc_gen"].startswith("/org/a11y/"),
      r["before"].get("page_doc_gen"))
check("  ...and the before-survey counts the background link outside the dialog",
      r["before"]["survey"]["links"] == 1, r["before"]["survey"])

btn = Node("button", "Dismiss this popup", actions=PRESS)
app, _ = app_with([btn], outside=[Node("link", "StoreLink")])
r = run(app, btn)
check("the measured Disney Store label 'Dismiss this popup' is an exact close affordance", r.get("invoked") is True, r)
check("  ...and invokes exactly one semantic action", len(CALLS) == 1, CALLS)

# ------------------------------------------------- the refusal paths, END TO END
# Each asserts the bridge's own reason AND that no action reached AT-SPI.
def refusal(label, control, app, want_reason):
    r = run(app, control)
    check(f"{label} -> {want_reason}", r.get("reason") == want_reason, r)
    check(f"  ...ZERO do_action calls issued", len(CALLS) == 0, CALLS)
    check(f"  ...and invocation_count is explicitly 0", r.get("invocation_count") == 0, r)


b = Node("button", "Close", actions=PRESS)
app, _ = app_with([b], nested=True)
refusal("a close control inside TWO dialogs", b, app, "ambiguous_dialog_ancestry")

b = Node("button", "Close", actions=["press", "click"])
app, _ = app_with([b])
refusal("TWO allowlisted own actions (equivalence unproven)", b, app, "ambiguous_action")

b = Node("button", "Close", actions=["showContextMenu"])
app, _ = app_with([b])
refusal("no allowlisted action among those offered", b, app, "no_activation_action")

b = Node("button", "Close", actions=[])
app, _ = app_with([b])
refusal("an action interface offering nothing", b, app, "no_activation_action")

b = Node("button", "Close", actions=None)  # NO action interface at all
app, _ = app_with([b])
refusal("NO action interface at all", b, app, "no_activation_action")

b = Node("button", "Close", actions=["press", None])
app, _ = app_with([b])
refusal("an action with no name", b, app, "action_without_name")

b = Node("button", "Accept", actions=PRESS)
app, _ = app_with([b])
refusal("a consent choice", b, app, "substantive_choice_refused")

b = Node("button", "Close", actions=PRESS)
doc = Node("document web", "", children=[b], uri="https://store.test/p")  # no dialog anywhere
app = Node("frame", "win", children=[doc])
refusal("a Close button with no dialog ancestor", b, app, "not_inside_a_dialog")

b = Node("button", "Close", actions=PRESS)
app, _ = app_with([b], uri="chrome://settings/")
refusal("a dialog inside BROWSER UI, not a page", b, app, "dialog_not_in_a_page_document")

b = Node("button", "Close", actions=PRESS)
app, _ = app_with([b])
CALLS.clear()
r = ab.dismiss_dialog_action(app, "/org/a11y/atspi/accessible/999999", ab.doc_gen_of(b), None)
check("a ref that resolves to nothing -> stale_ref", r.get("reason") == "stale_ref", r)
check("  ...ZERO do_action calls issued", len(CALLS) == 0, CALLS)
check("  ...and invocation_count is explicitly 0", r.get("invocation_count") == 0, r)

# -------------------- an ordinary notification is NOT a dismissible dialog (E2E)
# The safety case: a live-region toast ("Item added to cart") with its own Close
# button must not be dismissible through this tool, and must not be able to hide
# page content from the postcondition by being counted as a modal.
b = Node("button", "Close", actions=PRESS)
app, _ = app_with([b], dialog_role="alert")  # bare alert, no declaration
refusal("a Close button inside a BARE alert", b, app, "not_inside_a_dialog")

b = Node("button", "Close", actions=PRESS)
app, _ = app_with([b], dialog_role="alert", dialog_attrs={"xml-roles": "alert"})
refusal("a Close button inside an ordinary ARIA alert", b, app, "not_inside_a_dialog")

b = Node("button", "Close", actions=PRESS)
app, _ = app_with([b], dialog_role="alert", dialog_attrs={"xml-roles": "alertdialog"})
r = run(app, b)
check("but a Close button inside a declared ALERTDIALOG is eligible", r.get("invoked") is True, r)
check("  ...and exactly one action was issued for it", len(CALLS) == 1, CALLS)

# A toast's own text must stay in the page content the postcondition measures,
# or dismissing a real modal elsewhere could look like it revealed the toast.
toast = Node("alert", "Toast", attrs={"xml-roles": "alert"},
             children=[Node("link", "ToastLink"), Node("button", "Close", actions=PRESS)])
doc = Node("document web", "", children=[Node("link", "PageLink"), toast], uri="https://store.test/p")
s_toast = ab._page_survey(Node("frame", "win", children=[doc]))
check("an ordinary alert is NOT counted as a dialog by the survey", s_toast["dialogs"] == 0, s_toast)
check("  ...and its content still counts as page content", s_toast["links"] == 2, s_toast)

# ------------------------- a dialog role NOT mapped natively (defensive, mocked)
# THIS SHAPE DOES NOT OCCUR ON THIS CHROMIUM. Measured on 151.0.7922.173:
# div[role=dialog] maps to `dialog` and div[role=alertdialog] to `alert`. What
# this mock covers is a build that declines to map the ARIA role natively and
# leaves it as a generic panel carrying xml-roles -- the way role=radiogroup
# genuinely does behave here. So the branch is DEFENCE for another build, proven
# against a mock rather than claimed as a live observation.
b = Node("button", "Close", actions=PRESS)
app, _ = app_with([b], dialog_role="panel", dialog_attrs={"xml-roles": "dialog"})
r = run(app, b)
check("an unmapped ARIA dialog (generic panel + xml-roles) is still recognized as the ancestor",
      r.get("invoked") is True, r)
check("  ...and one action was issued for it", len(CALLS) == 1, CALLS)

# ---------------------------------- do_action ISSUED, then RAISED (partial risk)
# The dangerous middle case: the call reached the control, the control changed
# something, and THEN the call raised. Reporting invocation_count 0 here would
# let a partially applied mutation be described as "nothing was activated", so
# the count reports calls ISSUED, not calls that succeeded.
MUTATED = []


class RaisingAction(FakeAction):
    @staticmethod
    def do_action(ai, i):
        CALLS.append((ai, i))
        MUTATED.append("the control's own state changed before the failure")
        raise RuntimeError("boom after mutating")


class RaisingAtspi:
    Action = RaisingAction


b = Node("button", "Close", actions=PRESS)
app, _ = app_with([b], outside=[Node("link", "StoreLink")])
ab.Atspi = RaisingAtspi
r = run(app, b)
ab.Atspi = FakeAtspi
check("do_action raised AFTER mutating -> the call was still issued", len(CALLS) == 1, CALLS)
check("  ...the mutation really happened (this is not a no-op path)", len(MUTATED) == 1, MUTATED)
check("  ...invocation_count is 1, NOT 0 -- it counts calls ISSUED, not calls that succeeded",
      r.get("invocation_count") == 1, r)
check("  ...and it is reported as a failure, not as an invocation",
      r.get("refused") is True and r.get("invoked") is None
      and str(r.get("reason", "")).startswith("do_action_failed"), r)
check("  ...carrying the before-evidence so the caller can see what may have changed",
      isinstance(r.get("before"), dict) and "survey" in r["before"], r)

# --------------------------------------------- what counts as a dialog node
# The xml-roles lookup costs a D-Bus round trip and is_dialog_node runs on every
# node of every read_page walk, so it is restricted to the generic roles
# Chromium falls back to for an ARIA role it does not map natively.
check("a native `dialog` role is a dialog root",
      ab.is_dialog_node(Node("dialog", "D")) is True)
# `alert` is AMBIGUOUS -- role=alertdialog (a modal) and role=alert (an ordinary
# live-region toast) can both surface through it. A positive declaration is
# required, and its ABSENCE fails closed: a toast's Close button must never
# become eligible for dismissal, and its text must never be excluded from the
# page content the postcondition measures.
check("an `alert` DECLARING alertdialog is a dialog root",
      ab.is_dialog_node(Node("alert", "A", attrs={"xml-roles": "alertdialog"})) is True)
check("an `alert` declaring plain alert is NOT a dialog root",
      ab.is_dialog_node(Node("alert", "A", attrs={"xml-roles": "alert"})) is False)
check("a BARE `alert` with no discriminating metadata is NOT a dialog root (fails closed)",
      ab.is_dialog_node(Node("alert", "A")) is False)
check("an `alert` declaring something else entirely is NOT a dialog root",
      ab.is_dialog_node(Node("alert", "A", attrs={"xml-roles": "status"})) is False)
# The shape this Chromium actually produces for an ordinary ARIA alert.
check("a `notification` carrying xml-roles=alert is NOT a dialog root",
      ab.is_dialog_node(Node("notification", "Toast", attrs={"xml-roles": "alert"})) is False)
check("a `status bar` carrying xml-roles=status is NOT a dialog root",
      ab.is_dialog_node(Node("status bar", "S", attrs={"xml-roles": "status"})) is False)
# A native <dialog> carries NO xml-roles at all, so the role must stand alone.
check("a native `dialog` with no attributes at all is still a dialog root",
      ab.is_dialog_node(Node("dialog", "D")) is True)
check("a generic `panel` declaring xml-roles=dialog is a dialog root",
      ab.is_dialog_node(Node("panel", "P", attrs={"xml-roles": "dialog"})) is True)
check("a generic `panel` declaring xml-roles=alertdialog is a dialog root",
      ab.is_dialog_node(Node("panel", "P", attrs={"xml-roles": "alertdialog"})) is True)
check("a generic `panel` declaring xml-roles=radiogroup is NOT",
      ab.is_dialog_node(Node("panel", "P", attrs={"xml-roles": "radiogroup"})) is False)
check("a plain `panel` is NOT", ab.is_dialog_node(Node("panel", "P")) is False)
check("an ordinary button is NOT", ab.is_dialog_node(Node("button", "B")) is False)
# The deliberate, documented cost of the narrowing.
check("a NON-generic role declaring xml-roles=dialog is NOT (documented cost of "
      "not paying an attribute lookup per node)",
      ab.is_dialog_node(Node("list item", "L", attrs={"xml-roles": "dialog"})) is False)


class Exploding:
    def get_role_name(self): raise RuntimeError("dead node")


check("a node that cannot be read is NOT a dialog (never raises)",
      ab.is_dialog_node(Exploding()) is False)

# ---------------------------------------------------------------- _page_survey
inner = [Node("link", "ModalLink"), Node("button", "Close", actions=PRESS),
         Node("panel", "sub", attrs={"xml-roles": "dialog"}, children=[Node("link", "NestedModalLink")])]
outside = [Node("link", "A"), Node("link", "B"), Node("heading", "H")]
app, _ = app_with(inner, outside=outside)
s = ab._page_survey(app)
check("survey counts only links OUTSIDE every dialog", s["links"] == 2, s)
check("survey counts content outside every dialog", s["content"] == 3, s)
check("survey counts dialog ROOTS, not their descendants", s["dialogs"] == 2, s)
check("survey reports the live page document generations", len(s["page_docs"]) == 1
      and s["page_docs"][0]["doc_gen"].startswith("/org/a11y/"), s["page_docs"])
check("survey reports each page document's URI", s["page_docs"][0]["uri"] == "https://store.test/p", s["page_docs"])

chrome_doc = Node("document web", "", children=[Node("link", "OmniboxSuggestion")],
                  uri="chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html")
app2 = Node("frame", "win", children=[chrome_doc])
s2 = ab._page_survey(app2)
check("browser-internal documents contribute NOTHING to the survey",
      s2 == {"links": 0, "content": 0, "dialogs": 0, "page_docs": []}, s2)

dlg_in_chrome = Node("dialog", "BrowserDialog", children=[Node("link", "x")])
app3 = Node("frame", "win", children=[Node("document web", "", children=[dlg_in_chrome], uri="chrome://settings/")])
check("a dialog in browser UI is not counted as a page dialog", ab._page_survey(app3)["dialogs"] == 0,
      ab._page_survey(app3))

print(f"\n{'PASS' if fails[0] == 0 else 'FAIL'} — {total[0] - fails[0]}/{total[0]}")
sys.exit(0 if fails[0] == 0 else 1)
