"""settle_verdict (2026-09-29): ready + quiet → settled; past the bound → not settled WITH the reason; never a guess."""
import atspi_bridge as ab
fails = 0
def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print(("ok  " if ok else "FAIL") + f" {label}: {got!r}" + ("" if ok else f" (want {want!r})"))
check("ready and quiet long enough", ab.settle_verdict("ready", 900, 2000, 800, 15000), {"settled": True, "reason": "quiet"})
check("ready but still changing: keep waiting", ab.settle_verdict("ready", 300, 2000, 800, 15000), None)
check("busy: keep waiting", ab.settle_verdict("busy", 5000, 2000, 800, 15000), None)
check("old document after a navigation: keep waiting", ab.settle_verdict("old_document", 5000, 2000, 800, 15000), None)
check("bound reached while busy → says busy", ab.settle_verdict("busy", 5000, 15000, 800, 15000), {"settled": False, "reason": "busy"})
check("bound reached while changing → still_changing", ab.settle_verdict("ready", 100, 15000, 800, 15000), {"settled": False, "reason": "still_changing"})
print("PASS" if not fails else f"FAILED {fails}")
raise SystemExit(1 if fails else 0)
