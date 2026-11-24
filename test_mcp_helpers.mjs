// Shared MCP call helper for the test suites.
//
// It exists because of a real defect. Every suite used to define its own
// helper that injected `window_address` into EVERY call:
//     const tool = (n, a) => callTool({ name: n, arguments: { window_address, ...a } });
// Fourteen of the tools do not accept window_address at all — get_input_stats,
// click, key_press, get_site_map and the other global ones. The boundary used
// to strip the extra key silently, so nobody noticed; once it started refusing
// unknown arguments, those calls broke.
//
// Two things follow, and both are enforced here rather than left to discipline:
//
//   THE SCOPED-TOOL SET IS DERIVED FROM PRODUCTION. Which tools take a
//   window_address is read from the server's own advertised schemas at connect
//   time — never a hand-maintained list, which would drift the moment a tool
//   gained or lost the parameter.
//
//   EVERY ARGUMENT IS CHECKED AT CALL TIME. Passing a key the tool does not
//   declare throws immediately, naming the key and listing what is accepted.
//   That turns "audit the callers" from a regex sweep anyone can get wrong into
//   a property the suites enforce every time they run.

/** Build a caller bound to a connected client. Reads the advertised schemas
 * once, so the taxonomy comes from the running server. */
export async function makeCaller(mcp, { windowAddress = "headless" } = {}) {
  const { tools } = await mcp.listTools();
  const accepts = new Map();
  for (const t of tools) accepts.set(t.name, new Set(Object.keys(t.inputSchema?.properties || {})));

  const call = async (name, args = {}) => {
    const declared = accepts.get(name);
    if (!declared) throw new Error(`test helper: unknown tool "${name}" (server advertises: ${[...accepts.keys()].join(", ")})`);
    // Inject the window only where the tool actually takes one.
    const full = declared.has("window_address") ? { window_address: windowAddress, ...args } : { ...args };
    // Fail LOUDLY and locally on an undeclared key, rather than letting the
    // boundary reject it and leaving a confusing downstream symptom — that is
    // exactly how a rejected `click` once left a recovery token alive and an
    // Escape got sent.
    for (const k of Object.keys(full)) {
      if (!declared.has(k)) {
        throw new Error(`test helper: "${name}" does not accept "${k}" (accepts: ${[...declared].join(", ") || "no parameters"})`);
      }
    }
    const r = await mcp.callTool({ name, arguments: full });
    return {
      isError: !!r.isError,
      txt: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      raw: r,
    };
  };
  call.accepts = accepts;
  call.isScoped = (name) => !!accepts.get(name)?.has("window_address");
  return call;
}
