import type { Clock, TimerHandle } from "./clock.ts";
import type { DiscordMessage } from "./daemon.ts";
import { RestError, type RestClient, UNKNOWN_CHANNEL } from "./discord/rest.ts";
import type { Logger } from "./log.ts";
import type { Paths } from "./paths.ts";
import { ensurePrivateDir, readJsonFile, writeFileAtomic } from "./state.ts";

/** Discord lists at most this many messages per request. */
export const PAGE_SIZE = 100;

function isId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

/** Discord ids grow with time: is `a` later than `b`? */
export function laterId(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

/** Discord's epoch, 2015-01-01: an id holds the milliseconds since then above its low 22 bits. */
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** When the message (or channel) with this id was made, in milliseconds since 1970. */
export function idTime(id: string): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
}

/**
 * The newest message the helper has seen in each channel it reads, in `cursors.json`, so a check on battery
 * power, or the catch-up after a new gateway session, starts where the helper last stopped, even after a restart.
 */
export class CursorStore {
  private readonly cursors = new Map<string, string>();

  constructor(private readonly paths: Paths) {
    const raw = readJsonFile(paths.cursors);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [channelId, messageId] of Object.entries(raw as Record<string, unknown>)) {
        if (isId(channelId) && isId(messageId)) this.cursors.set(channelId, messageId);
      }
    }
  }

  get(channelId: string): string | undefined {
    return this.cursors.get(channelId);
  }

  /** Move a channel's cursor up to `messageId`. It never moves back. */
  advance(channelId: string, messageId: string): void {
    if (!isId(channelId) || !isId(messageId)) return;
    const current = this.cursors.get(channelId);
    if (current !== undefined && !laterId(messageId, current)) return;
    this.cursors.set(channelId, messageId);
    this.save();
  }

  /** A copy of every cursor as it is now. */
  snapshot(): Map<string, string> {
    return new Map(this.cursors);
  }

  /** Forget the channels that aren't in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    const gone = [...this.cursors.keys()].filter((channelId) => !keep.has(channelId));
    if (gone.length === 0) return;
    for (const channelId of gone) this.cursors.delete(channelId);
    this.save();
  }

  clear(): void {
    if (this.cursors.size === 0) return;
    this.cursors.clear();
    this.save();
  }

  private save(): void {
    ensurePrivateDir(this.paths.dir);
    writeFileAtomic(this.paths.cursors, `${JSON.stringify(Object.fromEntries(this.cursors), null, 2)}\n`);
  }
}

/** The messages in a list from Discord, oldest first. */
function messagesIn(raw: unknown): DiscordMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is DiscordMessage => !!m && typeof m === "object" && isId((m as { id?: unknown }).id))
    .sort((a, b) => (laterId(a.id, b.id) ? 1 : laterId(b.id, a.id) ? -1 : 0));
}

export interface PollerDeps {
  rest: RestClient;
  clock: Clock;
  log: Logger;
  cursors: CursorStore;
  /** Gets ready for a check (the server's channels, the bot's id) and says which channels to read. */
  prepare(): Promise<string[]>;
  /** A message found in a channel, oldest first, to be handled like a gateway MESSAGE_CREATE. */
  deliver(message: DiscordMessage): void;
  /** The message was handed on before, by the gateway or an earlier read. */
  handled(messageId: string): boolean;
  /** Discord says the channel is gone. */
  onUnknownChannel(channelId: string): void;
  /** Discord refused the bot token. The checks have stopped. */
  onRejected(): void;
}

/**
 * How one pass over the channels reads them. `since` gives starting points that take the place of the cursors.
 * With `maxAgeMs` it's a catch-up: only the channels in `since` are read, a message older than that is skipped,
 * and a failure is only logged.
 */
interface Pass {
  since?: ReadonlyMap<string, string>;
  maxAgeMs?: number;
}

/** What a catch-up found: messages handed on, and messages skipped as too old. */
interface Tally {
  handedOn: number;
  skipped: number;
}

/** "1 message", "2 messages". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Checks Discord for new messages on a timer, for when the helper keeps no gateway connection (on battery
 * power). Each check reads every channel the helper watches, after its cursor, one channel at a time; the REST
 * client waits out rate limits. Network trouble ends a check early, and the next one tries again. A catch-up
 * (`catchUp`) reads the same way, once, after a new gateway session.
 */
export class MessagePoller {
  private timer: TimerHandle | null = null;
  private generation = 0;
  private everyMs: number | null = null;
  private current: Promise<void> | null = null;

  constructor(private readonly d: PollerDeps) {}

  /** The timer runs. */
  get running(): boolean {
    return this.everyMs !== null;
  }

  /** How long the timer waits between checks, or null when it doesn't run. */
  get intervalMs(): number | null {
    return this.everyMs;
  }

  /** Check now and then every `everyMs`, until `stop`. A tick that comes while a check runs is skipped. */
  start(everyMs: number): void {
    this.stop();
    this.everyMs = everyMs;
    const generation = this.generation;
    const arm = () => {
      this.timer = this.d.clock.setTimeout(() => {
        this.timer = null;
        if (generation !== this.generation) return;
        arm();
        if (this.current === null) void this.check();
      }, everyMs);
    };
    arm();
    void this.check();
  }

