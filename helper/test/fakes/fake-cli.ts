import { afterEach, expect } from "bun:test";
import type { RunOptions, RunResult } from "../../src/process.ts";
import { FakeProcessRunner } from "./fake-process.ts";

/**
 * A stand-in for the `claude` CLI that behaves the way the real one was seen to behave, and refuses (and
 * remembers) anything the real one would not take:
 *
 *  - `agents --json [--all]` lists sessions as JSON rows. A background row has `id` (8 hex), `sessionId`,
 *    `kind: "background"`, `cwd`, `name`, `state` (working | done | blocked), `status` (idle | busy | null) and
 *    `pid` (null once stopped). An interactive row has `pid`, `sessionId`, `kind: "interactive"`, `name`,
 *    `status` and no `id`. Without `--all` only live rows are listed.
 *  - `--bg --resume <id|sessionId> <prompt>` with NO other flag wakes a stopped session under its own id. On a
 *    session whose process is alive it starts a COPY under a new id. ANY extra flag also starts a copy.
 *  - `stop <id>` stops a background session (its pid becomes null).
 *
 * Nothing real is started. Every violation fails the test that caused it, when it ends.
 */
export const BIN = "/opt/tools/claude";

export type RowState = "working" | "done" | "blocked";
export type RowStatus = "idle" | "busy" | null;

export interface FakeRow {
  id?: string;
  sessionId: string;
  kind: "background" | "interactive";
  cwd: string;
  name: string;
  state?: RowState;
  status: RowStatus;
  pid: number | null;
  /** Set on a copy: the session it copies. */
  copyOf?: string;
}

export interface Launch {
  kind: "wake" | "copy";
  argv: string[];
  prompt: string;
  cwd: string | undefined;
  row: FakeRow;
}

const instances: FakeCli[] = [];
afterEach(() => {
  const all = instances.splice(0);
  for (const cli of all) expect(cli.violations).toEqual([]);
});

export class FakeCli extends FakeProcessRunner {
  readonly rows: FakeRow[] = [];
  readonly launches: Launch[] = [];
  /** Short ids passed to `stop`, in order. */
  readonly stops: string[] = [];
  /** Things the real CLI would not accept. Must stay empty. */
  readonly violations: string[] = [];

  /** The `agents` call fails with this exit code. */
  listCode = 0;
  /** Every `--bg` launch exits with this code (and prints `launchError`). */
  launchCode = 0;
  launchError = "failed";
  /** A resume of a session the CLI does not know fails like this. */
  notFoundText = "error: no conversation found with session ID";
  /** `stop` fails with this exit code. */
  stopCode = 0;
  /** A launch whose output cannot be read (no `backgrounded · id` line). */
  quietLaunch = false;
  /** A resume that says it worked but leaves the session stopped (it never shows up alive). */
  launchNeverStarts = false;
  /** Runs at the start of a launch: a test uses it to change the world between the list and the launch. */
  beforeLaunch: (() => void) | null = null;

  /** Sessions that can be resumed but that the list does not show (an interactive session that ended). */
  private readonly closed = new Set<string>();
  private readonly bins: Set<string>;
  private nextRow = 1;
  private nextCliPid = 7000;

  constructor(opts: { bins?: readonly string[] } = {}) {
    super();
    this.bins = new Set(opts.bins ?? [BIN]);
    instances.push(this);
    this.on((cmd, runOpts) => (this.bins.has(cmd[0] ?? "") ? this.handle(cmd, runOpts) : undefined));
  }

  // ---- what the tests set up ---------------------------------------------

  /** A session in the background with a live process. */
  addBackground(o: { sessionId: string; state?: RowState; status?: RowStatus; cwd?: string; id?: string; name?: string }): FakeRow {
    const row: FakeRow = {
      id: o.id ?? this.shortId(),
      sessionId: o.sessionId,
      kind: "background",
      cwd: o.cwd ?? "/work/demo",
      name: o.name ?? "demo",
      state: o.state ?? "working",
      status: o.status === undefined ? "busy" : o.status,
      pid: this.nextCliPid++,
    };
    this.rows.push(row);
    return row;
  }

  /** A background session that finished and whose process is still alive. */
  addIdle(sessionId: string): FakeRow {
    return this.addBackground({ sessionId, state: "done", status: "idle" });
  }

  /** A background session that was stopped (no process). */
  addStopped(sessionId: string): FakeRow {
    const row = this.addBackground({ sessionId, state: "done", status: null });
    row.pid = null;
    return row;
  }

  /** A session open in the desktop app, VS Code or a terminal. */
  addInteractive(sessionId: string, status: RowStatus = "idle", name = "demo"): FakeRow {
    const row: FakeRow = { sessionId, kind: "interactive", cwd: "/work/demo", name, status, pid: this.nextCliPid++ };
    this.rows.push(row);
    return row;
  }

  /** A session that ended: not listed, but `--resume` finds it. */
  addClosed(sessionId: string): void {
    this.closed.add(sessionId);
  }

  row(sessionId: string): FakeRow | undefined {
    return this.rows.find((r) => r.sessionId === sessionId);
  }

  /** Is this process id one of the fake's live processes? (The helper's `pidAlive` in tests.) */
  pidAlive = (pid: number): boolean => this.rows.some((r) => r.pid === pid);

  wakes(): Launch[] {
    return this.launches.filter((l) => l.kind === "wake");
  }

  copies(): Launch[] {
    return this.launches.filter((l) => l.kind === "copy");
  }

