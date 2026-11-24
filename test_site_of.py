#!/usr/bin/env python3
"""Pure tests for site_of (atspi_bridge.py): a store's checkout subdomain is the same site."""
from atspi_bridge import site_of
cases = [
    ("us.checkout.gymshark.com", "gymshark.com"), ("www.gymshark.com", "gymshark.com"),
    ("checkout.owalalife.com", "owalalife.com"), ("owalalife.com", "owalalife.com"),
    ("shop.example.co.uk", "example.co.uk"), ("evil-gymshark.com", "evil-gymshark.com"),
    ("gymshark.com.evil.net", "evil.net"), ("www.target.com:443", "target.com"),
]
fails = [(h, want, site_of(h)) for h, want in cases if site_of(h) != want]
for f in fails: print("FAIL", f)
print(f"{len(cases) - len(fails)}/{len(cases)} pass")
raise SystemExit(1 if fails else 0)
