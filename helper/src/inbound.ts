import { basename } from "node:path";
import { SURFACE_INFO, isUnnamed } from "./channels.ts";
import type { Daemon, DiscordMessage } from "./daemon.ts";
import type { ListenerEvent } from "./events.ts";
import type { ListenerHub } from "./listeners.ts";
import { formatTime } from "./outbound.ts";
import type { SessionEntry } from "./state.ts";
import { type Presence, type WakeOutcome, type Waker, presenceOf, wakePrompt } from "./wake.ts";

export const REPLIES = {
  stop: "Stopping.",
  pause: "Pausing after this step.",
  resume: "Resuming.",
  attachments: "Attachments aren't supported; paste the text instead.",
  notListening: "The session is open but not listening. It will see this when its current turn ends.",
  closedDesktop: "This session is closed. Open it in the Claude desktop app and it will pick this up.",
  closedVs: "This session is closed. Open it in VS Code and it will pick this up.",
  waking: "The session is being woken up; it will see this once it's listening.",
  woke: "Woke the session in the background. It will answer here.",
  savedForNextStart: "Couldn't wake the session now. Claude Code saved the message and gives it to the session when it next starts.",
  inboxFull: "The inbox was full, so the oldest waiting message was dropped.",
  controlHint: "Only `status` works here. Write in a session's channel to reach that session.",
} as const;

export function couldNotWake(reason: string): string {
  return `Couldn't wake the session: ${reason}`;
}

const CONTROL_WORDS = new Set(["stop", "pause", "resume"]);

/** Discord message types that carry what a person typed: a plain message and a reply. */
const USER_MESSAGE_TYPES = new Set([0, 19]);

/**
 * A step that may take a message before it is delivered as text (an answer to an open question). Returns
 * true when it handled the message.
 */
export type ReplyInterceptor = (session: SessionEntry, text: string, message: DiscordMessage) => boolean | Promise<boolean>;

/** What happened to an event on its way to a session. */
export type RouteResult =
  | { kind: "delivered" }
  /** Into the inbox: `why` picks the reply. */
  | { kind: "queued"; why: "between-listens" | "open" | "closed" | "waking"; dropped: number }
  /** A wake was started; it posts its own reply when it ends. */
  | { kind: "waking" };

function surfaceLabel(session: SessionEntry): string {
  return SURFACE_INFO[session.surface].category;
}

function displayName(session: SessionEntry): string {
  return !isUnnamed(session.name) ? session.name! : (session.channelName ?? session.sessionId.slice(0, 8));
}

/**
 * Messages from Discord: only the server owner's, in the configured server, in a session's channel or in
 * `#session-kit`. Control words get their reply; everything else reaches the session (see `route`).
 */