  /** Every `--bg` command line, as given. */
  launchLines(): string[][] {
    return this.runs.filter((r) => r.cmd[1] === "--bg").map((r) => r.cmd);
  }

  // ---- the CLI itself ----------------------------------------------------------

  private shortId(): string {
    return (0x1000_0000 + this.nextRow++).toString(16);
  }

  private uuid(): string {
    return `00000000-0000-4000-8000-${String(this.nextRow++).padStart(12, "0")}`;
  }

  private ok(stdout: string): RunResult {
    return { code: 0, stdout, stderr: "" };
  }

  private fail(code: number, stderr: string): RunResult {
    return { code, stdout: "", stderr };
  }

  private handle(cmd: string[], opts: RunOptions): RunResult {
    const rest = cmd.slice(1);
    if (rest[0] === "agents") return this.agents(rest.slice(1));
    if (rest[0] === "stop") return this.stop(rest.slice(1));
    if (rest[0] === "--bg") return this.background(rest.slice(1), opts.cwd);
    this.violations.push(`unexpected command: ${rest.join(" ")}`);
    return this.fail(64, "error: unknown command");
  }

  private agents(args: string[]): RunResult {
    const all = args.includes("--all");
    if (!args.every((a) => a === "--json" || a === "--all") || !args.includes("--json")) {
      this.violations.push(`agents called with ${JSON.stringify(args)}`);
      return this.fail(64, "error: bad arguments");
    }
    if (this.listCode !== 0) return this.fail(this.listCode, "error: list failed");
    const visible = this.rows.filter((r) => all || r.pid !== null);
    return this.ok(JSON.stringify(visible.map(toJson)));
  }

  private stop(args: string[]): RunResult {
    const [id, ...extra] = args;
    if (id === undefined || extra.length > 0) {
      this.violations.push(`stop called with ${JSON.stringify(args)}`);
      return this.fail(64, "error: bad arguments");
    }
    this.stops.push(id);
    if (this.stopCode !== 0) return this.fail(this.stopCode, "error: could not stop");
    const row = this.rows.find((r) => r.id === id);
    if (!row) return this.fail(1, `error: no session with id ${id}`);
    row.pid = null;
    row.status = null;
    return this.ok(`stopped ${id}\n`);
  }

  private background(args: string[], cwd: string | undefined): RunResult {
    const prompt = args.at(-1);
    const flags = args.slice(0, -1);
    if (prompt === undefined || prompt.startsWith("-")) {
      this.violations.push("the prompt is not the last word");
      return this.fail(64, "error: no prompt");
    }
    this.beforeLaunch?.();
    if (this.launchCode !== 0) return this.fail(this.launchCode, this.launchError);
    const resumeAt = flags.indexOf("--resume");
    if (resumeAt < 0) {
      this.violations.push("a background session was created; the helper only ever resumes");
      return this.fail(64, "error: not expected");
    }
    return this.resume(flags, resumeAt, prompt, cwd, ["--bg", ...args]);
  }

  private resume(flags: string[], resumeAt: number, prompt: string, cwd: string | undefined, argv: string[]): RunResult {
    const ref = flags[resumeAt + 1];
    const extra = flags.filter((_, i) => i !== resumeAt && i !== resumeAt + 1);
    if (ref === undefined) {
      this.violations.push("--resume without an id");
      return this.fail(64, "error: --resume needs an id");
    }
    let target = this.rows.find((r) => r.sessionId === ref || r.id === ref);
    if (!target && this.closed.has(ref)) {
      target = { sessionId: ref, kind: "background", cwd: cwd ?? "/", name: "demo", state: "done", status: null, pid: null };
      this.rows.push(target);
    }
    if (!target) return this.fail(1, `${this.notFoundText}: ${ref}`);
    if (extra.length > 0) this.violations.push(`resume with extra flags: ${extra.join(" ")}`);
    const live = target.pid !== null;
    if (live || extra.length > 0) {
      const copy: FakeRow = {
        id: this.shortId(),
        sessionId: this.uuid(),
        kind: "background",
        cwd: cwd ?? target.cwd,
        name: `${target.name} (copy)`,
        state: "working",
        status: "busy",
        pid: this.nextCliPid++,
        copyOf: target.sessionId,
      };
      this.rows.push(copy);
      this.launches.push({ kind: "copy", argv, prompt, cwd, row: copy });
      const why = `session ${target.id ?? target.sessionId} is already running, so this started a copy`;
      return this.ok(this.quietLaunch ? `${why}\n` : `${why}\nbackgrounded · ${copy.id}\n`);
    }
    if (!target.id) target.id = this.shortId();
    if (!this.launchNeverStarts) {
      target.pid = this.nextCliPid++;
      target.kind = "background";
      target.state = "working";
      target.status = "busy";
    }
    this.launches.push({ kind: "wake", argv, prompt, cwd, row: target });
    return this.ok(this.quietLaunch ? "woke the session\n" : `woke session ${target.id} with its saved options\nbackgrounded · ${target.id}\n`);
  }
}

function toJson(row: FakeRow): Record<string, unknown> {
  if (row.kind === "interactive") {
    return { pid: row.pid, sessionId: row.sessionId, kind: "interactive", name: row.name, status: row.status };
  }
  return { id: row.id, sessionId: row.sessionId, kind: "background", cwd: row.cwd, name: row.name, state: row.state, status: row.status, pid: row.pid };
}
