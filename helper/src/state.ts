import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Paths } from "./paths.ts";

/** The file operations an atomic write needs, so a test can make one fail halfway. */
export interface AtomicFs {
  writeFile(path: string, data: string): void;
  rename(from: string, to: string): void;
}

export const realAtomicFs: AtomicFs = {
  writeFile: (path, data) => {
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600);
  },
  rename: (from, to) => renameSync(from, to),
};

/**
 * Replace a file's contents so that a reader sees the old file or the new one, never half of either:
 * write `<file>.tmp`, then rename it over the file. The file is user-only (0600).
 */
export function writeFileAtomic(file: string, data: string, fs: AtomicFs = realAtomicFs): void {
  const tmp = `${file}.tmp`;
  fs.writeFile(tmp, data);
  fs.rename(tmp, file);
}

/** Make the helper's folder, user-only (0700). */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Read a JSON file. A missing file is null. A file that is not JSON is renamed to `<file>.bad` (kept for a
 * person to look at) and also reads as null, so one bad write never stops the helper.
 */
export function readJsonFile(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    try {
      renameSync(file, `${file}.bad`);
    } catch {
      // gone already
    }
    return null;
  }
}

/** Read a file of JSON lines. A missing file is empty; a line that is not JSON is skipped. */
export function readJsonLines(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const values: unknown[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // a torn or hand-edited line
    }
  }
  return values;
}

export type Surface = "desktop" | "vs" | "cli";

export const SURFACES: readonly Surface[] = ["desktop", "vs", "cli"];

/** An event waiting in a session's inbox for its next listener. */
export interface InboxEvent {
  type: string;
  [field: string]: unknown;
}

/** The most events an inbox holds; the oldest goes first. */
export const INBOX_LIMIT = 50;

/** One session the helper knows, keyed by its session id in `sessions.json`. */
export interface SessionEntry {
  sessionId: string;
  /** The session's channel. Null while it has none: not created yet, or deleted (unlinked). */
  channelId: string | null;
  /** The session's name as last seen. Null, empty or "New session" means it has none yet. */
  name: string | null;
  /** The channel's name on Discord, as last set. */
  channelName: string | null;
  surface: Surface;
  cwd: string;
  transcriptPath: string | null;
  createdAt: number;
  /** The last message in the channel, from anyone. Drives the archive and delete timers. */
  lastMessageAt: number;
  /** The channel sits in an Archive category. */
  archived: boolean;
  /** When the session ended (SessionEnd), or null while it is open. */
  closedAt: number | null;
  /** Events for the session that arrived while nothing was listening. */
  inbox: InboxEvent[];
  /** The open question, if any. */
  question: Record<string, unknown> | null;
  /** When the channel was last renamed, for the 5-minute rename spacing. */
  renamedAt: number | null;
  /** The channel should be made as soon as Discord is reachable (registered while offline). */
  wantsChannel: boolean;
  /** When the session's run was marked finished (`send --done`), which stops check-ins. */
  doneAt: number | null;
}

export function newSession(o: {
  sessionId: string;
  surface: Surface;
  cwd: string;
  transcriptPath: string | null;
  now: number;
  name?: string | null;
}): SessionEntry {
  return {
    sessionId: o.sessionId,
    channelId: null,
    name: o.name ?? null,
    channelName: null,
    surface: o.surface,
    cwd: o.cwd,
    transcriptPath: o.transcriptPath,
    createdAt: o.now,
    lastMessageAt: o.now,
    archived: false,
    closedAt: null,
    inbox: [],
    question: null,
    renamedAt: null,
    wantsChannel: false,
    doneAt: null,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read one stored entry, filling in fields an older file lacks. Null when it is not an entry at all. */
function readEntry(sessionId: string, raw: unknown): SessionEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const surface = r.surface;
  if (surface !== "desktop" && surface !== "vs" && surface !== "cli") return null;
  const createdAt = num(r.createdAt) ?? 0;
  return {
    ...r,
    sessionId,
    channelId: str(r.channelId),
    name: str(r.name),
    channelName: str(r.channelName),
    surface,
    cwd: str(r.cwd) ?? "",
    transcriptPath: str(r.transcriptPath),
    createdAt,
    lastMessageAt: num(r.lastMessageAt) ?? createdAt,
    archived: r.archived === true,
    closedAt: num(r.closedAt),
    inbox: Array.isArray(r.inbox) ? (r.inbox.filter((e) => e && typeof e === "object") as InboxEvent[]) : [],
    question: r.question && typeof r.question === "object" ? (r.question as Record<string, unknown>) : null,
    renamedAt: num(r.renamedAt),
    wantsChannel: r.wantsChannel === true,
    doneAt: num(r.doneAt),
  };
}

/**
 * The session registry, `sessions.json`: one entry per session id. Every change is saved at once, atomically.
 */
export class SessionStore {
  private readonly entries = new Map<string, SessionEntry>();

  constructor(
    private readonly paths: Paths,
    private readonly fs: AtomicFs = realAtomicFs,
  ) {
    ensurePrivateDir(paths.dir);
    const raw = readJsonFile(paths.sessions);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = readEntry(id, value);
        if (entry) this.entries.set(id, entry);
      }
    }
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  all(): SessionEntry[] {
    return [...this.entries.values()];
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.entries.get(sessionId);
  }

  byChannel(channelId: string): SessionEntry | undefined {
    for (const entry of this.entries.values()) if (entry.channelId === channelId) return entry;
    return undefined;
  }

  /** Add or replace an entry. */
  put(entry: SessionEntry): void {
    this.entries.set(entry.sessionId, entry);
    this.save();
  }

  /** Change an entry and save it. Undefined when there is no such session. */
  update(sessionId: string, mutate: (entry: SessionEntry) => void): SessionEntry | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    mutate(entry);
    this.save();
    return entry;
  }

  remove(sessionId: string): void {
    if (this.entries.delete(sessionId)) this.save();
  }

  /** Mark the session as having no channel (it was deleted); the entry stays, so a later post can make a new one. */
  unlink(sessionId: string): void {
    this.update(sessionId, (e) => {
      e.channelId = null;
      e.channelName = null;
      e.archived = false;
      e.renamedAt = null;
    });
  }

  /** After a restart: unlink every session whose channel is not among the server's channels. Returns their ids. */
  unlinkMissing(existing: ReadonlySet<string>): string[] {
    const gone = this.all().filter((e) => e.channelId !== null && !existing.has(e.channelId));
    for (const e of gone) this.unlink(e.sessionId);
    return gone.map((e) => e.sessionId);
  }

  /** Queue an event for the session's next listener. Returns how many old events were dropped to make room. */
  pushInbox(sessionId: string, event: InboxEvent): number {
    let dropped = 0;
    this.update(sessionId, (e) => {
      e.inbox.push(event);
      while (e.inbox.length > INBOX_LIMIT) {
        e.inbox.shift();
        dropped++;
      }
    });
    return dropped;
  }

  private save(): void {
    ensurePrivateDir(this.paths.dir);
    writeFileAtomic(this.paths.sessions, `${JSON.stringify(Object.fromEntries(this.entries), null, 2)}\n`, this.fs);
  }
}
