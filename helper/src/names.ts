import { open } from "node:fs/promises";
import type { Clock, TimerHandle } from "./clock.ts";
import type { Logger } from "./log.ts";
import type { ProcessRunner } from "./process.ts";
import type { SessionStore } from "./state.ts";

export const POLL_INTERVAL_MS = 30_000;
export const AGENTS_TIMEOUT_MS = 5000;
/** Only the end of a transcript is read for its title. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** One row of `claude agents --json`. Every field is optional: anything else the CLI adds is ignored. */
export interface AgentEntry {
  /** The short id (8 hex), on background sessions only. */
  id?: string;
  sessionId?: string;
  pid?: number;
  cwd?: string;
  /** "interactive" or "background". */
  kind?: string;
  name?: string;
  /** working, done or blocked (background sessions). */
  state?: string;
  /** busy or idle. */
  status?: string;
}

/**
 * Read the list of sessions `claude agents --json` prints. The format is undocumented, so every field is
 * optional and anything else is ignored. Null means "not a list this code understands".
 */
export function parseAgentList(stdout: string): AgentEntry[] | null {
  if (stdout.trim() === "") return null;
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  let rows: unknown = data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const wrapper = data as Record<string, unknown>;
    rows = Array.isArray(wrapper.sessions) ? wrapper.sessions : wrapper.agents;
  }
  if (!Array.isArray(rows)) return null;
  const entries: AgentEntry[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const entry: AgentEntry = {};
    if (typeof r.id === "string") entry.id = r.id;
    const sessionId = r.sessionId ?? r.session_id;
    if (typeof sessionId === "string") entry.sessionId = sessionId;
    if (typeof r.pid === "number") entry.pid = r.pid;
    if (typeof r.cwd === "string") entry.cwd = r.cwd;
    if (typeof r.kind === "string") entry.kind = r.kind;
    if (typeof r.name === "string") entry.name = r.name;
    if (typeof r.state === "string") entry.state = r.state;
    if (typeof r.status === "string") entry.status = r.status;
    entries.push(entry);
  }
  return entries;
}

/**
 * The session's latest name from its transcript: the last `{"type":"custom-title","customTitle":...}` line in
 * the final 256 KB. Null when there is none or the file cannot be read.
 */
export async function readCustomTitle(path: string, tailBytes = TRANSCRIPT_TAIL_BYTES): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // starts mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"custom-title"')) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.type === "custom-title" && typeof record.customTitle === "string") return record.customTitle;
      } catch {
        // a torn line
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export interface NamePollerDeps {
  runner: ProcessRunner;
  clock: Clock;
  log: Logger;
  sessions: SessionStore;
  /** The `claude` CLI to run. */
  claudePath(): string;
  /** The names found in one poll, by session id (only sessions a name was found for). */
  onNames(names: Map<string, string>): void;
  intervalMs?: number;
}

/**
 * Every 30 seconds: `claude agents --json` for the names (and liveness) of open sessions, and for an open
 * session the list leaves out, the latest `custom-title` line of its transcript.
 */
export class NamePoller {
  private timer: TimerHandle | null = null;
  private running = false;
  /** The last list that could be read, by session id; null when the last attempt failed. */
  private listed: Map<string, AgentEntry> | null = null;

  constructor(private readonly d: NamePollerDeps) {}

  start(): void {
    if (this.timer !== null || this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.d.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.timer = this.d.clock.setTimeout(() => {
      this.timer = null;
      void this.poll()
        .catch((error) => this.d.log.warn(`name poll failed: ${(error as Error).message}`))
        .finally(() => {
          if (this.running) this.schedule(this.d.intervalMs ?? POLL_INTERVAL_MS);
        });
    }, ms);
  }

  /** Whether `claude agents --json` listed the session last time; null when the list could not be read. */
  alive(sessionId: string): boolean | null {
    return this.listed === null ? null : this.listed.has(sessionId);
  }

  /** The session's row from the last list, if it was in it. */
  row(sessionId: string): AgentEntry | undefined {
    return this.listed?.get(sessionId);
  }

  async poll(): Promise<void> {
    const result = await this.d.runner.run([this.d.claudePath(), "agents", "--json"], { timeoutMs: AGENTS_TIMEOUT_MS });
    const rows = result.code === 0 ? parseAgentList(result.stdout) : null;
    if (rows === null) {
      if (this.listed !== null) this.d.log.warn(`claude agents --json gave nothing readable (exit ${result.code})`);
      this.listed = null;
    } else {
      this.listed = new Map(rows.filter((r) => r.sessionId !== undefined).map((r) => [r.sessionId!, r]));
    }
    const names = new Map<string, string>();
    for (const entry of this.d.sessions.all()) {
      const row = this.listed?.get(entry.sessionId);
      if (entry.closedAt !== null && !row) continue;
      let name: string | null = typeof row?.name === "string" ? row.name : null;
      if (name === null && entry.transcriptPath !== null) name = await readCustomTitle(entry.transcriptPath);
      if (name !== null) names.set(entry.sessionId, name);
    }
    this.d.onNames(names);
  }
}
