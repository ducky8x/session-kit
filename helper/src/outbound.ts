import { backoffMs } from "./backoff.ts";
import type { Clock, TimerHandle } from "./clock.ts";
import { type RestClient, RestError, UNKNOWN_CHANNEL } from "./discord/rest.ts";
import { DEFAULT_AWAY_MINUTES } from "./config.ts";
import type { Logger } from "./log.ts";
import { type IdleReading, isAway, lastInputAt } from "./presence.ts";
import { DISCORD_MAX_TEXT, splitMessage } from "./split.ts";
import { readJsonLines, writeFileAtomic } from "./state.ts";

/**
 * What every post sends as `allowed_mentions`: nobody. The helper never @mentions the user, and mentions in the
 * text itself (@everyone, @here, roles, users) notify no one.
 */
export const NO_MENTIONS = { parse: [] as string[] };

/** Turn a post into Discord messages: split to fit 2,000 characters. */
export function buildPosts(text: string): string[] {
  return splitMessage(text, DISCORD_MAX_TEXT);
}

/** One post waiting for Discord, one line of `outbox.jsonl`. */
export interface OutboxEntry {
  id: string;
  /** When it was queued. */
  at: number;
  /** A session id, or `control` for `#session-kit`. */
  target: string;
  content: string;
  /** A label the poster picks, handed back when the post goes out (to find the message again, say to edit it). */
  tag?: string;
  /** The post already met a deleted channel once; a second time drops it. */
  remade?: boolean;
  /** Held until the user is away from the computer (see `Outbox`). A held post isn't sent. */
  held?: boolean;
  /** When a held post was made. */
  madeAt?: number;
  /** When the keyboard or mouse was last used, as read just after a held post was made. */
  inputAt?: number;
  /**
   * The open item a held post stands for, such as a question or a permission prompt. Using the computer doesn't
   * drop it: it goes out once the user is away, if it's still open then.
   */
  open?: string;
  /** For a permission prompt: the session's transcript, read to see whether it was handled at the keyboard. */
  transcriptPath?: string;
}

/** Posts that waited longer than this are dropped rather than sent late. */
export const OUTBOX_MAX_AGE_MS = 24 * 3_600_000;

/** While posts are held, the idle time is read this often. */
export const HOLD_CHECK_MS = 30_000;
/** Readings of the last input can differ by the time ioreg takes, so later input must be newer by this much. */
const INPUT_SLACK_MS = 2000;

/** A time in a notice: local date and time, to the minute. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function droppedNotice(count: number, first: number, last: number): string {
  return count === 1
    ? `1 post from ${formatTime(first)} was dropped while offline.`
    : `${count} posts from ${formatTime(first)} to ${formatTime(last)} were dropped while offline.`;
}

export interface OutboxDeps {
  file: string;
  clock: Clock;
  log: Logger;
  rest: RestClient;
  controlChannelId(): string | null;
  /** The channel to post an entry in, made or moved out of Archive if needed. Null drops the entry. */
  resolveChannel(entry: OutboxEntry): Promise<string | null>;
  /** Discord says the channel is gone: unlink its session, so the next resolve makes a new channel. */
  onUnknownChannel(entry: OutboxEntry, channelId: string): void;
  /** A post went out. */
  onPosted?(entry: OutboxEntry, channelId: string, messageId: string): void;
  /** Reads the user's idle time. Without it the idle time is unknown, which counts as away. */
  readIdle?(): Promise<IdleReading>;
  /** How long without keyboard or mouse input counts as away. Default 5 minutes. */
  awayMs?(): number;
  /** Is the open item a held post stands for still waiting on the user? Without it, yes. */
  isOpen?(entry: OutboxEntry): Promise<boolean>;
  /** A held post was let go: it goes out next. */
  onReleased?(entry: OutboxEntry): void;
}

/**
 * Posts on their way to Discord, kept in `outbox.jsonl` so none is lost to a restart or an outage. They go out
 * one at a time, in the order they were queued, whenever the helper is online.
 *
 * A held post waits while the user is at the computer. The idle time is read when it's queued and every 30
 * seconds while anything is held. A post goes out once the user has gone `awayMs` without input, and is dropped
 * if they used the computer after it was made. An open item (`open`) isn't dropped for that: it goes out the
 * first time the user is away, unless `isOpen` says it was settled. Held posts keep their place in the queue;
 * posts that aren't held go out past them.
 */
export class Outbox {
  private queue: OutboxEntry[];
  private online = false;
  private running: Promise<void> | null = null;
  private retryTimer: TimerHandle | null = null;
  private failures = 0;
  private nextId = 1;
  private closed = false;
  private holdTimer: TimerHandle | null = null;
  private checking: Promise<void> | null = null;
  private checkAgain = false;

  constructor(private readonly d: OutboxDeps) {
    this.queue = readJsonLines(d.file).filter(isEntry).map(withoutMention);
  }