  /** Stop the timer. A check under way stops before its next request, and hands on nothing more. */
  stop(): void {
    this.generation++;
    this.everyMs = null;
    if (this.timer !== null) this.d.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Read every watched channel once, after any check still under way. `since` gives the starting point for
   * some channels in place of their cursors (after a switch to AC power).
   */
  check(since?: ReadonlyMap<string, string>): Promise<void> {
    return this.enqueue(since === undefined ? {} : { since });
  }

  /**
   * Read what came in while the helper had no gateway session: each channel in `from`, after the message id it
   * gives, after any check still under way. A message older than `maxAgeMs` is skipped, though the cursor still
   * moves past it. A failure is only logged.
   */
  catchUp(from: ReadonlyMap<string, string>, maxAgeMs: number): Promise<void> {
    return this.enqueue({ since: from, maxAgeMs });
  }

  private enqueue(pass: Pass): Promise<void> {
    const generation = this.generation;
    const run = (this.current ?? Promise.resolve())
      .then(() => this.run(generation, pass))
      .catch((error) => this.d.log.warn(`checking Discord failed: ${(error as Error).message}`));
    const tracked: Promise<void> = run.finally(() => {
      if (this.current === tracked) this.current = null;
    });
    this.current = tracked;
    return tracked;
  }

  /** Resolves when no check is under way (for tests and shutdown). */
  async settle(): Promise<void> {
    while (this.current) await this.current;
  }

  private async run(generation: number, pass: Pass): Promise<void> {
    if (generation !== this.generation) return;
    const { since, maxAgeMs } = pass;
    const catchUp = maxAgeMs !== undefined;
    const tally: Tally = { handedOn: 0, skipped: 0 };
    try {
      const channels = catchUp ? [...(since?.keys() ?? [])] : await this.d.prepare();
      for (const channelId of channels) {
        if (generation !== this.generation) return;
        try {
          await this.read(generation, channelId, since?.get(channelId), maxAgeMs, tally);
        } catch (error) {
          if (!(error instanceof RestError) || error.kind !== "client" || error.status === 401) throw error;
          // Any other refusal (no access to this channel, say) is logged by the REST client; the rest are still read.
          if (error.code === UNKNOWN_CHANNEL) this.d.onUnknownChannel(channelId);
        }
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (catchUp) {
        // The gateway accepted the token, so a 401 here doesn't mark it as refused.
        this.d.log.warn(`catching up stopped: ${(error as Error).message}`);
      } else if (error instanceof RestError && error.status === 401) {
        this.d.log.warn("checking Discord stopped: the bot token was refused");
        this.stop();
        this.d.onRejected();
        return;
      } else {
        this.d.log.warn(`checking Discord stopped: ${(error as Error).message}`);
      }
    }
    if (maxAgeMs !== undefined && tally.handedOn + tally.skipped > 0) {
      const age = plural(Math.round(maxAgeMs / 60_000), "minute");
      const skipped = tally.skipped > 0 ? `, skipped ${tally.skipped} older than ${age}` : "";
      this.d.log.info(`caught up on ${plural(tally.handedOn, "message")}${skipped}`);
    }
  }

  /**
   * Hand on a channel's messages after `from` (or its cursor), oldest first, a page at a time. With `maxAgeMs`,
   * a message older than that is skipped, but the cursor still moves past it. `tally` counts what was new.
   */
  private async read(
    generation: number,
    channelId: string,
    from: string | undefined,
    maxAgeMs: number | undefined,
    tally: Tally,
  ): Promise<void> {
    let after = from ?? this.d.cursors.get(channelId);
    if (after === undefined) {
      // The first look at this channel: start after its newest message, so nothing from before is handed on.
      // An empty channel starts at its own id, which is older than any message in it.
      const newest = messagesIn(await this.d.rest.request("GET", `/channels/${channelId}/messages?limit=1`));
      if (generation === this.generation) this.d.cursors.advance(channelId, newest.at(-1)?.id ?? channelId);
      return;
    }
    for (;;) {
      const page = await this.d.rest.request<unknown>("GET", `/channels/${channelId}/messages?after=${after}&limit=${PAGE_SIZE}`);
      if (generation !== this.generation) return;
      const messages = messagesIn(page);
      const oldest = maxAgeMs === undefined ? null : this.d.clock.now() - maxAgeMs;
      for (const message of messages) {
        const fresh = oldest === null || idTime(message.id) >= oldest;
        if (!this.d.handled(message.id)) tally[fresh ? "handedOn" : "skipped"]++;
        if (fresh) this.d.deliver({ ...message, channel_id: channelId });
      }
      const last = messages.at(-1);
      if (last === undefined) {
        // Nothing new: the starting point becomes the cursor again, in case a new gateway session cleared it.
        this.d.cursors.advance(channelId, after);
        return;
      }
      this.d.cursors.advance(channelId, last.id);
      if (!Array.isArray(page) || page.length < PAGE_SIZE) return;
      after = last.id;
    }
  }
}
