"""document_text (2026-09-29, view-source photo fallback): the first page document's leaf text in page order,
forwards or read from the end, bounded, and nothing when there is no page document."""
import atspi_bridge as ab

class N:
    def __init__(self, role, text=None, kids=()):
        self.role, self.text, self.kids = role, text, list(kids)
    def get_role_name(self): return self.role
    def get_child_count(self): return len(self.kids)
    def get_child_at_index(self, i): return self.kids[i]
    def get_text_iface(self): return self if self.text is not None else None

ab.classify_document = lambda acc: "page"
ab.document_uri = lambda acc: "https://store.test/p/1"
class T:
    @staticmethod
    def get_text(ti, a, b): return ti.text
ab.Atspi.Text = T

lines = [N("static", f"line {i}") for i in range(6)]
doc = N("document web", None, [N("table row", None, lines[:3]), N("table row", None, lines[3:])])
app = N("application", None, [N("frame", None, [doc])])
fails = 0
def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print(("ok  " if ok else "FAIL") + f" {label}: {got!r}" + ("" if ok else f" (want {want!r})"))

r = ab.document_text_action(app)
check("page order", r["text"].split("\n"), [f"line {i}" for i in range(6)])
check("not truncated", r["truncated"], False)
r = ab.document_text_action(app, reverse=True)
check("from the end, still page order", r["text"].split("\n"), [f"line {i}" for i in range(6)])
r = ab.document_text_action(app, max_chars=10, reverse=True)
check("a budget from the end keeps the END", r["text"].split("\n")[-1], "line 5")
check("and says it was cut", r["truncated"], True)
check("no document", ab.document_text_action(N("application", None, [N("frame")]))["ok"], False)
print("PASS" if not fails else f"FAILED {fails}")
raise SystemExit(1 if fails else 0)
