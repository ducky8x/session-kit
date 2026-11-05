import { backoffMs } from "./backoff.ts";
import type { Clock, TimerHandle } from "./clock.ts";
import { type RestClient, RestError, UNKNOWN_CHANNEL } from "./discord/rest.ts";
import type { Logger } from "./log.ts";
import { readJsonLines, writeFileAtomic } from "./state.ts";

/** What Discord's `allowed_mentions` gets: who a post may notify. */
export interface AllowedMentions {
  parse: string[];
  users?: string[];
}

/** One post waiting for Discord, one line of `outbox.jsonl`. */
export interface OutboxEntry {
  id: string;
  /** When it was queued. */
  at: number;
  /** A session id, or `control` for `#session-kit`. */
  target: string;
  content: string;
  allowedMentions: AllowedMentions;
  /** The post already met a deleted channel once; a second time drops it. */
  remade?: boolean;
}

/** Posts that waited longer than this are dropped rather than sent late. */
export const OUTBOX_MAX_AGE_MS = 24 * 3_600_000;

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
}

/**
 * Posts on their way to Discord, kept in `outbox.jsonl` so none is lost to a restart or an outage. They go out
 * one at a time, in the order they were queued, whenever the helper is online.
 */
export class Outbox {
  private queue: OutboxEntry[];
  private online = false;
  private running: Promise<void> | null = null;
  private retryTimer: TimerHandle | null = null;
  private failures = 0;
  private nextId = 1;
  private closed = false;

  constructor(private readonly d: OutboxDeps) {
    this.queue = readJsonLines(d.file).filter(isEntry);
  }

  get size(): number {
    return this.queue.length;
  }

  /** Queue posts (the pieces of one message go in together, so nothing slips between them). */
  enqueue(posts: readonly Omit<OutboxEntry, "id" | "at">[]): void {
    if (posts.length === 0) return;
    const at = this.d.clock.now();
    for (const post of posts) this.queue.push({ ...post, id: `${at.toString(36)}-${this.nextId++}`, at });
    this.save();
    this.kick();
  }

  /** The gateway connected (true) or dropped (false). Coming online sends what is waiting. */
  setOnline(online: boolean): void {
    this.online = online;
    if (online) {
      this.failures = 0;
      this.cancelRetry();
      this.kick();
    }
  }

  /** Resolves when nothing is being sent right now (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  close(): void {
    this.closed = true;
    this.cancelRetry();
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

  /** Drop posts older than 24 hours, and queue one notice about them. */
  private pruneStale(): void {
    const cutoff = this.d.clock.now() - OUTBOX_MAX_AGE_MS;
    const stale = this.queue.filter((e) => e.at < cutoff);
    if (stale.length === 0) return;
    this.queue = this.queue.filter((e) => e.at >= cutoff);
    this.d.log.warn(`dropped ${stale.length} posts older than 24 hours`);
    const control = this.d.controlChannelId();
    if (control !== null) {
      const times = stale.map((e) => e.at);
      this.queue.push({
        id: `notice-${this.d.clock.now().toString(36)}`,
        at: this.d.clock.now(),
        target: "control",
        content: droppedNotice(stale.length, Math.min(...times), Math.max(...times)),
        allowedMentions: { parse: [] },
      });
    }
    this.save();
  }

  private async drain(): Promise<void> {
    this.pruneStale();
    while (this.online && !this.closed && this.queue.length > 0) {
      const entry = this.queue[0]!;
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
          body: { content: entry.content, allowed_mentions: entry.allowedMentions },
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
  return (
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    typeof e.target === "string" &&
    typeof e.content === "string" &&
    !!e.allowedMentions &&
    typeof e.allowedMentions === "object"
  );
}