  get size(): number {
    return this.queue.length;
  }

  /** How many posts are held until the user is away. */
  get heldCount(): number {
    return this.queue.filter((e) => e.held).length;
  }

  /**
   * Queue posts (the pieces of one message go in together, so nothing slips between them) and return them as
   * queued. Held posts are checked against the idle time at once.
   */
  enqueue(posts: readonly Omit<OutboxEntry, "id" | "at">[]): OutboxEntry[] {
    if (posts.length === 0) return [];
    const at = this.d.clock.now();
    const added = posts.map((post) => ({
      ...post,
      id: `${at.toString(36)}-${this.nextId++}`,
      at,
      ...(post.held ? { madeAt: at } : {}),
    }));
    this.queue.push(...added);
    this.save();
    if (added.some((e) => e.held)) this.checkSoon();
    this.kick();
    return added;
  }

  /** Are any of these posts still held? */
  anyHeld(entries: readonly OutboxEntry[]): boolean {
    return entries.some((e) => e.held === true && this.queue.includes(e));
  }

  /** Is a post like this queued? */
  has(match: (entry: OutboxEntry) => boolean): boolean {
    return this.queue.some(match);
  }

  /** Drop the held posts that match (an open item that was settled) without sending them. Returns how many. */
  discardHeld(match: (entry: OutboxEntry) => boolean): number {
    const gone = this.queue.filter((e) => e.held && match(e));
    if (gone.length === 0) return 0;
    this.queue = this.queue.filter((e) => !gone.includes(e));
    for (const entry of gone) this.d.log.debug(`dropped held post ${entry.id}: ${entry.open ?? "it"} was settled`);
    this.save();
    return gone.length;
  }

  /** Check held posts now (after a restart). */
  recheck(): void {
    if (this.queue.some((e) => e.held)) this.checkSoon();
  }

  /**
   * Discord became reachable (true: the gateway connected, or checks on battery power began) or not (false).
   * Coming online sends what is waiting.
   */
  setOnline(online: boolean): void {
    this.online = online;
    if (online) {
      this.failures = 0;
      this.cancelRetry();
      this.kick();
    }
  }

  /** Resolves when nothing is being sent or checked right now (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running || this.checking) {
      await this.running;
      await this.checking;
    }
  }

  close(): void {
    this.closed = true;
    this.cancelRetry();
    if (this.holdTimer !== null) this.d.clock.clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  // ---- holding posts while the user is at the computer ----------------------------------------

  /** Check the held posts after any check under way, and every 30 seconds from now while any are held. */
  private checkSoon(): void {
    if (this.closed) return;
    this.armHoldTimer();
    if (this.checking) {
      this.checkAgain = true;
      return;
    }
    this.checking = this.checkLoop().finally(() => {
      this.checking = null;
    });
  }

