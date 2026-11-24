import "./test_support/temp_site_memory.mjs"; // never the user's own site memory
import { spawnHeadlessInstance, teardownHeadlessInstance, instanceEnv } from "./headless_instance.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function runOne(url, label) {
  const start = Date.now();
  const handle = await spawnHeadlessInstance({ label });
  let client;
  try {
    const transport = new StdioClientTransport({
      command: "node",
      args: ["index.js"],
      cwd: import.meta.dirname,
      env: { ...process.env, ...instanceEnv(handle) },
    });
    client = new Client({ name: `test-${label}`, version: "0.1.0" });
    await client.connect(transport);

    await client.callTool({
      name: "type_into_element",
      arguments: { text: "Address and search bar", role: "entry", value: url, clear: true, press_enter: true },
    });
    await new Promise((r) => setTimeout(r, 2500));
    const text = (await client.callTool({ name: "read_page", arguments: { include_text: true, limit: 5 } })).content[0].text;
    const elapsedMs = Date.now() - start;
    return { label, elapsedMs, snippet: text.slice(0, 150) };
  } finally {
    await client?.close().catch(() => {});
    await teardownHeadlessInstance(handle);
  }
}

console.log("launching 2 instances truly concurrently...");
const overallStart = Date.now();
const results = await Promise.all([
  runOne("https://www.wikipedia.org/", "A-wikipedia"),
  runOne("https://www.wiktionary.org/", "B-wiktionary"),
]);
console.log(`total wall-clock: ${Date.now() - overallStart}ms`);
for (const r of results) console.log(r);
