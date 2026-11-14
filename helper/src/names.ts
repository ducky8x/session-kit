import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, TimerHandle } from "./clock.ts";
import type { Logger } from "./log.ts";
import type { ProcessRunner } from "./process.ts";
import type { SessionStore } from "./state.ts";

export const POLL_INTERVAL_MS = 30_000;
export const AGENTS_TIMEOUT_MS = 5000;
/** Only the end of a transcript is read for its title. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** A desktop app session record bigger than this is skipped. They are about 100 KB. */
export const DESKTOP_RECORD_MAX_BYTES = 4 * 1024 * 1024;

/** A session has no name yet when it has none, an empty one, or the desktop app's "New session". */
export function isUnnamed(name: string | null | undefined): boolean {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" || trimmed.toLowerCase() === "new session";
}

/**
 * One row of `claude agents --json`. Every field is optional: anything else the CLI adds (`startedAt`, and
 * `waitingFor` while `status` is waiting) is ignored. The rows carry no entry point, so whether a session is
 * open in the desktop app, in VS Code or in a terminal comes only from the hooks' `CLAUDE_CODE_ENTRYPOINT`.
 */
export interface AgentEntry {
  /** The short id (8 hex), on background sessions only. */
  id?: string;
  sessionId?: string;
  /** Only while the process is alive. */
  pid?: number;
  cwd?: string;
  /** "interactive" (the desktop app, VS Code or a terminal) or "background". */
  kind?: string;
  name?: string;
  /** Background sessions only: working, blocked, done, failed or stopped. */
  state?: string;
  /** Only while the process is alive: busy, waiting or idle. */
  status?: string;
}

/**
 * Read the list of sessions `claude agents --json` prints. The format may change between releases, so every
 * field is optional and anything else is ignored. Null means "not a list this code understands".
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

/** The lines in the last `tailBytes` of a file (the first one dropped when it starts mid-line), or null. */
export async function readTailLines(path: string, tailBytes = TRANSCRIPT_TAIL_BYTES): Promise<string[] | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // starts mid-line
    return lines;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * The session's latest name from its transcript: the last `{"type":"custom-title","customTitle":...}` line in
 * the final 256 KB. Null when there is none or the file cannot be read.
 */
export async function readCustomTitle(path: string, tailBytes = TRANSCRIPT_TAIL_BYTES): Promise<string | null> {
  const lines = (await readTailLines(path, tailBytes)) ?? [];
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
}

/** A session's title from one file, and when that file last changed. */
export interface Titled {
  title: string;
  mtimeMs: number;
}

interface FileStamp {
  mtimeMs: number;
  size: number;
}

async function statFile(path: string): Promise<FileStamp | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? { mtimeMs: s.mtimeMs, size: s.size } : null;
  } catch {
    return null;
  }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** Transcript titles (see `readCustomTitle`), read again only when a transcript's mtime or size changes. */
class TranscriptTitles {
  private readonly files = new Map<string, FileStamp & { title: string | null }>();
  private used = new Set<string>();

  async read(path: string): Promise<Titled | null> {
    const stamp = await statFile(path);
    if (stamp === null) return null;
    this.used.add(path);
    let known = this.files.get(path);
    if (known === undefined || !sameStamp(known, stamp)) {
      known = { ...stamp, title: await readCustomTitle(path) };
      this.files.set(path, known);
    }
    return known.title === null ? null : { title: known.title, mtimeMs: known.mtimeMs };
  }

  /** Forget the transcripts not read since the last call. */
  prune(): void {
    for (const path of this.files.keys()) if (!this.used.has(path)) this.files.delete(path);
    this.used = new Set();
  }
}

async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

async function readDesktopRecord(path: string): Promise<{ cliSessionId: string; title: string } | null> {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    const { cliSessionId, title } = data as Record<string, unknown>;
    if (typeof cliSessionId !== "string" || cliSessionId === "" || typeof title !== "string") return null;
    return { cliSessionId, title };
  } catch {
    return null;
  }
}

/**
 * The titles the Claude desktop app shows in its sidebar, from its own record of each session:
 * `<root>/<account>/<org>/local_<its id>.json`, with `cliSessionId` (the Claude Code session id) and `title`
 * among many other fields. The format isn't documented, so a file that doesn't fit is skipped, and a file is
 * parsed again only when its mtime or size changes.
 */
export class DesktopRecords {
  private readonly files = new Map<string, FileStamp & { record: { cliSessionId: string; title: string } | null }>();

  constructor(private readonly root: string) {}

