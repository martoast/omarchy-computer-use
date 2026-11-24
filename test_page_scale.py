"""python3 test_page_scale.py — page coordinates on a scaled display (atspi_bridge PAGE_SCALE).
Measured 2026-11-23 on an Omarchy laptop at Hyprland scale 1.5: Chromium's frame reports logical pixels,
its page document device pixels (a 1256-wide window held a 1884-wide document)."""
import sys
import atspi_bridge as ab

class Ext:
    def __init__(self, x, y, w, h): self.x, self.y, self.width, self.height = x, y, w, h
class Comp:
    def __init__(self, e): self.e = e
    def get_extents(self, _): return self.e
class N:
    def __init__(self, role, ext, children=()):
        self.role, self.ext, self.children, self.parent = role, ext, list(children), None
        for c in self.children: c.parent = self
    def get_role_name(self): return self.role
    def get_component_iface(self): return Comp(self.ext)
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, i): return self.children[i]
    def get_parent(self): return self.parent

total = [0, 0]
def check(label, cond, detail=""):
    total[0] += 1; total[1] += 0 if cond else 1
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"  <<< {detail}"))

link = N("link", Ext(1470, 307 - 0, 90, 30))
doc = N("document web", Ext(0, 130, 1884, 875), [link])
button = N("push button", Ext(1240, 40, 24, 24))
frame = N("frame", Ext(0, 0, 1256, 670), [N("panel", Ext(0, 0, 1256, 670), [button, doc])])
app = N("application", Ext(0, 0, 0, 0), [frame])

check("scale 1 monitor: no page scale", ab.detect_page_scale(app, 1) == 1.0)
check("scale 1.5 monitor, oversized document: page scale 1.5", ab.detect_page_scale(app, 1.5) == 1.5)
small_doc = N("document web", Ext(0, 87, 1256, 583))
app2 = N("application", Ext(0, 0, 0, 0), [N("frame", Ext(0, 0, 1256, 670), [small_doc])])
check("scale 1.5 monitor, document already logical: page scale 1", ab.detect_page_scale(app2, 1.5) == 1.0)

ab.PAGE_SCALE = 1.5
b = ab.get_bounds(link, 12, 38)
check("page content is divided by the scale", (b["x"], b["y"], b["w"]) == (980 + 12, 205 + 38, 60), b)
b2 = ab.get_bounds(button, 12, 38)
check("browser chrome is left alone", (b2["x"], b2["y"], b2["w"]) == (1252, 78, 24), b2)
ab.PAGE_SCALE = 1.0
b3 = ab.get_bounds(link, 12, 38)
check("at scale 1 nothing changes", (b3["x"], b3["y"]) == (1482, 345), b3)
print(f"FAIL — {total[0]-total[1]}/{total[0]}" if total[1] else f"PASS — {total[0]}/{total[0]}")
sys.exit(1 if total[1] else 0)
