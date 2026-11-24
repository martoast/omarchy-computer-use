# The normalized observation (v1)

One fixed shape for **what is on the page** and **what the last action did**, the same on every site and from every
tool. It is built for a small local model first (stable fields, a closed vocabulary, no prose), and rendered as
compact text for a large one. Code: `observation.mjs` (pure functions), tests: `test_observation.mjs`,
`test_observation_bridge.py`.

## Switches

| Setting | Effect |
|---|---|
| `read_page` `format: "compact"`, or `COMPUTER_USE_READ_FORMAT=compact` | `read_page` answers with the rendered observation; every action result starts with one `LAST …` outcome line |
| `COMPUTER_USE_OBSERVATION=1` | `read_page` also returns the observation object, and every action its outcome object, as `structuredContent` (for a local executor or a training log) |
| neither (default) | unchanged: the classic text format |

## Observation

```js
{
  v: 1,
  page: { url, host, path, title, loading: bool, dialogs: n },
  elements: [{ ref, role, name, value?, states: [], region, view, href?, off_site?, dup? }],
  omitted: { above: n, below: n, budget: n },
}
```

| Field | Values |
|---|---|
| `role` | `button toggle link textbox password dropdown checkbox radio menuitem tab slider number heading image dialog text` (16; AT-SPI's names mapped, e.g. `push button` and `button` are one) |
| `name` | whitespace collapsed, zero-width characters removed, one line, at most 80 characters (`…`) |
| `value` | a text box's current contents (never a password, payment or identity field), or a slider's value |
| `states` | subset of `checked selected expanded disabled focused`, always in that order; a pressed toggle is `checked` |
| `region` | `browser` (the address bar), `dialog` (an open overlay wins over everything), `header nav search main aside footer` from the page's ARIA landmarks; a page without landmarks is all `main` |
| `view` | `in`, `above`, `below` the visible window |
| `href` | a path for same-site links, `host/path` for others (no query), at most 100 characters |
| `dup` | how many identical rows (same role, name, href, region, value) were merged into this one; the in-view copy's ref is kept |

**Order:** the browser row, then the open dialog (it covers the page), then the page in document order.
**Budget:** every row in view, in a dialog or in the browser is kept; the rest is kept in page order up to the budget
(250), and what is cut is only counted, so the size stays bounded on a 3,000-node page.
**Never in it:** browser chrome without a ref, nameless images and text, a password or payment field's contents.

### Rendered (compact text)

```
PAGE bandcamp.com /discover/classical/vinyl | "Classical vinyl on Bandcamp" | ready | 1 dialog
[browser]
e783 textbox "Address and search bar"
[dialog]
e784 dialog "We care about your privacy"
e787 button "Accept all"
[search]
e791 textbox "Search for artist, album or track"
[main]
e802 radio "vinyl" (checked)
e798 button "next" x2
e811 link "Live at Olympia" -> imperialtriumphant.bandcamp.com/album/live-at-olympia [below]
... 212 more below
```

One header line, region headers, one line per element:
`<ref> <role> "<name>" [= "<value>"] [(states)] [-> href [off-site]] [[above|below]] [xN]`.
Names are JSON-quoted, so a page cannot forge a row.

## Outcome

```js
{ tool, target?, outcome, changed: { url?, dialogs?, focus?, checked?, expanded?, selected? }, detail }
```

| `outcome` | Meaning |
|---|---|
| `ok` | done and verified on the page (state read back, a transition observed, the URL changed) |
| `no_change` | done, but the page did not change (not scrolled, Escape left the overlay) |
| `unverified` | sent, but the page gave no proof either way (also every raw coordinate click) |
| `refused` | the core would not do it (browser control, purchase, human check) |
| `failed` | not done (no such element or option, a stale ref, a bad argument) |
| `blocked` | the site put up a CAPTCHA or a block page |

Rendered: `LAST click_element e65 -> ok (dialogs=1 focus=button)`.

The outcome comes from what the core's own verification saw on the page, not from a model, so it is also the label
a training example gets.