  /** Each session's title by Claude Code session id, from the newest record that names it. */
  async titles(): Promise<Map<string, Titled>> {
    const titles = new Map<string, Titled>();
    const seen = new Set<string>();
    for (const account of await subfolders(this.root)) {
      for (const org of await subfolders(account)) {
        let names: string[];
        try {
          names = await readdir(org);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.startsWith("local_") || !name.endsWith(".json")) continue;
          const path = join(org, name);
          const stamp = await statFile(path);
          if (stamp === null) continue;
          seen.add(path);
          let known = this.files.get(path);
          if (known === undefined || !sameStamp(known, stamp)) {
            known = { ...stamp, record: stamp.size <= DESKTOP_RECORD_MAX_BYTES ? await readDesktopRecord(path) : null };
            this.files.set(path, known);
          }
          const { record, mtimeMs } = known;
          if (record === null) continue;
          const other = titles.get(record.cliSessionId);
          if (other === undefined || other.mtimeMs < mtimeMs) titles.set(record.cliSessionId, { title: record.title, mtimeMs });
        }
      }
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
    return titles;
  }
}

/** What a session's desktop record and transcript said at the last poll, and which of the two its name came from. */
interface Sources {
  desktop: string | null;
  transcript: string | null;
  from: "desktop" | "transcript";
}

function named(found: Titled | null | undefined): Titled | null {
  return found && !isUnnamed(found.title) ? found : null;
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
  /** The desktop app's session records (`Paths.desktopSessions`). Without it, they aren't read. */
  desktopSessionsDir?: string | null;
}

/**
 * Every 30 seconds, the names of open sessions and of ended sessions that still have a channel:
 * `claude agents --json` for the sessions it lists, and for the rest, the desktop app's record (desktop
 * sessions only) and the latest `custom-title` line of the transcript.
 */
export class NamePoller {
  private timer: TimerHandle | null = null;
  private running = false;
  /** The last list that could be read, by session id; null when the last attempt failed. */
  private listed: Map<string, AgentEntry> | null = null;
  private readonly desktop: DesktopRecords | null;
  private readonly transcripts = new TranscriptTitles();
  /** What the last poll read for each session it named without `claude agents` (see `pick`). */
  private sources = new Map<string, Sources>();

  constructor(private readonly d: NamePollerDeps) {
    this.desktop = d.desktopSessionsDir ? new DesktopRecords(d.desktopSessionsDir) : null;
  }

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
    // The desktop records are read at most once a poll, and only when a session needs them.
    let desktopTitles: Map<string, Titled> | null = null;
    const desktopTitle = async (sessionId: string) => {
      desktopTitles ??= (await this.desktop?.titles()) ?? new Map<string, Titled>();
      return desktopTitles.get(sessionId);
    };
    const names = new Map<string, string>();
    const sources = new Map<string, Sources>();
    for (const entry of this.d.sessions.all()) {
      const id = entry.sessionId;
      const row = this.listed?.get(id);
      // An ended session is named only while it still has a channel: a rename never brings back a deleted one.
      if (entry.closedAt !== null && !row && entry.channelId === null) continue;
      if (typeof row?.name === "string") {
        names.set(id, row.name);
        continue;
      }
      const desktop = entry.surface === "desktop" ? named(await desktopTitle(id)) : null;
      const transcript = entry.transcriptPath === null ? null : named(await this.transcripts.read(entry.transcriptPath));
      const picked = pick(this.sources.get(id), desktop, transcript);
      const name = picked?.from === "desktop" ? desktop?.title : transcript?.title;
      if (picked === null || name === undefined) continue;
      sources.set(id, picked);
      names.set(id, name);
    }
    this.sources = sources;
    this.transcripts.prune();
    this.d.onNames(names);
  }
}

/**
 * Which of a session's desktop record and transcript its name comes from, when `claude agents` doesn't list it.
 * The two can disagree: renaming an ended session in the desktop app's sidebar changes only the record, and
 * resuming it in a terminal and renaming it with /rename changes only the transcript. So the one that changed
 * since the last poll wins, and keeps winning until the other changes. Without a last poll to compare with,
 * the file written last wins. Null when neither has a name.
 */
function pick(before: Sources | undefined, desktop: Titled | null, transcript: Titled | null): Sources | null {
  let from: Sources["from"];
  if (desktop === null && transcript === null) return null;
  if (transcript === null) from = "desktop";
  else if (desktop === null) from = "transcript";
  else if (before === undefined) from = desktop.mtimeMs >= transcript.mtimeMs ? "desktop" : "transcript";
  else if (desktop.title !== before.desktop) from = "desktop";
  else if (transcript.title !== before.transcript) from = "transcript";
  else from = before.from;
  return { desktop: desktop?.title ?? null, transcript: transcript?.title ?? null, from };
}
