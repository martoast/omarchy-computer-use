"""read_page start_at_ref (2026-09-29): collect() takes nothing before the anchor node, everything after it, in page
order, with the document provenance the walk carried down; a missing anchor reports found=False and no rows."""
import atspi_bridge as ab

class N:
    def __init__(self, role, name, path, kids=()):
        self.role, self.name, self.path, self.kids = role, name, path, list(kids)
    def get_role_name(self): return self.role
    def get_name(self): return self.name
    def get_child_count(self): return len(self.kids)
    def get_child_at_index(self, i): return self.kids[i]

P = "/org/a11y/atspi/accessible/"
ab.get_bounds = lambda acc, ox, oy: {"x": 10, "y": int(acc.path.rsplit("/", 1)[1]) * 30, "w": 50, "h": 20}
ab.get_states = lambda acc: []
ab.classify_document = lambda acc: "page"
ab.get_page_info = lambda app: {"url": "https://store.test/p/1"}
ab.get_link_href_full = lambda acc: None
ab.get_link_path = lambda acc: None
ab.icon_button_name = lambda acc: None
ab.is_dialog_node = lambda acc, role=None: False

buttons = [N("button", f"Nav {i}", f"{P}{100 + i}") for i in range(5)]
heading = N("heading", "Rambler 20 oz Tumbler", f"{P}200")
box = [N("button", "Navy", f"{P}201"), N("button", "Rescue Red", f"{P}202")]
doc = N("document web", "YETI", f"{P}1", buttons + [heading] + box)
app = N("application", "Chromium", f"{P}0", [N("frame", "w", f"{P}2", [doc])])

def names(rows): return [r["name"] for r in rows]
fails = 0
def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print(("ok  " if ok else "FAIL") + f" {label}: {got!r}" + ("" if ok else f" (want {want!r})"))

whole = ab.collect(app, 0, 0, False, None, None, 500)
check("unscoped read unchanged", names(whole)[:2], ["Nav 0", "Nav 1"])
anchor = {"found": False}
rows = ab.collect(app, 0, 0, False, None, None, 500, None, False, False, f"{P}200", anchor)
check("starts at the anchor", names(rows), ["Rambler 20 oz Tumbler", "Navy", "Rescue Red"])
check("anchor found", anchor["found"], True)
check("page provenance kept", {r.get("doc_class") for r in rows}, {"page"})
check("refs count from the anchor", rows[0]["ref"], "e1")
rows = ab.collect(app, 0, 0, False, None, None, 2, None, False, False, f"{P}200", anchor)
check("limit counts only collected rows", names(rows), ["Rambler 20 oz Tumbler", "Navy"])
gone = {"found": False}
check("stale anchor: no rows", ab.collect(app, 0, 0, False, None, None, 500, None, False, False, f"{P}999", gone), [])
check("stale anchor reported", gone["found"], False)
print("PASS" if not fails else f"FAILED {fails}")
raise SystemExit(1 if fails else 0)
