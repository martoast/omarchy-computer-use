// Bounded, text-free record of how an instance's Chromium ENDED.
//
// Live evidence (REI on 67a7fd4): target_pid_alive=false, no window, and a
// healthy registry — the browser process was simply gone, and nothing recorded
// why. The decisive datum is its exit code or signal: a normal exit(0) means
// something closed the last window, a signal means a crash. Those need opposite
// fixes and the harness could not tell them apart.
//
// TEXT NEVER LEAVES MEMORY. The stderr ring exists only to derive fixed marker
// enums and byte counts; no captured byte is ever serialized to disk or
// forwarded to a model. Chromium's stderr can carry profile paths and, in some
// builds, page-authored console output, so treating it as reportable text would
// leak both a filesystem layout and page-controlled strings.

export const EXIT_LOG_BASENAME = "chromium-exit.json";
export const EXIT_RECORD_SCHEMA = "chromium-exit/1";
export const MAX_EXIT_LOG_BYTES = 4096;
export const STDERR_MAX_BYTES = 64 * 1024;
export const STDERR_MAX_LINES = 200;
// Longest run of bytes carried between chunks so a marker split across two
// stdout reads is still recognised. Bounded, so it can never grow.
export const MARKER_CARRY_CHARS = 256;
// Sanity ceilings for values read back from disk. A record is only consulted
// when something already went wrong; an absurd number is corruption, not data.
const MAX_PID = 2 ** 31 - 1;
const MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOTAL_BYTES = Number.MAX_SAFE_INTEGER;

// Chromium's OWN crash signatures. Fixed, closed set: the record carries which
// of these matched, never the text that matched them. Corroborative only —
// exit code and signal are the authoritative half — because a page that prints
// to the console can in principle flip one of these without anything crashing.
export const STDERR_MARKERS = Object.freeze([
  ["received_signal", /Received signal \d+/],
  ["check_failed", /Check failed:/],
  ["fatal_error", /FATAL:/],
  ["sigsegv", /SIGSEGV/],
  ["sigabrt", /SIGABRT/],
  ["out_of_memory", /Out of memory|OOM/],
  ["gpu_process_exited", /GPU process exited unexpectedly/],
]);
const MARKER_NAMES = Object.freeze(STDERR_MARKERS.map(([name]) => name));

export const EXIT_STATES = Object.freeze(["running", "exited", "closed"]);
const REQUIRED_KEYS = Object.freeze([
  "schema", "state", "leader_pid", "window_pid", "exit_code", "exit_signal",
  "ms_from_spawn", "stderr", "markers",
]);

/** Last-N-bytes / last-N-lines of stderr, held ONLY in the runner's memory.
 *
 * Two things are deliberately decoupled:
 *   - byte COUNTS are taken from the raw buffer BEFORE any decoding, so a
 *     multi-byte or truncated-UTF-8 chunk is measured as the browser actually
 *     wrote it rather than as a lossy decode of it;
 *   - MARKERS are detected incrementally AS DATA ARRIVES, with a bounded carry
 *     across chunk boundaries. Deriving them from the ring instead would lose a
 *     real crash signature the moment eviction dropped the line that carried
 *     it, which is exactly when it matters most. */
