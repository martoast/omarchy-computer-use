// Paste-first URL entry: pure decision + entry helper, kept out of index.js so
// both are unit-testable without importing the MCP server (which connects to
// stdio at load time).
//
// WHY THIS EXISTS (live evidence, New Balance + eBay headless direct-URL runs):
// typing an http(s) URL into the address bar took ~6.3-6.9s per navigation,
// because the FIRST wtype pass dropped characters every time and only the
// clipboard-paste RETRY landed. That is a guaranteed wasted type + verify +
// re-resolve on the one input shape that is both long and completely
// unforgiving of a dropped character (a mangled URL 404s or, worse, becomes a
// search query). Paste delivers the whole value in one event, so for this one
// shape we do the proven thing first instead of last.
//
// The gate is deliberately NARROW — everything not listed keeps typing:
//   - backend must be "headless". On the real desktop wl-copy would clobber
//     the user's own clipboard, and the keystroke-drop this works around is a
//     nested-compositor-under-load phenomenon that doesn't happen there.
//   - the target must be the trusted omnibox (isOmniboxTarget: browser-chrome
//     entry carrying the address bar's accessible name). In-document fields
//     keep typing: clipboard paste is PROVEN not to land in freshly-focused
//     web inputs under the nested compositor (see the focus-recovery note in
//     index.js), so pasting there would silently leave the field empty.
//   - combo/recovery targets are excluded outright. They restructure on focus,
//     and their whole recovery path is built around typing into a replacement
//     input that mounted elsewhere.
//   - the value must be an http(s) URL. Non-URL omnibox text is a search
//     query: short, tolerant of a retry, and not worth touching the clipboard
//     for.
// Anything unexpected (missing element, odd backend, unparseable value) fails
// CLOSED to typing — the behavior that shipped before this change.
import { isOmniboxTarget } from "./submit_safety.js";

// An http(s) URL, in the strict sense the omnibox needs: no surrounding or
// embedded whitespace (a value with a space is text the user wants searched,
// even if it starts with "https://"), and a real parse — so "amazon.com",
// "about:blank", "javascript:...", and "file:///..." are all NOT URLs here.
//
// The RAW value is classified, never a trimmed copy (review finding): the
// caller pastes/types the ORIGINAL string, so trimming here would classify one
// value and deliver a different one. A value that is not already clean is not
// a URL for this purpose — it falls through to typing, unchanged. The single
// /\s/ test enforces that: it is false for any string with leading, trailing,
// or embedded whitespace, i.e. exactly the strings where raw !== raw.trim(),
// plus the embedded-space case.
export function isHttpUrlValue(value) {
  const v = String(value ?? "");
  if (!v || /\s/.test(v)) return false;
  let u;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol === "view-source:") return isHttpUrlValue(v.slice("view-source:".length)); // the page's own source
  return u.protocol === "http:" || u.protocol === "https:";
}

// Should the FIRST entry attempt be a clipboard paste rather than wtype?
// Every condition must hold; see the file header for why each one is there.
export function shouldPasteUrlFirst({ backend, element, value, wantRecovery } = {}) {
  if (backend !== "headless") return false;
  if (wantRecovery) return false;
  if (!isOmniboxTarget(element)) return false;
  return isHttpUrlValue(value);
}

// Perform one entry attempt and report which method actually delivered the
// value. Paste gets exactly ONE shot: if wl-copy cannot establish the
// selection it REJECTS (clipboard.js is explicit about never falling through
// to a stale-clipboard paste), and we fall back to the same wtype call the
// caller would have made anyway. The caller's verification, single retry and
// safe-submit gate are unchanged and still judge the result either way.
export async function enterValue({ pasteFirst, paste, type }) {
  if (pasteFirst) {
    try {
      await paste();
      return "clipboard paste";
    } catch {
      await type();
      return "typing (paste rejected)";
    }
  }
  await type();
  return "typing";
}