  private async checkLoop(): Promise<void> {
    do {
      this.checkAgain = false;
      try {
        await this.checkHeld();
      } catch (error) {
        this.d.log.warn(`checking held posts failed: ${(error as Error).message}`);
      }
    } while (this.checkAgain && !this.closed);
    if (this.queue.some((e) => e.held)) this.armHoldTimer();
    else if (this.holdTimer !== null) {
      this.d.clock.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private armHoldTimer(): void {
    if (this.closed || this.holdTimer !== null) return;
    // Each check sets the next before it runs, so they stay 30 seconds apart however long one takes.
    this.holdTimer = this.d.clock.setTimeout(() => {
      this.holdTimer = null;
      this.checkSoon();
    }, HOLD_CHECK_MS);
  }

  /** Read the idle time once, then send, keep or drop each held post, in order. */
  private async checkHeld(): Promise<void> {
    if (!this.queue.some((e) => e.held)) return;
    const startedAt = this.d.clock.now();
    const reading = this.d.readIdle ? await this.d.readIdle() : { at: this.d.clock.now(), idleMs: null };
    const away = isAway(reading, this.d.awayMs?.() ?? DEFAULT_AWAY_MINUTES * 60_000);
    const lastInput = lastInputAt(reading);
    let changed = false;
    // Posts made while ioreg ran wait for the next reading (`checkSoon` asks for one).
    for (const entry of this.queue.filter((e) => e.held && (e.madeAt ?? e.at) <= startedAt)) {
      if (this.closed) return;
      if (entry.open !== undefined) {
        if (!away) continue;
        const open = this.d.isOpen ? await this.d.isOpen(entry) : true;
        if (!entry.held || !this.queue.includes(entry)) continue; // let go or dropped meanwhile
        if (open) this.release(entry);
        else this.dropHeld(entry, `${entry.open} was settled`);
        changed = true;
        continue;
      }
      const madeAt = entry.madeAt ?? entry.at;
      if (lastInput !== null && lastInput > (entry.inputAt ?? madeAt) + INPUT_SLACK_MS) {
        this.dropHeld(entry, "the user was at the computer");
        changed = true;
        continue;
      }
      if (lastInput !== null && entry.inputAt === undefined) {
        entry.inputAt = lastInput;
        changed = true;
      }
      if (away) {
        this.release(entry);
        changed = true;
      }
    }
    if (!changed) return;
    this.save();
    this.kick();
  }

  /** Let a held post go. The 24 hours a post may wait for Discord count from now. */
  private release(entry: OutboxEntry): void {
    delete entry.held;
    delete entry.inputAt;
    entry.at = this.d.clock.now();
    try {
      this.d.onReleased?.(entry);
    } catch (error) {
      this.d.log.warn(`a released listener failed: ${(error as Error).message}`);
    }
  }

  private dropHeld(entry: OutboxEntry, why: string): void {
    this.queue = this.queue.filter((e) => e !== entry);
    this.d.log.debug(`dropped held post ${entry.id}: ${why}`);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.d.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private kick(): void {
    if (this.running || !this.online || this.closed || this.retryTimer !== null) return;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }

  private save(): void {
    writeFileAtomic(this.d.file, this.queue.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }

  /** Drop posts that waited for Discord longer than 24 hours, and queue one notice about them (held, like any notice). */
  private pruneStale(): void {
    const cutoff = this.d.clock.now() - OUTBOX_MAX_AGE_MS;
    const stale = this.queue.filter((e) => !e.held && e.at < cutoff);
    if (stale.length === 0) return;
    this.queue = this.queue.filter((e) => !stale.includes(e));
    this.d.log.warn(`dropped ${stale.length} posts older than 24 hours`);
    const control = this.d.controlChannelId();
    if (control !== null) {
      const times = stale.map((e) => e.at);
      const now = this.d.clock.now();
      this.queue.push({
        id: `notice-${now.toString(36)}`,
        at: now,
        target: "control",
        content: droppedNotice(stale.length, Math.min(...times), Math.max(...times)),
        held: true,
        madeAt: now,
      });
      this.checkSoon();
    }
    this.save();
  }

  private async drain(): Promise<void> {
    this.pruneStale();
    while (this.online && !this.closed) {
      const entry = this.queue.find((e) => !e.held);
      if (entry === undefined) return;
      let channelId: string | null;
      try {
        channelId = await this.d.resolveChannel(entry);
      } catch (error) {
        if (this.giveUpOn(entry, error)) continue;
        this.waitAndRetry();
        return;
      }
      if (channelId === null) {
        this.d.log.warn(`dropped post ${entry.id}: no channel for it`);
        this.drop(entry);
        continue;
      }
      try {
        const message = await this.d.rest.request<{ id: string }>("POST", `/channels/${channelId}/messages`, {
          body: { content: entry.content, allowed_mentions: NO_MENTIONS },
        });
        this.drop(entry);
        this.failures = 0;
        this.d.onPosted?.(entry, channelId, message?.id ?? "");
      } catch (error) {
        if (error instanceof RestError && error.code === UNKNOWN_CHANNEL && !entry.remade) {
          entry.remade = true;
          this.save();
          this.d.onUnknownChannel(entry, channelId);
          continue;
        }
        if (this.giveUpOn(entry, error)) continue;
        this.waitAndRetry();
        return;
      }
    }
  }

  /** A refusal that will not change (a 4xx) drops the post; anything else is worth trying again. */
  private giveUpOn(entry: OutboxEntry, error: unknown): boolean {
    if (error instanceof RestError && (error.kind === "client" || error.kind === "rate-limited")) {
      this.d.log.warn(`dropped post ${entry.id}: ${error.route} -> ${error.status}`);
      this.drop(entry);
      return true;
    }
    return false;
  }

  private waitAndRetry(): void {
    const wait = backoffMs(this.failures++);
    this.d.log.info(`outbox paused for ${wait} ms with ${this.queue.length} posts waiting`);
    this.retryTimer = this.d.clock.setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, wait);
  }

  private drop(entry: OutboxEntry): void {
    this.queue = this.queue.filter((e) => e !== entry);
    this.save();
  }
}

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.at === "number" && typeof e.target === "string" && typeof e.content === "string";
}

/**
 * An entry queued by an older helper may start with an @mention of the user, marked by `allowedMentions.users`.
 * The mention comes off, and so does the field.
 */
function withoutMention(entry: OutboxEntry): OutboxEntry {
  const { allowedMentions, ...rest } = entry as OutboxEntry & { allowedMentions?: { users?: unknown } };
  const pinged = Array.isArray(allowedMentions?.users) && allowedMentions.users.length > 0;
  return pinged ? { ...rest, content: rest.content.replace(/^<@!?\d+>\s*/, "") } : rest;
}
