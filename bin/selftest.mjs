// Starts the MCP server over stdio, lists its tools and asks Hyprland for the active workspace.
// Prints a one-line summary; exits non-zero on failure. Used by `omarchy-computer-use doctor`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const index = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const client = new Client({ name: "omarchy-computer-use-selftest", version: "1.0.0" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [index], stderr: "ignore" }));
  const { tools } = await client.listTools();
  let ws = "no Hyprland session";
  if (tools.some((t) => t.name === "get_active_workspace")) {
    try {
      const r = await client.callTool({ name: "get_active_workspace", arguments: {} });
      const text = (r.content || []).map((c) => c.text || "").join(" ").replace(/\s+/g, " ").trim();
      ws = r.isError ? `desktop not reachable (${text.slice(0, 80)})` : `active workspace ${text.slice(0, 60)}`;
    } catch (e) { ws = `desktop not reachable (${String(e.message).slice(0, 80)})`; }
  }
  console.log(`${tools.length} tools; ${ws}`);
  await client.close();
  process.exit(tools.length > 0 ? 0 : 1);
} catch (e) {
  console.log(String(e.message || e).slice(0, 200));
  process.exit(1);
}
