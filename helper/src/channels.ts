import { basename } from "node:path";
import type { Clock, TimerHandle } from "./clock.ts";
import { type Config, loadConfig, updateConfig } from "./config.ts";
import { RestError, type RestClient, UNKNOWN_CHANNEL } from "./discord/rest.ts";
import type { Logger } from "./log.ts";
import { readTailLines } from "./names.ts";
import type { Paths } from "./paths.ts";
import { INBOX_LIMIT, type SessionEntry, type SessionStore, type Surface, newSession } from "./state.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** A session name is cut to this many characters before the suffix. */
export const NAME_MAX = 80;
/** Discord allows 50 channels in a category. */
export const CATEGORY_LIMIT = 50;
/** Discord allows 500 channels in a server; past this many, the oldest archived channel makes room. */
export const SERVER_SOFT_LIMIT = 490;
/** Discord allows two renames per channel per 10 minutes; the helper renames at most once per 5. */
export const RENAME_SPACING_MS = 5 * MINUTE_MS;
/**
 * A session that ended more than this long before another one started can't be the chat that one continues.
 * (`/clear` ends the old session id just before the new one starts.)
 */
export const CONTINUATION_WINDOW_MS = 10 * MINUTE_MS;

export const SURFACE_INFO: Record<Surface, { suffix: string; category: string }> = {
  desktop: { suffix: "desktop", category: "Desktop" },
  vs: { suffix: "vs", category: "VS Code" },
  cli: { suffix: "cli", category: "CLI" },
};
const ARCHIVE_KEY = "archive";
const ARCHIVE_NAME = "Archive";

const ENTRYPOINTS: Record<string, Surface> = { "claude-desktop": "desktop", "claude-vscode": "vs", cli: "cli" };

/** The surface a session runs in, from `CLAUDE_CODE_ENTRYPOINT`. Null for anything that is not interactive. */
export function surfaceFor(entrypoint: string | null | undefined): Surface | null {
  return entrypoint ? (ENTRYPOINTS[entrypoint] ?? null) : null;
}

/** Lowercase; every run of characters outside a-z and 0-9 becomes one dash; no dash at either end; 80 at most. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, NAME_MAX).replace(/-+$/, "");
}

/** A session has no name yet when it has none, an empty one, or the desktop app's "New session". */
export function isUnnamed(name: string | null | undefined): boolean {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" || trimmed.toLowerCase() === "new session";
}

export interface NameInput {
  sessionId: string;
  name: string | null;
  cwd: string;
  surface: Surface;
}

/**
 * The channel name for a session: its name as a slug plus the surface suffix (`fix-login-bug-vs`). Without a
 * usable name it is the folder and the first four id characters (`session-kit-caa2-desktop`). A name another
 * linked session already has gets those four characters before the suffix (`fix-login-bug-a91c-desktop`).
 */
export function channelNameFor(session: NameInput, taken: ReadonlySet<string>): string {
  const suffix = SURFACE_INFO[session.surface].suffix;
  const id4 = slugify(session.sessionId).slice(0, 4) || "0000";
  let base = isUnnamed(session.name) ? "" : slugify(session.name!);
  if (base === "") base = `${slugify(basename(session.cwd)) || "session"}-${id4}`;
  const plain = `${base}-${suffix}`;
  return taken.has(plain) ? `${base}-${id4}-${suffix}` : plain;
}

export function topicFor(session: SessionEntry): string {
  return `session ${session.sessionId} · ${session.surface} · ${basename(session.cwd)}`;
}

export interface Timing {
  /** No messages for this long: the channel moves to Archive. */
  archiveMs: number;
  /** No messages for this long: the channel is deleted and the session forgotten. */
  deleteMs: number;
  renameSpacingMs: number;
  /** How long `register` waits for its work before answering. The session-start hook gives the call 2 seconds. */
  registerWaitMs: number;
}

export const DEFAULT_TIMING: Timing = {
  archiveMs: 7 * DAY_MS,
  deleteMs: 30 * DAY_MS,
  renameSpacingMs: RENAME_SPACING_MS,
  registerWaitMs: 1200,
};

function positiveDays(value: string | undefined): number | null {
  if (value === undefined) return null;
  const days = Number.parseFloat(value);
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : null;
}

