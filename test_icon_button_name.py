#!/usr/bin/env python3
"""icon_button_name (atspi_bridge.py): a small nameless button is named after the control before it
(live Sephora: the basket's trash icon follows combo box "Quantity"); large or unanchored ones stay nameless."""
from atspi_bridge import icon_button_name

class Ext:
    def __init__(s, w, h): s.x, s.y, s.width, s.height = 0, 0, w, h
class Comp:
    def __init__(s, w, h): s.e = Ext(w, h)
    def get_extents(s, _): return s.e
class Node:
    def __init__(s, name="", w=24, h=24, kids=()):
        s.name, s.comp, s.kids, s.parent = name, Comp(w, h), list(kids), None
        for k in s.kids: k.parent = s
    def get_name(s): return s.name
    def get_component_iface(s): return s.comp
    def get_parent(s): return s.parent
    def get_index_in_parent(s): return s.parent.kids.index(s)
    def get_child_at_index(s, i): return s.kids[i]
    def get_child_count(s): return len(s.kids)

trash = Node()
Node(kids=[Node("$15.00"), Node(kids=[Node("Quantity")]), trash, Node("Save for Later")])
big = Node(w=300, h=40)
Node(kids=[Node("Quantity"), big])
alone = Node()
Node(kids=[alone])
cases = [(trash, '[icon button] after "Quantity"'), (big, ""), (alone, "")]
fails = [(want, icon_button_name(n)) for n, want in cases if icon_button_name(n) != want]
for f in fails: print("FAIL", f)
print(f"{len(cases) - len(fails)}/{len(cases)} pass")
raise SystemExit(1 if fails else 0)