export class BoundedStderr {
  constructor(maxBytes = STDERR_MAX_BYTES, maxLines = STDERR_MAX_LINES) {
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
    this.totalBytes = 0;
    this.truncated = false;
    // RAW BYTES, retained verbatim including delimiters and any trailing
    // partial line. An earlier version stored split("\n") line text, which
    // silently dropped every newline from the retained count — so ordinary
    // untruncated output reported total > captured with truncated=false, a
    // shape the validator (correctly) rejects. The recorder was failing its own
    // schema. Keeping raw bytes makes captured == total whenever nothing was
    // dropped, which is the invariant the record actually claims.
    this._buf = Buffer.alloc(0);
    this._seen = new Set();
    this._carry = "";
  }
  push(chunk) {
    // RAW byte count first, before any decode can change the length.
    const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""), "utf8");
    if (raw.length === 0) return;
    this.totalBytes += raw.length;

    // Incremental marker detection over carry+text, so a signature split
    // across two chunks is still found, and so eviction below can never erase
    // a signature that was genuinely seen.
    const scan = this._carry + raw.toString("utf8");
    for (const [name, pattern] of STDERR_MARKERS) {
      if (!this._seen.has(name) && pattern.test(scan)) this._seen.add(name);
    }
    this._carry = scan.slice(-MARKER_CARRY_CHARS);

    this._buf = this._buf.length ? Buffer.concat([this._buf, raw]) : Buffer.from(raw);
    if (this._buf.length > this.maxBytes) {
      this._buf = Buffer.from(this._buf.subarray(this._buf.length - this.maxBytes));
      this.truncated = true;
    }
    // Line cap, counted in retained newline bytes so it stays exact.
    let newlines = 0;
    for (const byte of this._buf) if (byte === 0x0a) newlines += 1;
    while (newlines > this.maxLines) {
      const idx = this._buf.indexOf(0x0a);
      if (idx === -1) break;
      this._buf = Buffer.from(this._buf.subarray(idx + 1));
      newlines -= 1;
      this.truncated = true;
    }
  }
  get capturedBytes() {
    return this._buf.length;
  }
  /** Names only, in the module's fixed order, never the text that matched. */
  markers() {
    return MARKER_NAMES.filter((name) => this._seen.has(name));
  }
  stats() {
    return { total_bytes: this.totalBytes, captured_bytes: this._buf.length, truncated: this.truncated };
  }
}

/** The record written immediately after spawn, so an observer never races a
 * missing file and can distinguish "not yet ended" from "no record at all".
 * No epoch timestamp is persisted: the only time value that matters is the
 * MONOTONIC delta, and an epoch field would be a wall-clock value nothing
 * needs and every reader could misread. */
export function runningRecord({ leaderPid, windowPid = null }) {
  return {
    schema: EXIT_RECORD_SCHEMA,
    state: "running",
    leader_pid: leaderPid,
    window_pid: windowPid,
    exit_code: null,
    exit_signal: null,
    ms_from_spawn: null,
    stderr: { total_bytes: 0, captured_bytes: 0, truncated: false },
    markers: [],
  };
}

/** Fold one lifecycle event into the record.
 *
 * `exit` is AUTHORITATIVE for code/signal; `close` only means the stdio streams
 * finished and must never overwrite an exit verdict — the two events can arrive
 * in either order, and a close-after-exit that clobbered the code would destroy
 * the one datum this whole mechanism exists to capture.
 *
 * Node reports EITHER a code OR a signal, never both; the record keeps that
 * exclusivity so a reader never has to choose between two verdicts. */
export function applyExitEvent(record, { event, code = null, signal = null, msFromSpawn = null, stderr = null, markers = null, windowPid = undefined }) {
  const next = { ...record };
  if (windowPid !== undefined) next.window_pid = windowPid;
  if (stderr) next.stderr = { ...stderr };
  if (markers) next.markers = [...markers];
  if (event === "exit") {
    next.state = "exited";
    const hasSignal = typeof signal === "string" && signal.length > 0;
    next.exit_signal = hasSignal ? signal : null;
    next.exit_code = hasSignal ? null : (Number.isInteger(code) ? code : null);
    // An exit with neither is not describable as exited; keep it honest.
    if (next.exit_signal === null && next.exit_code === null) next.state = "closed";
    next.ms_from_spawn = msFromSpawn;
  } else if (event === "close") {
    if (record.state !== "exited") next.state = "closed";
    if (record.ms_from_spawn == null) next.ms_from_spawn = msFromSpawn;
  }
  return next;
}

const boundedInt = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const isPidOrNull = (v) => v === null || (Number.isSafeInteger(v) && v > 0 && v <= MAX_PID);

/** Strict validation of a record read back from disk. Anything unexpected is a
 * refusal with a reason, never a partially-trusted record: this file is read
 * only when something has already gone wrong, so a malformed or CONTRADICTORY
 * one must not turn into a confident claim. */
