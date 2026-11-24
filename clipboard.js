// Atomic clipboard paste, extracted from index.js so its failure path is
// unit-testable without importing the MCP server (which connects to stdio
// at load time).
//
// Put text on the Wayland clipboard, then paste it with ctrl+v — the whole
// value arrives in one paste event, sidestepping the per-character wtype
// key-drop that intermittently mangles typed text under headless/nested-
// compositor load (caught live: "https://owalalife.com/" typed as
// "https://owalalifcom/", a dropped "e." that silently 404'd every Owala
// run). Callers gate this to the headless backend — on the real desktop it
// would clobber the user's clipboard.
//
// Why `--foreground --paste-once`, NOT awaited (gh issue #1 follow-up):
// a Wayland clipboard SOURCE client must stay alive to serve the selection.
// A nested headless sway has no clipboard manager to take ownership, so an
// AWAITED wl-copy never returns — verified live, it hung the tool for the
// full timeout. So wl-copy runs --foreground (staying alive to serve) and
// we do NOT await its completion. Adding --paste-once makes it serve
// exactly ONE selection request (our ctrl+v) and then exit on its own — so
// no source process leaks and nothing depends on instance teardown to reap
// it.
//
// Failure detection (the review's real concern): a wl-copy that fails to
// establish the selection (bad display, missing binary) must REJECT here,
// not fall through to ctrl+v pasting whatever STALE content was already on
// the clipboard and get reported as a successful "clipboard retry". So we
// race a short window: an early error or nonzero exit rejects; still-running
// after the window means the selection is being served, so we paste. The
// caller ALSO re-verifies the field contents after pasting, so a no-op
// paste can never be mistaken for success even if this heuristic is fooled.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export async function pasteValue(value, env = process.env) {
  const child = spawn("wl-copy", ["--foreground", "--paste-once", "--", value], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));
  const settled = new Promise((resolve) => {
    child.on("error", (e) => resolve({ failed: e }));
    child.on("exit", (code) =>
      resolve({
        failed:
          code === 0
            ? new Error("wl-copy exited without serving the selection")
            : new Error(`wl-copy exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`),
      })
    );
  });
  const outcome = await Promise.race([settled, new Promise((r) => setTimeout(() => r({ alive: true }), 300))]);
  if (outcome.failed) {
    try {
      child.kill("SIGKILL");
    } catch {}
    throw outcome.failed;
  }
  child.unref(); // still serving the selection; exits when replaced or on teardown
  await execFileP("wtype", ["-s", "100", "-M", "ctrl", "-k", "v", "-m", "ctrl"], { env });
}