/** The timers, shortened by `SK_DISCORD_ARCHIVE_DAYS` and `SK_DISCORD_DELETE_DAYS` (for testing by hand only). */
export function timingFromEnv(env: Record<string, string | undefined>): Timing {
  return {
    ...DEFAULT_TIMING,
    archiveMs: positiveDays(env.SK_DISCORD_ARCHIVE_DAYS) ?? DEFAULT_TIMING.archiveMs,
    deleteMs: positiveDays(env.SK_DISCORD_DELETE_DAYS) ?? DEFAULT_TIMING.deleteMs,
  };
}

/** Hourly, or more often when the archive time is shortened, so a short test run still sees its sweep. */
export function sweepEveryMs(timing: Timing): number {
  return Math.min(HOUR_MS, Math.max(MINUTE_MS, timing.archiveMs / 10));
}

/** A channel or category in the server, as the helper keeps track of it. */
export interface GuildChannel {
  id: string;
  type: number;
  name: string;
  parent_id: string | null;
  guild_id?: string;
}

/** The fields of a MESSAGE_CREATE event the channel lifecycle needs. */
export interface ChannelMessage {
  channel_id: string;
  author?: { id?: string; bot?: boolean };
}

export interface RegisterInput {
  sessionId: string;
  /** SessionStart's `source`: startup, resume, clear, compact or fork. */
  source: string;
  cwd: string;
  transcriptPath: string | null;
  /** `CLAUDE_CODE_ENTRYPOINT`. */
  entrypoint: string | null | undefined;
  /** The Claude Code process (`CLAUDE_PID`), when the hook knows it. */
  claudePid?: number | null;
}

export interface RegisterResult {
  /** False for a session that is not interactive: it gets no channel. */
  registered: boolean;
  channelName: string | null;
  /** The category the channel is in (or will be in). */
  category: string | null;
  /** The session has no channel yet, or it is still being created. */
  pending: boolean;
  /** The session has a channel. */
  linked: boolean;
}

export type UnlinkReason = "deleted" | "removed" | "moved";

export interface ChannelDeps {
  rest: RestClient;
  sessions: SessionStore;
  paths: Paths;
  clock: Clock;
  log: Logger;
  /** The gateway is connected, so Discord is reachable. */
  isOnline(): boolean;
  timing?: Timing;
  /**
   * A session lost its channel: deleted by hand or by Discord (`deleted`), removed with its entry (`removed`),
   * or handed on to the session that continued its chat (`moved`).
   */
  onUnlinked?(sessionId: string, why: UnlinkReason): void;
}

function asChannel(raw: unknown): GuildChannel | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string") return null;
  return {
    id: c.id,
    type: typeof c.type === "number" ? c.type : 0,
    name: typeof c.name === "string" ? c.name : "",
    parent_id: typeof c.parent_id === "string" ? c.parent_id : null,
    ...(typeof c.guild_id === "string" ? { guild_id: c.guild_id } : {}),
  };
}

/**
 * Session channels: made once a session's chat starts, named and renamed, kept in their surface's category (with
 * overflow categories past 50), moved to Archive after a quiet week and deleted after a quiet month.
 *
 * Changes to the server's layout (create, move, delete) run one at a time, so two sessions starting together
 * cannot both make "Desktop 2". Renames run on their own, at most one per channel every five minutes.
 */
export class ChannelManager {
  readonly timing: Timing;
  /** The server's channels and categories, from the last full list plus every change since. */
  private readonly cache = new Map<string, GuildChannel>();
  private lock: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly renameTimers = new Map<string, TimerHandle>();
  private readonly renaming = new Set<string>();
  private sweepTimer: TimerHandle | null = null;
  private sweepRun: Promise<void> | null = null;
  /** Sessions whose chat got under way since they last started (see `activate`). */
  private readonly active = new Set<string>();
  private stopped = false;
  private reconciled = false;

  constructor(private readonly d: ChannelDeps) {
    this.timing = d.timing ?? DEFAULT_TIMING;
  }

  // ---- plumbing --------------------------------------------------------------

  private config(): Config {
    return loadConfig(this.d.paths);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    promise.then(
      () => this.inflight.delete(promise),
      () => this.inflight.delete(promise),
    );
    return promise;
  }

