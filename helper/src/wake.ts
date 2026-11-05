import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Clock } from "./clock.ts";
import type { Logger } from "./log.ts";
import { type AgentEntry, parseAgentList } from "./names.ts";
import type { ProcessRunner } from "./process.ts";

/** The command that runs Claude Code sessions, used when `config.json` names no other path. */
export const CLAUDE_COMMAND = "claude";

/** What a woken session is told. It never starts with a dash, so the CLI cannot read it as an option. */
export function wakePrompt(message: string): string {
  return `You were woken by a Discord message in your channel: ${message}. Start the Discord listener again (session-kit:discord skill), then handle the message.`;
}

/**
 * Resume a session in the background under its own id, the prompt last. There is no other flag, ever: a
 * resume that carries one makes the CLI start a copy under a new id, because a session keeps the options it
 * was created with. The id goes in lowercase: the CLI continues a session in place only from its full id in
 * lowercase, and starts a copy for anything else.
 */
export function buildResumeCommand(o: { bin: string; sessionId: string; prompt: string }): string[] {
  return [o.bin, "--bg", "--resume", o.sessionId.toLowerCase(), o.prompt];
}

/** Terminal color and style codes, which the CLI puts around the short id when it prints in color. */
const ANSI_CODES = /\u001b\[[0-9;]*m/g;

/** The short id a launch prints on its `backgrounded · <id>` line, or null when it printed none. */
export function parseBackgroundedId(stdout: string): string | null {
  const plain = stdout.replace(ANSI_CODES, "");
  return /backgrounded\s*[^\s\w]\s*([0-9a-f]{8})\b/i.exec(plain)?.[1]?.toLowerCase() ?? null;
}

/** Does a failed resume say the session does not exist? */
export function looksNotFound(output: string): boolean {
  return /no conversation found|not found|no such session|unknown session|could(?: not|n't) find|does not exist|doesn't exist/i.test(
    output,
  );
}

/** Where a session stands, as far as waking it is concerned. */
export type SessionStatus =
  /** The CLI does not list it at all. */
  | { kind: "absent" }
  /** It is listed but has no live process. */
  | { kind: "stopped"; shortId?: string }
  /** It is open in the desktop app, VS Code or a terminal (or alive with nothing to stop it by): never resumed. */
  | { kind: "interactive" }
  /** A background session whose process lives on but is idle or finished: it can be stopped, then resumed. */
  | { kind: "idle"; shortId: string }
  /** A background session that is working, or waiting on a prompt: left alone. */
  | { kind: "busy"; blocked: boolean; shortId?: string };

/** The `state` values of a background session that has finished: done, failed, or stopped. */
const FINISHED_STATES = new Set(["done", "failed", "stopped"]);

/** Look the session up in the CLI's list. `pidAlive` guards against a row whose process is already gone. */
export function sessionStatus(entries: readonly AgentEntry[], sessionId: string, pidAlive: (pid: number) => boolean): SessionStatus {
  const wanted = sessionId.toLowerCase();
  const rows = entries.filter((e) => e.sessionId?.toLowerCase() === wanted);
  if (rows.length === 0) return { kind: "absent" };
  const live = rows.filter((e) => e.pid !== undefined && pidAlive(e.pid));
  if (live.length === 0) {
    const shortId = rows.find((e) => e.id !== undefined)?.id;
    return shortId === undefined ? { kind: "stopped" } : { kind: "stopped", shortId };
  }
  if (live.some((e) => e.kind?.toLowerCase() === "interactive" || e.id === undefined)) return { kind: "interactive" };
  const row = live[0]!;
  const state = row.state?.toLowerCase();
  const status = row.status?.toLowerCase();
  if (state === "blocked" || status === "waiting") return { kind: "busy", blocked: true, shortId: row.id! };
  if ((state !== undefined && FINISHED_STATES.has(state)) || status === "idle") return { kind: "idle", shortId: row.id! };
  return { kind: "busy", blocked: false, shortId: row.id! };
}

/** The same in one word, for `status` replies. */
export type Presence = "open" | "busy" | "idle" | "closed" | "unknown";

export function presenceOf(status: SessionStatus | null): Presence {
  if (status === null) return "unknown";
  switch (status.kind) {
    case "absent":
    case "stopped":
      return "closed";
    case "interactive":
      return "open";
    case "idle":
      return "idle";
    case "busy":
      return "busy";
  }
}

export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface WakeConfig {
  /** Least time between two wakes of the same session. */
  cooldownMs: number;
  /** How long to wait for the list of sessions, a launch or a stop. */
  commandTimeoutMs: number;
  /** After a launch, how long the session has to show up alive in the list. */
  verifyWithinMs: number;
  /** How often the list is read while waiting for that. */
  verifyEveryMs: number;
}

export const DEFAULT_WAKE: WakeConfig = {
  cooldownMs: 60_000,
  commandTimeoutMs: 20_000,
  verifyWithinMs: 20_000,
  verifyEveryMs: 2_000,
};

export interface WakerDeps {
  runner: ProcessRunner;
  clock: Clock;
  log: Logger;
  /** The `claude` CLI from `config.json`, if it names one. */
  claudePath(): string | null;
  env?: Record<string, string | undefined>;
  home?: string;
  pidAlive?: (pid: number) => boolean;
  which?: (command: string, path?: string) => string | null;
  config?: Partial<WakeConfig>;
}

export type WakeOutcome =
  /** The session was resumed under its own id and shows up alive. */
  | { kind: "started"; handle: string | null }
  /** It is open somewhere: not touched. */
  | { kind: "interactive" }
  /** A background process is working, or waiting on a prompt: not touched. */
  | { kind: "busy"; blocked: boolean }
  /** The list of sessions could not be read. */
  | { kind: "unknown" }
  /** The CLI does not know the session. */
  | { kind: "gone" }
  /** The CLI started a copy instead (the session was alive after all); the copy was stopped if it could be told. */
  | { kind: "copy" }
  | { kind: "failed"; reason: string }
  /** Another wake is running, or this session was woken less than a minute ago. */
  | { kind: "in_flight" }
  | { kind: "cooldown" };

/**
 * Wakes a closed terminal session when a Discord message arrives for it. It follows what the CLI does:
 *
 *  - a session open in the desktop app, VS Code or a terminal is never resumed (that would start a copy);
 *  - a background session that is working, or waiting on a prompt, is left alone;
 *  - a background session that is idle (its process lives on) is stopped, then resumed;
 *  - a session with no live process is resumed under its own id, with no flag at all;
 *  - afterwards the list is read until the session shows up alive (20 seconds at most); if a copy appeared
 *    instead, the copy this launch made (and only that) is stopped.
 *
 * One wake at a time, and not again for the same session within a minute.
 */
export class Waker {
  private readonly cfg: WakeConfig;
  private readonly env: Record<string, string | undefined>;
  private readonly home: string;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly which: (command: string, path?: string) => string | null;
  private inFlight = false;
  private readonly lastWake = new Map<string, number>();

  constructor(private readonly d: WakerDeps) {
    this.cfg = { ...DEFAULT_WAKE, ...d.config };
    this.env = d.env ?? process.env;
    this.home = d.home ?? homedir();
    this.pidAlive = d.pidAlive ?? defaultPidAlive;
    this.which = d.which ?? ((command, path) => Bun.which(command, path === undefined ? {} : { PATH: path }));
  }

  /** Is a wake running, or was this session woken less than a minute ago? */
  busy(sessionId: string): "in_flight" | "cooldown" | null {
    if (this.inFlight) return "in_flight";
    const last = this.lastWake.get(sessionId);
    if (last !== undefined) {
      const elapsed = this.d.clock.now() - last;
      if (elapsed >= 0 && elapsed < this.cfg.cooldownMs) return "cooldown";
    }
    return null;
  }

  /** The CLI to run: the path in `config.json`, else `claude` on PATH (with the usual tool folders added). */
  bin(): string {
    const configured = this.d.claudePath()?.trim();
    if (configured) return configured;
    return this.which(CLAUDE_COMMAND) ?? this.which(CLAUDE_COMMAND, this.searchPath().join(":")) ?? CLAUDE_COMMAND;
  }

  /** A LaunchAgent's PATH is short: add the CLI's own folder and the usual tool folders. */
  launchEnv(bin: string): Record<string, string> {
    return { PATH: this.searchPath(isAbsolute(bin) ? dirname(bin) : undefined).join(":") };
  }

  private searchPath(first?: string): string[] {
    const folders: string[] = [];
    if (first) folders.push(first);
    folders.push(...(this.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":"));
    folders.push("/opt/homebrew/bin", "/usr/local/bin", join(this.home, ".local", "bin"));
    return [...new Set(folders.filter((f) => f !== ""))];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.d.clock.setTimeout(resolve, ms));
  }

  /** `claude agents --json --all`, or null when it could not be read (the reason goes to the log). */
  async readList(): Promise<AgentEntry[] | null> {
    const bin = this.bin();
    const result = await this.d.runner.run([bin, "agents", "--json", "--all"], {
      env: this.launchEnv(bin),
      timeoutMs: this.cfg.commandTimeoutMs,
    });
    if (result.timedOut) {
      this.d.log.warn("the session list took too long");
      return null;
    }
    if (result.code !== 0) {
      this.d.log.warn(`the session list failed (exit ${result.code})`);
      return null;
    }
    const entries = parseAgentList(result.stdout);
    if (entries === null) this.d.log.warn(`the session list was unreadable (${result.stdout.length} characters)`);
    return entries;
  }

  /** Where each session stands now, from one read of the list. Null values: the list could not be read. */
  async lookup(sessionIds: readonly string[]): Promise<Map<string, SessionStatus | null>> {
    const entries = await this.readList();
    return new Map(sessionIds.map((id) => [id, entries === null ? null : sessionStatus(entries, id, this.pidAlive)]));
  }

  private async stopSession(shortId: string): Promise<boolean> {
    const bin = this.bin();
    const result = await this.d.runner.run([bin, "stop", shortId], { env: this.launchEnv(bin), timeoutMs: this.cfg.commandTimeoutMs });
    if (result.timedOut || result.code !== 0) {
      this.d.log.warn(`stopping a background session failed (${result.timedOut ? "took too long" : `exit ${result.code}`})`);
      return false;
    }
    return true;
  }

  /**
   * Wake the session with `prompt`. `secret` (the user's message) is cut out of anything the CLI printed
   * before it is logged.
   */
  async wake(target: { sessionId: string; cwd: string }, prompt: string, secret: string): Promise<WakeOutcome> {
    const busy = this.busy(target.sessionId);
    if (busy) return { kind: busy };
    this.inFlight = true;
    try {
      if (target.cwd.trim() === "") return { kind: "failed", reason: "no folder is recorded for the session" };
      return await this.wakeNow(target, prompt, secret);
    } finally {
      this.inFlight = false;
    }
  }

  private async wakeNow(target: { sessionId: string; cwd: string }, prompt: string, secret: string): Promise<WakeOutcome> {
    const short = target.sessionId.slice(0, 8);
    const scrub = (text: string) => {
      let out = text.split(prompt).join("<prompt>");
      if (secret !== "") out = out.split(secret).join("<text>");
      return out;
    };
    let entries = await this.readList();
    if (entries === null) return { kind: "unknown" };
    let status = sessionStatus(entries, target.sessionId, this.pidAlive);

    switch (status.kind) {
      case "interactive":
        this.d.log.info(`session ${short} is open, so it was not woken`);
        return { kind: "interactive" };
      case "busy":
        this.d.log.info(`session ${short} is ${status.blocked ? "waiting on a prompt" : "working"} in the background, so it was not woken`);
        return { kind: "busy", blocked: status.blocked };
      case "idle": {
        this.lastWake.set(target.sessionId, this.d.clock.now());
        if (!(await this.stopSession(status.shortId))) return { kind: "failed", reason: "the idle session could not be stopped" };
        entries = await this.readList();
        if (entries === null) return { kind: "unknown" };
        status = sessionStatus(entries, target.sessionId, this.pidAlive);
        if (status.kind !== "stopped" && status.kind !== "absent") {
          this.d.log.warn(`session ${short} did not stop, so it was not woken`);
          return { kind: "failed", reason: "the idle session did not stop" };
        }
        this.d.log.info(`stopped idle session ${short}, to wake it`);
        break;
      }
      default:
        break;
    }

    const wasAbsent = status.kind === "absent";
    const wanted = target.sessionId.toLowerCase();
    const before = new Set(entries.flatMap((e) => (e.sessionId ? [e.sessionId.toLowerCase()] : [])));
    const bin = this.bin();
    this.lastWake.set(target.sessionId, this.d.clock.now());
    const result = await this.d.runner.run(buildResumeCommand({ bin, sessionId: target.sessionId, prompt }), {
      cwd: target.cwd,
      env: this.launchEnv(bin),
      timeoutMs: this.cfg.commandTimeoutMs,
    });
    if (result.timedOut) {
      this.d.log.warn(`waking session ${short} took too long`);
      return { kind: "failed", reason: "it took too long" };
    }
    const output = `${scrub(result.stdout)}\n${scrub(result.stderr)}`;
    if (result.code !== 0) {
      if (wasAbsent && looksNotFound(output)) {
        this.d.log.warn(`session ${short} does not exist any more`);
        return { kind: "gone" };
      }
      this.d.log.warn(`waking session ${short} failed (exit ${result.code})`);
      return { kind: "failed", reason: result.code === 127 ? "the claude command could not be started" : `exit ${result.code}` };
    }

    const printed = parseBackgroundedId(result.stdout);
    // Wait until the list shows the same session id alive, or a copy shows up instead.
    const deadline = this.d.clock.now() + this.cfg.verifyWithinMs;
    for (;;) {
      const after = await this.readList();
      if (after !== null) {
        const copies = after.filter(
          (e) => e.sessionId !== undefined && !before.has(e.sessionId.toLowerCase()) && e.sessionId.toLowerCase() !== wanted,
        );
        if (/started a copy/i.test(output) || copies.length > 0) {
          const mine = printed === null ? undefined : copies.find((e) => e.id === printed && e.kind?.toLowerCase() !== "interactive");
          if (mine?.id !== undefined && (await this.stopSession(mine.id))) {
            this.d.log.warn(`waking session ${short} started a copy (it was running after all); the copy was stopped`);
          } else {
            this.d.log.warn(`waking session ${short} started a copy that could not be told apart, so it was left running`);
          }
          return { kind: "copy" };
        }
        const alive = after.some((e) => e.sessionId?.toLowerCase() === wanted && e.pid !== undefined && this.pidAlive(e.pid));
        if (alive) {
          this.d.log.info(`woke session ${short} in the background`);
          return { kind: "started", handle: printed };
        }
      }
      if (this.d.clock.now() + this.cfg.verifyEveryMs > deadline) break;
      await this.sleep(this.cfg.verifyEveryMs);
    }
    this.d.log.warn(`session ${short} did not show up as running after the wake`);
    return { kind: "failed", reason: "it didn't show up as running within 20 seconds" };
  }
}