export function validateExitRecord(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "not an object" };
  // Schema FIRST: it is the version gate, and a record from another version
  // should be refused as such rather than described by whichever key it happens
  // to be missing.
  if (parsed.schema !== EXIT_RECORD_SCHEMA) return { ok: false, reason: "unknown schema" };
  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) return { ok: false, reason: `missing ${key}` };
  }
  if (!EXIT_STATES.includes(parsed.state)) return { ok: false, reason: "unknown state" };
  if (parsed.leader_pid === null || !isPidOrNull(parsed.leader_pid)) return { ok: false, reason: "bad leader_pid" };
  if (!isPidOrNull(parsed.window_pid)) return { ok: false, reason: "bad window_pid" };
  if (parsed.exit_code !== null && !(Number.isSafeInteger(parsed.exit_code) && parsed.exit_code >= 0 && parsed.exit_code <= 255)) {
    return { ok: false, reason: "bad exit_code" };
  }
  if (parsed.exit_signal !== null && !(typeof parsed.exit_signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(parsed.exit_signal))) {
    return { ok: false, reason: "bad exit_signal" };
  }
  if (parsed.ms_from_spawn !== null && !boundedInt(parsed.ms_from_spawn, MAX_MS)) return { ok: false, reason: "bad ms_from_spawn" };

  // STATE INVARIANTS: reject shapes that contradict themselves.
  if (parsed.state === "running") {
    if (parsed.exit_code !== null || parsed.exit_signal !== null || parsed.ms_from_spawn !== null) {
      return { ok: false, reason: "running record carries an outcome" };
    }
  } else if (parsed.state === "exited") {
    const hasCode = parsed.exit_code !== null;
    const hasSignal = parsed.exit_signal !== null;
    if (hasCode === hasSignal) return { ok: false, reason: "exited needs exactly one of code or signal" };
    if (parsed.ms_from_spawn === null) return { ok: false, reason: "exited without timing" };
  } else if (parsed.state === "closed") {
    if (parsed.exit_code !== null || parsed.exit_signal !== null) return { ok: false, reason: "closed carries an outcome" };
    if (parsed.ms_from_spawn === null) return { ok: false, reason: "closed without timing" };
  }

  const s = parsed.stderr;
  if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, reason: "bad stderr counts" };
  if (!boundedInt(s.total_bytes, MAX_TOTAL_BYTES) || !boundedInt(s.captured_bytes, STDERR_MAX_BYTES) || typeof s.truncated !== "boolean") {
    return { ok: false, reason: "bad stderr counts" };
  }
  if (s.captured_bytes > s.total_bytes) return { ok: false, reason: "captured exceeds total" };
  if (s.total_bytes > s.captured_bytes && s.truncated !== true) return { ok: false, reason: "dropped bytes without truncated" };

  if (!Array.isArray(parsed.markers)) return { ok: false, reason: "bad markers" };
  if (new Set(parsed.markers).size !== parsed.markers.length) return { ok: false, reason: "duplicate markers" };
  if (!parsed.markers.every((m) => MARKER_NAMES.includes(m))) return { ok: false, reason: "unknown marker" };
  return { ok: true, record: parsed };
}

/** One line, enums and numbers only.
 *
 * `leaderLive` is a FRESH liveness probe, reported separately and never merged
 * with the record's own state: a leader that is still running does NOT mean the
 * browser is healthy — Chromium re-execs through a zygote, so the spawned
 * leader and the window's owner can be different processes. */
export function formatExitDiagnostic(validation, leaderLive) {
  if (!validation || validation.ok !== true) {
    return `[chromium exit diagnostic unavailable: ${validation?.reason || "not attempted"}]`;
  }
  const r = validation.record;
  // Validation guarantees exactly one of code/signal when exited, so this can
  // never render a null verdict.
  const verdict = r.state === "exited"
    ? (r.exit_signal !== null ? `signal:${r.exit_signal}` : `code:${r.exit_code}`)
    : r.state;
  const live = leaderLive === true ? "true" : leaderLive === false ? "false" : "unknown";
  return `[chromium exit diagnostic: leader_pid=${r.leader_pid} leader_exit=${verdict} `
    + `leader_pid_matches_window_pid=${r.window_pid === null ? "unknown" : r.leader_pid === r.window_pid} `
    + `leader_alive_now=${live} ms_from_spawn=${r.ms_from_spawn ?? "unknown"} `
    + `stderr_total_bytes=${r.stderr.total_bytes} stderr_captured_bytes=${r.stderr.captured_bytes} `
    + `stderr_truncated=${r.stderr.truncated} markers=[${r.markers.join(",")}] `
    + `(exit code/signal is authoritative; markers are corroborative only; a live leader does not prove a healthy browser)]`;
}