  /** Run a change to the server's layout after the ones before it. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return this.track(run);
  }

  /** Resolves once nothing the manager started is still running (renames, sweeps, creations). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Wait for `promise`, but at most `ms`. */
  private within(promise: Promise<unknown>, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.d.clock.setTimeout(resolve, ms);
      const done = () => {
        this.d.clock.clearTimeout(timer);
        resolve();
      };
      promise.then(done, done);
    });
  }

  private childCount(categoryId: string): number {
    let n = 0;
    for (const c of this.cache.values()) if (c.parent_id === categoryId) n++;
    return n;
  }

  private isArchiveCategory(id: string | null): boolean {
    if (id === null) return false;
    return Object.entries(this.config().categories).some(
      ([key, value]) => value === id && (key === ARCHIVE_KEY || key.startsWith(`${ARCHIVE_KEY}-`)),
    );
  }

  /** The names other linked sessions' channels have. */
  takenNames(exceptSessionId: string): Set<string> {
    const taken = new Set<string>();
    for (const e of this.d.sessions.all()) {
      if (e.sessionId !== exceptSessionId && e.channelId !== null && e.channelName !== null) taken.add(e.channelName);
    }
    return taken;
  }

  private wantedName(entry: SessionEntry): string {
    return channelNameFor(entry, this.takenNames(entry.sessionId));
  }

  /** A category's name, from the server's list. */
  categoryName(id: string | null): string | null {
    return id === null ? null : (this.cache.get(id)?.name ?? null);
  }

  /** Where a session's channel is (or will be), for replies and `status`. */
  describe(sessionId: string): RegisterResult {
    const entry = this.d.sessions.get(sessionId);
    if (!entry) return { registered: false, channelName: null, category: null, pending: false, linked: false };
    const parent = entry.channelId === null ? null : (this.cache.get(entry.channelId)?.parent_id ?? null);
    return {
      registered: true,
      channelName: entry.channelName ?? this.wantedName(entry),
      category: this.categoryName(parent) ?? SURFACE_INFO[entry.surface].category,
      pending: entry.channelId === null,
      linked: entry.channelId !== null,
    };
  }

  // ---- the server's list ---------------------------------------------------------

  /**
   * Read the server's channels (at start and on every new gateway session). Sessions whose channel is gone are
   * unlinked, categories that are gone are forgotten (and made again when needed), and each session's name
   * and archive flag follow what is on Discord.
   */
  reconcile(): Promise<void> {
    return this.exclusive(() => this.reconcileLocked());
  }

  /** Changes to the layout need the server's list first; the first one after a start reads it. */
  private async ready(): Promise<void> {
    if (!this.reconciled) await this.reconcileLocked();
  }

  private async reconcileLocked(): Promise<void> {
    const guildId = this.config().guildId;
    if (guildId === null) return;
    const list = await this.d.rest.request<unknown[]>("GET", `/guilds/${guildId}/channels`);
    this.cache.clear();
    for (const raw of Array.isArray(list) ? list : []) {
      const channel = asChannel(raw);
      if (channel) this.cache.set(channel.id, channel);
    }
    const unlinked = this.d.sessions.unlinkMissing(new Set(this.cache.keys()));
    if (unlinked.length > 0) this.d.log.info(`unlinked ${unlinked.length} sessions whose channels are gone`);
    for (const sessionId of unlinked) this.d.onUnlinked?.(sessionId, "deleted");
    const gone = Object.entries(this.config().categories)
      .filter(([, id]) => this.cache.get(id)?.type !== 4)
      .map(([key]) => key);
    if (gone.length > 0) {
      updateConfig(this.d.paths, (c) => {
        for (const key of gone) delete c.categories[key];
      });
    }
    for (const entry of this.d.sessions.all()) {
      if (entry.channelId === null) continue;
      const channel = this.cache.get(entry.channelId)!;
      const archived = this.isArchiveCategory(channel.parent_id);
      if (channel.name !== entry.channelName || archived !== entry.archived) {
        this.d.sessions.update(entry.sessionId, (e) => {
          e.channelName = channel.name;
          e.archived = archived;
        });
      }
    }
    this.reconciled = true;
  }

  /** The gateway has a new session: read the server again and make the channels that were waiting for it. */
  async onConnected(): Promise<void> {
    try {
      await this.reconcile();
    } catch (error) {
      this.d.log.warn(`could not read the server's channels: ${(error as Error).message}`);
      return;
    }
    const waiting = this.d.sessions.all().filter((e) => e.wantsChannel);
    await Promise.allSettled(waiting.map((e) => this.ensureChannel(e.sessionId)));
  }

  /** A CHANNEL_CREATE, CHANNEL_UPDATE or CHANNEL_DELETE event from the gateway. */
  onChannelEvent(type: string, raw: unknown): void {
    const channel = asChannel(raw);
    if (!channel) return;
    const guildId = this.config().guildId;
    if (channel.guild_id !== undefined && channel.guild_id !== guildId) return;
    if (type === "CHANNEL_DELETE") {
      this.cache.delete(channel.id);
      const entry = this.d.sessions.byChannel(channel.id);
      if (entry) {
        this.cancelRename(entry.sessionId);
        this.d.sessions.unlink(entry.sessionId);
        this.d.log.info(`channel ${channel.id} was deleted; session ${entry.sessionId.slice(0, 8)} is unlinked`);
        this.d.onUnlinked?.(entry.sessionId, "deleted");
      }
      const key = Object.entries(this.config().categories).find(([, id]) => id === channel.id)?.[0];
      if (key !== undefined) {
        updateConfig(this.d.paths, (c) => {
          delete c.categories[key];
        });
      }
      return;
    }
    this.cache.set(channel.id, channel);
    const entry = this.d.sessions.byChannel(channel.id);
    if (entry && type === "CHANNEL_UPDATE") {
      const archived = this.isArchiveCategory(channel.parent_id);
      if (entry.channelName !== channel.name || entry.archived !== archived) {
        this.d.sessions.update(entry.sessionId, (e) => {
          e.channelName = channel.name;
          e.archived = archived;
        });
      }
    }
  }

  // ---- sessions --------------------------------------------------------------------

  /**
   * A session started (SessionStart). It is recorded, but its channel waits until its chat starts (see
   * `activate`), so a session that never gets a prompt never gets a channel. A session that continues an
   * earlier one's chat takes over that channel at once (see `continueChat`). `resume` keeps the channel it
   * had; `compact` changes nothing. Non-interactive entry points get nothing.
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    const surface = surfaceFor(input.entrypoint);
    if (!surface) return { registered: false, channelName: null, category: null, pending: false, linked: false };
    const known = this.d.sessions.get(input.sessionId);
    if (known && input.source === "compact") return this.describe(input.sessionId);
    this.active.delete(input.sessionId);
    if (!known) {
      this.d.sessions.put(
        newSession({
          sessionId: input.sessionId,
          surface,
          cwd: input.cwd,
          transcriptPath: input.transcriptPath,
          now: this.d.clock.now(),
        }),
      );
    }
    this.d.sessions.update(input.sessionId, (e) => {
      e.closedAt = null;
      e.movedTo = null;
      if (input.cwd !== "") e.cwd = input.cwd;
      if (input.transcriptPath !== null) e.transcriptPath = input.transcriptPath;
      if (input.claudePid !== undefined && input.claudePid !== null) e.claudePid = input.claudePid;
    });
    if (this.d.sessions.get(input.sessionId)!.channelId === null) {
      const work = this.exclusive(() => this.continueChat(input.sessionId, input.source)).catch((error) => {
        const id = input.sessionId.slice(0, 8);
        this.d.log.warn(`could not look for the chat session ${id} continues: ${(error as Error).message}`);
      });
      await this.within(work, this.timing.registerWaitMs);
    }
    return this.describe(input.sessionId);
  }

  // ---- continued chats ---------------------------------------------------------------

  /**
   * Inside `exclusive`: when the session has no channel and carries on an earlier session's chat, give it that
   * session's channel. `source` is SessionStart's, or null when the session is past its start.
   */
  private async continueChat(sessionId: string, source: string | null): Promise<void> {
    const entry = this.d.sessions.get(sessionId);
    if (!entry || entry.channelId !== null) return;
    let earlier = source === null ? null : this.sameProcess(entry, source);
    let why = "same process";
    if (!earlier) {
      earlier = await this.continuedFrom(entry);
      why = "continued-in";
    }
    if (!earlier) return;
    const to = this.d.sessions.get(sessionId);
    const from = this.d.sessions.get(earlier.sessionId);
    if (to?.channelId === null && from && from.channelId !== null) this.takeOver(from, to, why);
  }

  /**
   * The session the same Claude Code process ran just before this one, which this one carries on: `/clear`,
   * or any other new session id in that process. A resumed chat is a chat of its own.
   */
  private sameProcess(entry: SessionEntry, source: string): SessionEntry | null {
    if (entry.claudePid === null || source === "startup" || source === "resume") return null;
    const now = this.d.clock.now();
    const found = this.d.sessions
      .all()
      .filter(
        (e) =>
          e.sessionId !== entry.sessionId &&
          e.channelId !== null &&
          e.claudePid === entry.claudePid &&
          e.closedAt !== null &&
          now - e.closedAt <= CONTINUATION_WINDOW_MS,
      )
      .sort((a, b) => b.closedAt! - a.closedAt!);
    return found[0] ?? null;
  }

  /**
   * The session whose transcript says its chat went on in this one: Claude Code writes a `continued-in` record
   * when it moves a chat to a background session with a new id. Only sessions that were open when this one
   * started are read.
   */
  private async continuedFrom(entry: SessionEntry): Promise<SessionEntry | null> {
    const since = entry.createdAt - CONTINUATION_WINDOW_MS;
    const candidates = this.d.sessions
      .all()
      .filter(
        (e) =>
          e.sessionId !== entry.sessionId &&
          e.channelId !== null &&
          e.transcriptPath !== null &&
          e.createdAt <= entry.createdAt &&
          (e.closedAt === null || e.closedAt >= since),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const candidate of candidates) {
      if ((await continuedIn(candidate.transcriptPath!)).includes(entry.sessionId)) return candidate;
    }
    return null;
  }

  /**
   * Inside `exclusive`: the channel, its name and the waiting messages move from `from` to `to`, the session that
   * continues its chat.
   */
  private takeOver(from: SessionEntry, to: SessionEntry, why: string): void {
    const channelId = from.channelId;
    const carried = from.inbox;
    this.cancelRename(from.sessionId);
    this.d.sessions.update(to.sessionId, (e) => {
      e.channelId = channelId;
      e.channelName = from.channelName;
      e.archived = from.archived;
      e.renamedAt = from.renamedAt;
      e.wantsChannel = false;
      e.lastMessageAt = this.d.clock.now();
      e.inbox = [...carried, ...e.inbox].slice(-INBOX_LIMIT);
    });
    this.d.sessions.update(from.sessionId, (e) => {
      e.channelId = null;
      e.channelName = null;
      e.archived = false;
      e.renamedAt = null;
      e.wantsChannel = false;
      e.inbox = [];
      e.movedTo = to.sessionId;
    });
    const [toId, fromId] = [to.sessionId.slice(0, 8), from.sessionId.slice(0, 8)];
    this.d.log.info(`session ${toId} continues session ${fromId} (${why}) and takes over channel ${channelId}`);
    this.d.onUnlinked?.(from.sessionId, "moved");
    this.requestRename(to.sessionId);
  }

  /** The session that has the chat now: this one, or the one it moved to (and so on). */
  private current(sessionId: string): SessionEntry | undefined {
    let entry = this.d.sessions.get(sessionId);
    const seen = new Set<string>();
    while (entry?.movedTo && !seen.has(entry.sessionId)) {
      seen.add(entry.sessionId);
      const next = this.d.sessions.get(entry.movedTo);
      if (!next) break;
      entry = next;
    }
    return entry;
  }

  /**
   * The session's chat is under way: the user typed a prompt, or a turn ended. The first time after each
   * start, the session gets its channel, or has it moved out of Archive. Later calls change nothing, so a
   * channel deleted by hand stays deleted until the session posts. Unknown sessions are left to their first
   * post, which registers them.
   */
  activate(sessionId: string): void {
    const entry = this.d.sessions.get(sessionId);
    if (!entry || this.active.has(sessionId)) return;
    this.active.add(sessionId);
    if (entry.channelId !== null && !entry.archived) return;
    if (!this.d.isOnline()) {
      this.d.sessions.update(sessionId, (e) => {
        e.wantsChannel = true;
      });
      return;
    }
    void this.ensureChannel(sessionId).catch((error) => {
      this.d.log.warn(`could not make a channel for session ${sessionId.slice(0, 8)}: ${(error as Error).message}`);
    });
  }

  /** The session ended (SessionEnd). The channel stays until the sweep. */
  ended(sessionId: string): void {
    this.d.sessions.update(sessionId, (e) => {
      e.closedAt = this.d.clock.now();
    });
  }

  /**
   * The session's channel, made if it has none and moved out of Archive if it is there. A session whose chat
   * moved on uses the channel of the session that has it now, and a session that continues an earlier one's
   * chat takes over its channel. Null: no such session.
   */
  ensureChannel(sessionId: string): Promise<string | null> {
    return this.exclusive(async () => {
      await this.ready();
      const found = this.current(sessionId);
      if (!found) return null;
      const id = found.sessionId;
      if (found.channelId === null) await this.continueChat(id, null);
      const entry = this.d.sessions.get(id)!;
      if (entry.channelId === null) return this.create(entry);
      if (entry.archived) await this.move(entry, false);
      if (entry.wantsChannel) {
        this.d.sessions.update(id, (e) => {
          e.wantsChannel = false;
        });
      }
      return this.d.sessions.get(id)?.channelId ?? null;
    });
  }

  /** Move an archived session's channel back to its surface's category. */
  unarchive(sessionId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.ready();
      const entry = this.d.sessions.get(sessionId);
      if (entry?.channelId && entry.archived) await this.move(entry, false);
    });
  }

  /**
   * A message was posted in some channel. One from the owner or the bot in a session's channel counts as
   * activity; one from the owner in an archived channel moves it back first. Resolves (with the session, if
   * the channel is one) once that is done, so the message can then be handed on.
   */
  async noteMessage(message: ChannelMessage, who: { ownerId: string | null; botId: string | null }): Promise<SessionEntry | null> {
    let entry = this.d.sessions.byChannel(message.channel_id);
    if (!entry) return null;
    const author = message.author?.id;
    const fromOwner = author !== undefined && author === who.ownerId;
    const fromBot = author !== undefined && author === who.botId;
    if (!fromOwner && !fromBot) return entry;
    if (fromOwner) entry = await this.followChat(entry);
    this.d.sessions.update(entry.sessionId, (e) => {
      e.lastMessageAt = this.d.clock.now();
    });
    if (fromOwner && entry.archived) await this.unarchive(entry.sessionId);
    return this.d.sessions.get(entry.sessionId) ?? null;
  }

  /**
   * The session an owner message in `entry`'s channel is for: `entry`, unless its transcript says the chat went
   * on in a session the helper knows that has no channel yet, which then takes this one over.
   */
  private async followChat(entry: SessionEntry): Promise<SessionEntry> {
    const channelId = entry.channelId;
    if (entry.transcriptPath === null || channelId === null) return entry;
    const next = await movedOnTo(entry.transcriptPath);
    if (next === null || next === entry.sessionId || this.d.sessions.get(next)?.channelId !== null) return entry;
    await this.exclusive(async () => {
      const from = this.d.sessions.get(entry.sessionId);
      const to = this.d.sessions.get(next);
      if (from?.channelId === channelId && to && to.channelId === null) this.takeOver(from, to, "continued-in");
    });
    return this.d.sessions.byChannel(channelId) ?? entry;
  }

  // ---- layout changes (always inside `exclusive`) -------------------------------------

  private async create(entry: SessionEntry): Promise<string | null> {
    const guildId = this.config().guildId;
    if (guildId === null) return null;
    await this.makeRoom();
    const parent = await this.category(entry.surface);
    const name = this.wantedName(entry);
    const made = asChannel(
      await this.d.rest.request("POST", `/guilds/${guildId}/channels`, {
        body: { name, type: 0, parent_id: parent, topic: topicFor(entry) },
      }),
    );
    if (!made) throw new Error("Discord's answer to a channel create had no id");
    this.cache.set(made.id, { ...made, parent_id: made.parent_id ?? parent });
    this.d.sessions.update(entry.sessionId, (e) => {
      e.channelId = made.id;
      e.channelName = made.name || name;
      e.archived = false;
      e.wantsChannel = false;
      e.renamedAt = null;
      // A new channel starts its quiet-time count now.
      e.lastMessageAt = this.d.clock.now();
    });
    this.d.log.info(`made channel ${made.id} for session ${entry.sessionId.slice(0, 8)}`);
    return made.id;
  }

  /**
   * The category for a surface (or `archive`): the first of "Desktop", "Desktop 2", "Desktop 3" ... with room,
   * made when it does not exist yet.
   */
  private async category(key: Surface | typeof ARCHIVE_KEY): Promise<string> {
    const base = key === ARCHIVE_KEY ? ARCHIVE_NAME : SURFACE_INFO[key].category;
    for (let n = 1; ; n++) {
      const configKey = n === 1 ? key : `${key}-${n}`;
      const id = this.config().categories[configKey];
      if (id !== undefined && this.cache.get(id)?.type === 4) {
        if (this.childCount(id) < CATEGORY_LIMIT) return id;
        continue;
      }
      const guildId = this.config().guildId;
      if (guildId === null) throw new Error("no server is set up");
      await this.makeRoom();
      const made = asChannel(
        await this.d.rest.request("POST", `/guilds/${guildId}/channels`, {
          body: { name: n === 1 ? base : `${base} ${n}`, type: 4 },
        }),
      );
      if (!made) throw new Error("Discord's answer to a category create had no id");
      this.cache.set(made.id, { ...made, type: 4 });
      updateConfig(this.d.paths, (c) => {
        c.categories[configKey] = made.id;
      });
      this.d.log.info(`made category ${configKey}`);
      return made.id;
    }
  }

  /** Near Discord's 500-channel limit, delete the archived channel that has been quiet longest. */
  private async makeRoom(): Promise<void> {
    if (this.cache.size < SERVER_SOFT_LIMIT) return;
    const oldest = this.d.sessions
      .all()
      .filter((e) => e.archived && e.channelId !== null)
      .sort((a, b) => a.lastMessageAt - b.lastMessageAt)[0];
    if (!oldest) {
      this.d.log.warn("the server is close to Discord's 500-channel limit and has no archived channel to delete");
      return;
    }
    this.d.log.info(`deleting the oldest archived channel to stay under Discord's limit`);
    await this.remove(oldest);
  }

  /** Delete a session's channel and forget the session. */
  private async remove(entry: SessionEntry): Promise<void> {
    if (entry.channelId !== null) {
      try {
        await this.d.rest.request("DELETE", `/channels/${entry.channelId}`);
      } catch (error) {
        if (!(error instanceof RestError && error.code === UNKNOWN_CHANNEL)) throw error;
      }
      this.cache.delete(entry.channelId);
    }
    this.cancelRename(entry.sessionId);
    this.d.sessions.remove(entry.sessionId);
    this.d.onUnlinked?.(entry.sessionId, "removed");
  }

  private async move(entry: SessionEntry, toArchive: boolean): Promise<void> {
    if (entry.channelId === null) return;
    const parent = await this.category(toArchive ? ARCHIVE_KEY : entry.surface);
    try {
      await this.d.rest.request("PATCH", `/channels/${entry.channelId}`, { body: { parent_id: parent } });
    } catch (error) {
      if (error instanceof RestError && error.code === UNKNOWN_CHANNEL) {
        this.cache.delete(entry.channelId);
        this.d.sessions.unlink(entry.sessionId);
        this.d.onUnlinked?.(entry.sessionId, "deleted");
        return;
      }
      throw error;
    }
    const cached = this.cache.get(entry.channelId);
    if (cached) cached.parent_id = parent;
    this.d.sessions.update(entry.sessionId, (e) => {
      e.archived = toArchive;
      // Coming out of Archive starts the quiet-time count again, or the next sweep would put it straight back.
      if (!toArchive) e.lastMessageAt = this.d.clock.now();
    });
  }

  // ---- names -----------------------------------------------------------------------------

  /** Names seen by the poller (session id to name). Every linked channel is then checked against its wanted name. */
  applyNames(names: ReadonlyMap<string, string>): void {
    for (const [sessionId, name] of names) {
      const entry = this.d.sessions.get(sessionId);
      if (entry && entry.name !== name) {
        this.d.sessions.update(sessionId, (e) => {
          e.name = name;
        });
      }
    }
    for (const entry of this.d.sessions.all()) if (entry.channelId !== null) this.requestRename(entry.sessionId);
  }

  private cancelRename(sessionId: string): void {
    const timer = this.renameTimers.get(sessionId);
    if (timer !== undefined) this.d.clock.clearTimeout(timer);
    this.renameTimers.delete(sessionId);
  }

  private scheduleRename(sessionId: string, waitMs: number): void {
    this.cancelRename(sessionId);
    this.renameTimers.set(
      sessionId,
      this.d.clock.setTimeout(() => {
        this.renameTimers.delete(sessionId);
        void this.track(this.renameNow(sessionId));
      }, waitMs),
    );
  }

  /** Rename when the wanted name differs: now, or once five minutes have passed since the last rename. */
  private requestRename(sessionId: string): void {
    if (this.stopped || !this.d.isOnline() || this.renameTimers.has(sessionId) || this.renaming.has(sessionId)) return;
    const entry = this.d.sessions.get(sessionId);
    // Without a name of its own, a session keeps the name its channel has.
    if (!entry || entry.channelId === null || isUnnamed(entry.name)) return;
    if (this.wantedName(entry) === entry.channelName) return;
    const wait = (entry.renamedAt ?? Number.NEGATIVE_INFINITY) + this.timing.renameSpacingMs - this.d.clock.now();
    if (wait > 0) this.scheduleRename(sessionId, wait);
    else void this.track(this.renameNow(sessionId));
  }

  /** Send the rename, with the name wanted at this moment (so a wait never sends a stale one). */
  private async renameNow(sessionId: string): Promise<void> {
    this.renaming.add(sessionId);
    try {
      const entry = this.d.sessions.get(sessionId);
      if (!entry || entry.channelId === null || isUnnamed(entry.name)) return;
      const wanted = this.wantedName(entry);
      if (wanted === entry.channelName) return;
      const channelId = entry.channelId;
      try {
        // The topic goes along: a channel taken over from an earlier session still names that session.
        const answer = asChannel(
          await this.d.rest.request("PATCH", `/channels/${channelId}`, {
            body: { name: wanted, topic: topicFor(entry) },
            retry429: false,
          }),
        );
        const name = answer?.name || wanted;
        const cached = this.cache.get(channelId);
        if (cached) cached.name = name;
        this.d.sessions.update(sessionId, (e) => {
          e.channelName = name;
          e.renamedAt = this.d.clock.now();
        });
      } catch (error) {
        if (error instanceof RestError && error.kind === "rate-limited") {
          this.renaming.delete(sessionId);
          this.scheduleRename(sessionId, error.retryAfterMs);
          return;
        }
        if (error instanceof RestError && error.code === UNKNOWN_CHANNEL) {
          this.cache.delete(channelId);
          this.d.sessions.unlink(sessionId);
          this.d.onUnlinked?.(sessionId, "deleted");
          return;
        }
        this.d.log.warn(`renaming channel ${channelId} failed: ${(error as Error).message}`);
        this.d.sessions.update(sessionId, (e) => {
          e.renamedAt = this.d.clock.now();
        });
      }
    } finally {
      this.renaming.delete(sessionId);
      this.requestRename(sessionId);
    }
  }

  // ---- the sweep -----------------------------------------------------------------------------

  /** Archive channels quiet for 7 days; delete channels (and forget sessions) quiet for 30. */
  sweep(): Promise<void> {
    if (this.sweepRun) return this.sweepRun;
    const run = this.exclusive(async () => {
      if (!this.d.isOnline()) return;
      await this.ready();
      const now = this.d.clock.now();
      for (const entry of this.d.sessions.all()) {
        const quiet = now - entry.lastMessageAt;
        try {
          if (quiet > this.timing.deleteMs) {
            await this.remove(entry);
            this.d.log.info(`deleted the channel of session ${entry.sessionId.slice(0, 8)} after 30 quiet days`);
          } else if (quiet > this.timing.archiveMs && entry.channelId !== null && !entry.archived) {
            await this.move(entry, true);
            this.d.log.info(`archived the channel of session ${entry.sessionId.slice(0, 8)}`);
          }
        } catch (error) {
          this.d.log.warn(`sweep: session ${entry.sessionId.slice(0, 8)}: ${(error as Error).message}`);
        }
      }
    });
    this.sweepRun = run.finally(() => {
      this.sweepRun = null;
    });
    return this.sweepRun;
  }

  startSweeper(): void {
    this.stopped = false;
    if (this.sweepTimer !== null) return;
    const tick = () => {
      this.sweepTimer = this.d.clock.setTimeout(() => {
        void this.track(this.sweep().catch(() => undefined));
        tick();
      }, sweepEveryMs(this.timing));
    };
    tick();
  }

  /** Stop every timer (Discord was turned off, or the daemon is shutting down). */
  stop(): void {
    this.stopped = true;
    this.reconciled = false;
    if (this.sweepTimer !== null) this.d.clock.clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
    for (const sessionId of [...this.renameTimers.keys()]) this.cancelRename(sessionId);
  }
}

/** A `continued-in` record's session id, or null for any other line. */
function continuedInRecord(line: string): string | null {
  if (!line.includes('"continued-in"')) return null;
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.type === "continued-in" && typeof record.continuedInSessionId === "string") {
      return record.continuedInSessionId.toLowerCase();
    }
  } catch {
    // a torn line
  }
  return null;
}

/** The sessions a transcript says its chat went on in (`continued-in` records), oldest first. */
async function continuedIn(transcriptPath: string): Promise<string[]> {
  const lines = (await readTailLines(transcriptPath)) ?? [];
  return lines.map(continuedInRecord).filter((id): id is string => id !== null);
}

/** The session the chat went on in, when a `continued-in` record comes after the transcript's last turn. */
async function movedOnTo(transcriptPath: string): Promise<string | null> {
  let next: string | null = null;
  for (const line of (await readTailLines(transcriptPath)) ?? []) {
    const id = continuedInRecord(line);
    if (id !== null) next = id;
    else if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) next = null;
  }
  return next;
}
