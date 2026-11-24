# omarchy-computer-use

Computer use for [Omarchy](https://omarchy.org): an MCP server that lets an AI agent (Claude Code, Codex, or any MCP
client) operate your Hyprland desktop and browser.

It works the way a screen reader does. Instead of guessing from screenshots, it reads the Linux accessibility tree
(AT-SPI) for every element's role, name, state and position, and acts with virtual keyboard and mouse input. A page
becomes a short, exact list like `e12 push button "Sign in" @640,212`, so the agent clicks the right thing the first
time and spends a fraction of the tokens a screenshot costs. Screenshots are still there for what the tree can't see
(canvas, images).

## Install

On Omarchy (or any Arch + Hyprland setup), as your normal user:

```sh
curl -fsSL https://raw.githubusercontent.com/martoast/omarchy-computer-use/main/get.sh | bash
```

Then restart Chromium once and open Claude Code or Codex: the `omarchy-desktop` tools are already registered.

The script asks for your sudo password for the packages and one udev rule. It's safe to run again; it only adds what
is missing. No log-out needed.

<details>
<summary>What the installer does</summary>

1. **Packages:** `ydotool` (mouse), `wtype` (keyboard), `grim` (screenshots), `python-gobject` + `at-spi2-core`
   (reading the accessibility tree), `sway` + `wlrctl` (only for the headless mode), `nodejs` + `npm`.
2. **Input:** a udev rule so your user can use `/dev/uinput`, and the `ydotoold` user service.
3. **Accessibility:** turns on GNOME's `toolkit-accessibility`, switches the accessibility bus on for the current
   session, and adds `--force-renderer-accessibility` to `~/.config/chromium-flags.conf` (Chromium only exposes its
   page tree with it).
4. **`npm ci`** in `~/.local/share/omarchy-computer-use` (two dependencies: the MCP SDK and zod).
5. **Registers** the MCP server `omarchy-desktop` with Claude Code (user scope) and Codex, if installed, including
   the ones Omarchy installs through mise.
6. Creates an empty plugin list and the `omarchy-computer-use` command, then runs the health check.

</details>

## Commands

```sh
omarchy-computer-use doctor      # check everything; starts the server and talks to Hyprland
omarchy-computer-use update      # pull the latest version, reinstall deps, re-register
omarchy-computer-use register    # register with Claude Code / Codex again (e.g. after installing one)
omarchy-computer-use uninstall   # unregister and remove the command (packages and the udev rule stay)
```

Using another MCP client? Point it at `node ~/.local/share/omarchy-computer-use/index.js` (stdio).

## Tools

| Group | Tools |
|---|---|
| **See** | `read_page` (the main one: the page as a list of elements), `page_text`, `list_images`, `get_page_url`, `element_at`, `get_focus_class`, `screenshot` |
| **Act on elements** | `click_element`, `press_element`, `type_into_element`, `select_option`, `read_selected_option`, `focus_field`, `scroll_to_element`, `check_field_values` |
| **Wait** | `wait_for_element`, `wait_page_settled`, `read_after_navigation` |
| **Get unstuck** | `dismiss_dialog` (cookie/consent and pop-up overlays), `escape_page`, `recover_visual_overlay` |
| **Menus** | `hover_element` (opens hover menus and mega menus, returns the links that appeared) |
| **Windows** | `list_windows`, `get_active_window`, `focus_window`, `get_active_workspace`, `move_window_to_workspace` |
| **Raw input** | `click`, `move_mouse`, `scroll`, `type_text`, `key_press`, `pointer_button`, `focus_editable_at` |
| **Site memory** | `get_site_map`, `save_site_map`, `list_known_sites` |

Elements are addressed by a `ref` from `read_page` (`e42`) or by their accessible name. Roles use AT-SPI names
("push button", "entry", "combo box"); passing "button" or "textbox" fails fast with a suggestion.

## Safety

- **It never submits a payment, places an order, or presses another irreversible button on its own.** The core's click
  and press tools refuse those buttons and leave them to you.
- When a site shows a human check (CAPTCHA, "press and hold"), the agent stops and hands it to you. It never presses
  it.
- It never reads saved-card numbers or the browser's saved-address dropdown text.
- It drives your real desktop: the mouse and keyboard move while it works. For unattended work use the headless mode.

## Headless mode

`AUTOMATION_BACKEND=headless` drives an isolated nested sway compositor with its own Chromium profile instead of your
desktop, so several can run side by side without touching your session. See `headless_instance.mjs`.

## Site memory and privacy

What the agent learns about a site (navigation, form fields, a search URL) is saved on your machine in
`~/.local/share/omarchy-computer-use/sites` (or `$COMPUTER_USE_SITEMAP_DIR`). It starts empty and never leaves your
machine. It records the page's labels and links, not what you type, and drops anything that looks like a street address,
a postal code or another person's name in a review before writing.

## Plugins

Other projects can add their own tools. List plugin modules in `~/.config/omarchy-computer-use/plugins.json`:

```json
{ "plugins": ["/path/to/my-plugin.mjs"] }
```

or set `COMPUTER_USE_PLUGINS` (it wins over the file, even when empty). A plugin exports
`register({ server, z, page, siteMemory })` and calls `server.tool(...)` like the core does. A plugin that fails to
load is skipped, the core keeps working, and `omarchy-computer-use doctor` shows why. A plugin runs with the same
access as the core, and the safety rules above are built into the core's own tools, so only add plugins you trust.

## Troubleshooting

- **`read_page` says "no AT-SPI application found"**: restart Chromium (it reads the accessibility setting at start).
  `doctor` checks the accessibility bus and the Chromium flag.
- **`/dev/uinput not writable`**: log out and back in once, or run the installer again.
- **Nothing happens on screen**: `systemctl --user status ydotool`.

## Development

```sh
npm ci
node run_suites.mjs     # all suites: pure JS + Python, and the live ones in their own headless compositor
```

## License

MIT © Alex Martos
