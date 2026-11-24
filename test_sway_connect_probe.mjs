// Unit pins for probeSocketAccepting (headless_instance.mjs): the connect-probe that replaced the fixed 1500ms
// sway settle. bind() makes the wayland socket FILE visible before listen() accepts; the probe polls a real
// connect() until it lands. Injected connectImpl/checkAbort — no compositor needed.
import assert from "node:assert/strict";
import { probeSocketAccepting } from "./headless_instance.mjs";

// 1) refuses K times, then accepts: returns on the first success, never proceeds while refused, bounded polls.
{
  let calls = 0;
  const connectImpl = async () => { calls++; return calls > 3; }; // false,false,false,true
  const r = await probeSocketAccepting("/x/wayland-1", { connectImpl, pollMs: 1, checkAbort: () => {} });
  assert.equal(r.attempts, 4, "returned on the 4th attempt (first accepting connect)");
  assert.equal(calls, 4, "stopped probing the instant connect() succeeded");
}

// 2) accepts immediately: one attempt.
{
  let calls = 0;
  const r = await probeSocketAccepting("/x/wayland-1", { connectImpl: async () => { calls++; return true; }, checkAbort: () => {} });
  assert.equal(r.attempts, 1);
  assert.equal(calls, 1);
}

// 3) never accepts: throws the labeled timeout, does not hang.
{
  await assert.rejects(
    () => probeSocketAccepting("/x/wayland-1", { connectImpl: async () => false, timeoutMs: 40, pollMs: 5, label: "wayland socket for instance z" }),
    /Timed out after 40ms waiting for wayland socket for instance z to accept connections/,
  );
}

// 4) shutdown/abort mid-probe: checkAbort throwing bails the loop before the next connect.
{
  let calls = 0, checks = 0;
  const checkAbort = () => { checks++; if (checks === 3) throw new Error("headless instance spawn interrupted by shutdown"); };
  await assert.rejects(
    () => probeSocketAccepting("/x/wayland-1", { connectImpl: async () => { calls++; return false; }, pollMs: 1, checkAbort }),
    /interrupted by shutdown/,
  );
  assert.equal(calls, 2, "checkAbort runs before each connect; the 3rd check aborts, so connect ran only twice");
}

console.log("PASS — probeSocketAccepting: accepts / refuses-then-accepts / labeled timeout / abort-bails");