export class Inbound {
  private readonly interceptors: ReplyInterceptor[] = [];
  private readonly waking = new Set<string>();
  private wakeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly daemon: Daemon,
    private readonly hub: ListenerHub,
    private readonly waker: Waker,
  ) {}

  addInterceptor(interceptor: ReplyInterceptor): void {
    this.interceptors.push(interceptor);
  }

  /** The daemon's inbound handler. */
  handle = async (message: DiscordMessage, session: SessionEntry | null): Promise<void> => {
    const config = this.daemon.currentConfig();
    if (config.guildId === null || message.guild_id !== config.guildId) return;
    const author = message.author;
    if (!author || author.bot === true || author.id === undefined || author.id !== config.ownerId) return;
    if (typeof message.type === "number" && !USER_MESSAGE_TYPES.has(message.type)) return;
    const control = config.controlChannelId !== null && message.channel_id === config.controlChannelId;
    if (!session && !control) return;

    const target = control ? "control" : session!.sessionId;
    const text = (message.content ?? "").trim();
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      this.daemon.post(target, REPLIES.attachments);
    }
    if (text === "") return;
    const word = text.toLowerCase();

    if (control) {
      this.daemon.post("control", word === "status" ? await this.statusOfAll() : REPLIES.controlHint);
      return;
    }
    const s = session!;
    if (word === "status") {
      this.daemon.post(s.sessionId, await this.statusOf(s));
      return;
    }
    if (CONTROL_WORDS.has(word)) {
      const result = await this.route(s.sessionId, { type: word as "stop" | "pause" | "resume" }, {});
      const extra = result.kind === "queued" && result.dropped > 0 ? ` ${REPLIES.inboxFull}` : "";
      this.daemon.post(s.sessionId, `${REPLIES[word as "stop" | "pause" | "resume"]}${extra}`);
      return;
    }
    for (const interceptor of this.interceptors) {
      if (await interceptor(s, text, message)) return;
    }
    const event: ListenerEvent = { type: "text", id: message.id, text, at: this.daemon.deps.clock.now() };
    const result = await this.route(s.sessionId, event, { wakeText: text, secret: text });
    this.replyFor(s, result);
  };

  /** The reply for a routed message, if it needs one. */
  replyFor(session: SessionEntry, result: RouteResult): void {
    if (result.kind !== "queued") return;
    const lines: string[] = [];
    if (result.why === "open") lines.push(REPLIES.notListening);
    else if (result.why === "closed") lines.push(session.surface === "vs" ? REPLIES.closedVs : REPLIES.closedDesktop);
    else if (result.why === "waking") lines.push(REPLIES.waking);
    if (result.dropped > 0) lines.push(REPLIES.inboxFull);
    if (lines.length > 0) this.daemon.post(session.sessionId, lines.join(" "));
  }

  private queue(sessionId: string, event: ListenerEvent, why: "between-listens" | "open" | "closed" | "waking"): RouteResult {
    const dropped = this.daemon.sessions.pushInbox(sessionId, event);
    return { kind: "queued", why, dropped };
  }

  /**
   * Get an event to a session, in this order: its waiting listener; else its inbox, when it is open (the Stop
   * hook hands the inbox over at the end of its turn) or a desktop or VS Code session that is closed; a
   * closed terminal session is woken with `wakeText` (when given), and the event waits in the inbox if the
   * wake fails.
   */
  async route(sessionId: string, event: ListenerEvent, o: { wakeText?: string; secret?: string }): Promise<RouteResult> {
    if (this.hub.offer(sessionId, event)) return { kind: "delivered" };
    const session = this.daemon.sessions.get(sessionId);
    if (!session) return { kind: "queued", why: "closed", dropped: 0 };
    if (this.hub.recentlyListened(sessionId)) return this.queue(sessionId, event, "between-listens");
    if (this.waking.has(sessionId) || this.waker.busy(sessionId) === "cooldown") return this.queue(sessionId, event, "waking");

    const status = (await this.waker.lookup([sessionId])).get(sessionId) ?? null;
    // While the list was being read, a listener may have started.
    if (this.hub.offer(sessionId, event)) return { kind: "delivered" };
    let presence = presenceOf(status);
    if (presence === "unknown") presence = session.closedAt === null ? "open" : "closed";

    if (session.surface !== "cli") {
      // Desktop and VS Code sessions cannot be woken; one the list leaves out counts as open until it ends.
      const open = presence !== "closed" || session.closedAt === null;
      return this.queue(sessionId, event, open ? "open" : "closed");
    }
    if (presence === "open" || presence === "busy") return this.queue(sessionId, event, "open");
    if (o.wakeText === undefined) return this.queue(sessionId, event, presence === "idle" ? "open" : "closed");

    // A closed (or idle background) terminal session: wake it, one wake at a time.
    this.waking.add(sessionId);
    const wakeText = o.wakeText;
    const run = this.wakeChain.then(() => this.wakeAndReport(session, event, wakeText, o.secret ?? ""));
    this.wakeChain = run.catch(() => undefined);
    void run.finally(() => this.waking.delete(sessionId));
    return { kind: "waking" };
  }

  /** Resolves when no wake is running (for tests). */
  async settle(): Promise<void> {
    while (this.waking.size > 0) await this.wakeChain;
  }

  private async wakeAndReport(session: SessionEntry, event: ListenerEvent, wakeText: string, secret: string): Promise<WakeOutcome> {
    const outcome = await this.waker.wake({ sessionId: session.sessionId, cwd: session.cwd }, wakePrompt(wakeText), secret);
    const keep = (front: boolean) => this.daemon.sessions.pushInbox(session.sessionId, event, { front });
    let reply: string;
    switch (outcome.kind) {
      case "started":
        reply = REPLIES.woke;
        break;
      // The CLI holds the wake prompt, with the message in it, until the session next starts: keeping the
      // event as well would deliver it twice.
      case "saved":
        reply = REPLIES.savedForNextStart;
        break;
      case "interactive":
      case "busy":
      case "copy":
        keep(false);
        reply = REPLIES.notListening;
        break;
      case "in_flight":
      case "cooldown":
        keep(false);
        reply = REPLIES.waking;
        break;
      case "unknown":
        keep(true);
        reply = couldNotWake("the list of sessions couldn't be read");
        break;
      case "gone":
        keep(true);
        reply = couldNotWake("Claude Code doesn't know this session any more");
        break;
      case "failed":
        keep(true);
        reply = couldNotWake(outcome.reason);
        break;
    }
    this.daemon.post(session.sessionId, reply);
    return outcome;
  }

  /**
   * One word for where the session stands. A desktop or VS Code session the list leaves out counts as open
   * until it ends, the same as when routing.
   */
  private presenceWord(session: SessionEntry, presence: Presence): string {
    if (presence === "unknown") return session.closedAt === null ? "open" : "closed";
    if (presence === "closed" && session.surface !== "cli" && session.closedAt === null) return "open";
    return presence;
  }

  /** The `status` reply in a session's channel. */
  async statusOf(session: SessionEntry): Promise<string> {
    const status = (await this.waker.lookup([session.sessionId])).get(session.sessionId) ?? null;
    const state = this.presenceWord(session, presenceOf(status));
    const listening = this.hub.isListening(session.sessionId) ? ", listening" : "";
    return [
      `${displayName(session)} · ${surfaceLabel(session)} · ${state}${listening}`,
      `Last post from the session: ${session.lastSendAt === null ? "none yet" : formatTime(session.lastSendAt)}`,
      `Folder: ${basename(session.cwd) || session.cwd}`,
    ].join("\n");
  }

  /** The `status` reply in `#session-kit`: every linked session. */
  async statusOfAll(): Promise<string> {
    const linked = this.daemon.sessions.all().filter((e) => e.channelId !== null);
    if (linked.length === 0) return "No sessions are linked.";
    const statuses = await this.waker.lookup(linked.map((e) => e.sessionId));
    const lines = linked.map((e) => {
      const state = this.presenceWord(e, presenceOf(statuses.get(e.sessionId) ?? null));
      const last = e.lastSendAt === null ? "no posts yet" : `last post ${formatTime(e.lastSendAt)}`;
      return `- #${e.channelName} · ${surfaceLabel(e)} · ${state}${e.archived ? " · archived" : ""} · ${last}`;
    });
    return [`${linked.length} linked ${linked.length === 1 ? "session" : "sessions"}:`, ...lines].join("\n");
  }
}
