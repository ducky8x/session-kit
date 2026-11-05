import {
  ChannelManager,
  type ChannelMessage,
  type Timing,
  type UnlinkReason,
  surfaceFor,
  timingFromEnv,
} from "./channels.ts";
import type { Clock } from "./clock.ts";
import { type Config, loadConfig } from "./config.ts";
import { GatewayClient, type GatewayState } from "./discord/gateway.ts";
import { RestClient } from "./discord/rest.ts";
import type { Logger } from "./log.ts";
import { NamePoller } from "./names.ts";
import { Outbox, buildPosts } from "./outbound.ts";
import type { Paths } from "./paths.ts";
import type { ProcessRunner } from "./process.ts";
import type { Keychain } from "./secrets.ts";
import { ControlServer, HandlerRegistry, type Request, RequestError } from "./server.ts";
import { type SessionEntry, SessionStore } from "./state.ts";
import { SETUP_NEEDED, STATUS_PROBLEMS, type StatusCode } from "./status.ts";
import { readUpdateFailure } from "./update.ts";
import { VERSION } from "./version.ts";

export interface DaemonDeps {
  paths: Paths;
  env: Record<string, string | undefined>;
  clock: Clock;
  log: Logger;
  runner: ProcessRunner;
  keychain: Keychain;
  /** Tests point these at loopback fakes. */
  restBaseUrl?: string;
  gatewayUrl?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  random?: () => number;
  timing?: Timing;
  /** Is this process id alive? Tests answer for the fake CLI's processes. */
  pidAlive?: (pid: number) => boolean;
  /** Finds a command on PATH (or on the PATH given). */
  which?: (command: string, path?: string) => string | null;
  /** Features that add their own socket ops and hooks (see `extensions.ts`). */
  extensions?: readonly ((daemon: Daemon) => void)[];
}

/** A MESSAGE_CREATE event's data, as far as the helper reads it. */
export interface DiscordMessage extends ChannelMessage {
  id: string;
  guild_id?: string;
  content?: string;
  author?: { id?: string; bot?: boolean; username?: string };
  attachments?: unknown[];
  [field: string]: unknown;
}

/**
 * Called for every message posted in the configured server, in order, after its activity is counted and
 * (for an owner message) its archived channel is moved back. `session` is the session whose channel it is,
 * or null for any other channel. Filtering (who wrote it, which channel) is the handler's job.
 */
export type InboundHandler = (message: DiscordMessage, session: SessionEntry | null) => void | Promise<void>;

/** A queued post reached Discord: the message's channel and id, and the tag it was posted with. */
export interface PostedEvent {
  target: string;
  channelId: string;
  messageId: string;
  tag: string | null;
}

/** A session posted (`send`). `done` marks its run as finished. */
export interface SendEvent {
  sessionId: string;
  text: string;
  ping: boolean;
  done: boolean;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") throw new RequestError("invalid", `"${name}" must be text.`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * `sk-discord daemon`: holds the gateway connection, the session registry and the outbox, serves the control
 * socket and runs the timers. With Discord off it still serves the socket (for `status` and turning it on)
 * but does not connect.
 *
 * Commands added later plug in through `handlers` (socket ops), `onInbound` (messages from Discord),
 * `onSend` (posts from sessions), `onPosted` (posts that reached Discord) and `onGatewayEvent` (any other
 * gateway event). `extensions.ts` lists them.
 */
export class Daemon {
  readonly handlers = new HandlerRegistry();
  readonly sessions: SessionStore;
  readonly rest: RestClient;
  readonly gateway: GatewayClient;
  readonly outbox: Outbox;
  readonly channels: ChannelManager;
  readonly names: NamePoller;
  readonly server: ControlServer;
  private config: Config;
  private token: string | null = null;
  private notInServer = false;
  private botId: string | null = null;
  private readonly noticeShown = new Set<string>();
  private readonly inboundHandlers: InboundHandler[] = [];
  private readonly sendListeners: ((event: SendEvent) => void)[] = [];
  private readonly postedListeners: ((event: PostedEvent) => void)[] = [];
  private readonly dispatchListeners: ((type: string, data: any) => void)[] = [];
  private readonly configListeners: ((config: Config, before: Config) => void)[] = [];
  private readonly unlinkedListeners: ((sessionId: string, why: UnlinkReason) => void)[] = [];
  private inboundChain: Promise<void> = Promise.resolve();
  private readonly background = new Set<Promise<unknown>>();

  constructor(readonly deps: DaemonDeps) {
    const d = deps;
    const { paths, clock, log } = d;
    this.config = loadConfig(paths);
    this.sessions = new SessionStore(paths);
    this.rest = new RestClient({
      token: () => this.token,
      clock,
      log,
      ...(d.restBaseUrl ? { baseUrl: d.restBaseUrl } : {}),
      ...(d.fetch ? { fetch: d.fetch } : {}),
    });
    this.gateway = new GatewayClient({
      token: () => this.token,
      clock,
      log,
      ...(d.gatewayUrl ? { url: d.gatewayUrl } : {}),
      ...(d.random ? { random: d.random } : {}),
      ...(d.WebSocket ? { WebSocket: d.WebSocket } : {}),
      onDispatch: (type, data) => this.handleDispatch(type, data),
      onStateChange: (state) => this.onGatewayState(state),
    });
    this.channels = new ChannelManager({
      rest: this.rest,
      sessions: this.sessions,
      paths,
      clock,
      log,
      isOnline: () => this.gateway.state === "connected",
      timing: d.timing ?? timingFromEnv(d.env),
      onUnlinked: (sessionId, why) => {
        for (const listener of this.unlinkedListeners) {
          try {
            listener(sessionId, why);
          } catch (error) {
            log.warn(`an unlinked listener failed: ${(error as Error).message}`);
          }
        }
      },
    });
    this.outbox = new Outbox({
      file: paths.outbox,
      clock,
      log,
      rest: this.rest,
      controlChannelId: () => this.config.controlChannelId,
      resolveChannel: async (entry) =>
        entry.target === "control" ? this.config.controlChannelId : this.channels.ensureChannel(entry.target),
      // A post for a session goes to the channel its chat has now, which may belong to a later session.
      onUnknownChannel: (entry, channelId) => {
        if (entry.target === "control") return;
        this.sessions.unlink(this.sessions.byChannel(channelId)?.sessionId ?? entry.target);
      },
      onPosted: (entry, channelId, messageId) => {
        if (entry.target !== "control") {
          this.sessions.update(this.sessions.byChannel(channelId)?.sessionId ?? entry.target, (e) => {
            e.lastMessageAt = clock.now();
          });
        }
        const event: PostedEvent = { target: entry.target, channelId, messageId, tag: entry.tag ?? null };
        for (const listener of this.postedListeners) {
          try {
            listener(event);
          } catch (error) {
            log.warn(`a posted listener failed: ${(error as Error).message}`);
          }
        }
      },
    });
    this.names = new NamePoller({
      runner: d.runner,
      clock,
      log,
      sessions: this.sessions,
      claudePath: () => this.config.claudePath ?? "claude",
      onNames: (names) => this.channels.applyNames(names),
    });
    this.server = new ControlServer(paths.socket, this.handlers, log);
    this.addCoreHandlers();
    for (const install of d.extensions ?? []) install(this);
  }

  // ---- seams for other commands -----------------------------------------------------

  onInbound(handler: InboundHandler): void {
    this.inboundHandlers.push(handler);
  }

  onSend(listener: (event: SendEvent) => void): void {
    this.sendListeners.push(listener);
  }

  /** A post went out (with the tag `post` was given). */
  onPosted(listener: (event: PostedEvent) => void): void {
    this.postedListeners.push(listener);
  }

  /** `config.json` was read again (`reload`); `before` is what it was. */
  onConfigChange(listener: (config: Config, before: Config) => void): void {
    this.configListeners.push(listener);
  }

  /** A session lost its channel (see `ChannelDeps.onUnlinked`). */
  onUnlinked(listener: (sessionId: string, why: UnlinkReason) => void): void {
    this.unlinkedListeners.push(listener);
  }

  /** Every gateway event (op 0), before the daemon's own handling. */
  onGatewayEvent(listener: (type: string, data: any) => void): void {
    this.dispatchListeners.push(listener);
  }

  /** The current config, as last read. */
  currentConfig(): Config {
    return this.config;
  }

  /** The bot's own user id, once the gateway said it. */
  get botUserId(): string | null {
    return this.botId;
  }

  /**
   * Queue a post for a session's channel (`target` is its session id) or for `#session-kit` (`control`):
   * split, with an @mention of the owner when `ping` is set. `tag` comes back with each piece's
   * `onPosted`. Returns how many messages it became.
   */
  post(target: string, body: string, o: { ping?: boolean; tag?: string } = {}): number {
    const pieces = buildPosts(body, { ping: o.ping ?? false, ownerId: this.config.ownerId });
    this.outbox.enqueue(pieces.map((p) => ({ ...p, target, ...(o.tag === undefined ? {} : { tag: o.tag }) })));
    return pieces.length;
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Serve the socket, then connect if Discord is on. Throws AlreadyRunning when another daemon has the socket. */
  async start(): Promise<void> {
    await this.server.listen();
    this.deps.log.info(`started, version ${VERSION}`);
    await this.applyConfig();
  }

  async stop(): Promise<void> {
    this.goQuiet();
    this.server.close();
    this.outbox.close();
    // Give work in flight a moment to finish, but never hang a shutdown on Discord.
    await Promise.race([Promise.allSettled([...this.background]), Bun.sleep(2000)]);
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((error) => this.deps.log.warn(`background work failed: ${(error as Error).message}`));
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  /** Let tests wait for work the daemon started in the background. */
  async settle(): Promise<void> {
    for (;;) {
      await this.inboundChain;
      await this.channels.settle();
      await this.outbox.idle();
      if (this.background.size === 0) return;
      await Promise.allSettled([...this.background]);
    }
  }

  private goQuiet(): void {
    this.gateway.stop();
    this.names.stop();
    this.channels.stop();
    this.outbox.setOnline(false);
  }

  /** Read `config.json` and the token again, and connect or disconnect to match. */
  async applyConfig(): Promise<void> {
    const before = this.config;
    this.config = loadConfig(this.deps.paths);
    for (const listener of this.configListeners) {
      try {
        listener(this.config, before);
      } catch (error) {
        this.deps.log.warn(`a config listener failed: ${(error as Error).message}`);
      }
    }
    if (!this.config.enabled) {
      this.goQuiet();
      return;
    }
    const previousToken = this.token;
    try {
      this.token = await this.deps.keychain.getToken();
    } catch (error) {
      this.deps.log.warn(`could not read the bot token: ${(error as Error).message}`);
      this.token = null;
    }
    if (this.token === null) {
      this.goQuiet();
      return;
    }
    const logger = this.deps.log as Logger & { addSecret?: (secret: string) => void };
    logger.addSecret?.(this.token);
    this.names.start();
    this.channels.startSweeper();
    const state = this.gateway.state;
    if (this.token !== previousToken || (state !== "connected" && state !== "connecting")) {
      this.gateway.stop();
      this.gateway.start();
    }
  }

  statusCode(): StatusCode {
    if (!this.config.enabled) return "off";
    if (this.token === null) return "no-token";
    if (this.gateway.state === "token-rejected") return "token-rejected";
    if (this.gateway.state === "intent-missing") return "intent-missing";
    if (this.config.guildId === null) return "no-server";
    if (this.notInServer) return "not-in-server";
    if (readUpdateFailure(this.deps.paths) !== null) return "update-failed";
    return this.gateway.state === "connected" ? "connected" : "connecting";
  }

  statusReport(): Record<string, unknown> {
    const status = this.statusCode();
    const problem = STATUS_PROBLEMS[status];
    const all = this.sessions.all();
    return {
      status,
      ...(problem ? { problem: problem.problem, fix: problem.fix } : {}),
      version: VERSION,
      sessions: all.length,
      linked: all.filter((e) => e.channelId !== null).length,
      archived: all.filter((e) => e.archived).length,
      outbox: this.outbox.size,
    };
  }

  // ---- the gateway ------------------------------------------------------------------------------

  private onGatewayState(state: GatewayState): void {
    this.deps.log.info(`gateway ${state}`);
    this.outbox.setOnline(state === "connected");
  }

  private handleDispatch(type: string, data: any): void {
    for (const listener of this.dispatchListeners) {
      try {
        listener(type, data);
      } catch (error) {
        this.deps.log.warn(`a ${type} listener failed: ${(error as Error).message}`);
      }
    }
    const guildId = this.config.guildId;
    switch (type) {
      case "READY": {
        this.botId = typeof data?.user?.id === "string" ? data.user.id : null;
        if (guildId !== null && Array.isArray(data?.guilds)) {
          this.notInServer = !data.guilds.some((g: { id?: unknown }) => g?.id === guildId);
          if (this.notInServer) this.deps.log.warn("the bot is not in the configured server");
        }
        this.track(this.channels.onConnected());
        return;
      }
      case "GUILD_CREATE":
        if (data?.id === guildId) this.notInServer = false;
        return;
      case "GUILD_DELETE":
        if (data?.id === guildId && data?.unavailable !== true) {
          this.notInServer = true;
          this.deps.log.warn("the bot was removed from the configured server");
        }
        return;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "CHANNEL_DELETE":
        this.channels.onChannelEvent(type, data);
        return;
      case "MESSAGE_CREATE": {
        if (!data || data.guild_id !== guildId || typeof data.channel_id !== "string") return;
        const message = data as DiscordMessage;
        this.inboundChain = this.inboundChain
          .then(() => this.onMessage(message))
          .catch((error) => this.deps.log.warn(`handling a message failed: ${(error as Error).message}`));
        return;
      }
    }
  }

  private async onMessage(message: DiscordMessage): Promise<void> {
    const session = await this.channels.noteMessage(message, { ownerId: this.config.ownerId, botId: this.botId });
    for (const handler of this.inboundHandlers) await handler(message, session);
  }

  // ---- socket ops -------------------------------------------------------------------------------

  private requireOn(): void {
    if (!this.config.enabled) throw new RequestError("off", "Discord is off (/discord on to turn it on)");
  }

  private addCoreHandlers(): void {
    this.handlers
      .add("status", () => this.statusReport())
      .add("reload", async () => {
        await this.applyConfig();
        return this.statusReport();
      })
      .add("register", (req) => this.register(req))
      .add("ended", (req) => {
        this.channels.ended(text(req.sessionId, "sessionId"));
        return {};
      })
      .add("send", (req) => this.send(req));
  }

  private async register(req: Request): Promise<Record<string, unknown>> {
    this.requireOn();
    const sessionId = text(req.sessionId, "sessionId");
    const result = await this.channels.register({
      sessionId,
      source: optionalText(req.source) ?? "startup",
      cwd: optionalText(req.cwd) ?? "",
      transcriptPath: optionalText(req.transcriptPath),
      entrypoint: optionalText(req.entrypoint),
      claudePid: positiveInteger(req.claudePid),
    });
    const status = this.statusCode();
    let notice = false;
    if (result.registered && SETUP_NEEDED.has(status) && !this.noticeShown.has(sessionId)) {
      this.noticeShown.add(sessionId);
      notice = true;
    }
    return { ...result, status, notice };
  }

  /**
   * Make sure the helper knows the session, registering it from what a command sends along (its entry point
   * and folder) when Discord was turned on after it started. False: it is unknown and not interactive.
   */
  async adopt(sessionId: string, entrypoint: string | null, cwd: string | null): Promise<boolean> {
    if (this.sessions.get(sessionId)) return true;
    if (surfaceFor(entrypoint) === null) return false;
    await this.channels.register({ sessionId, source: "resume", cwd: cwd ?? "", transcriptPath: null, entrypoint });
    return true;
  }

  /**
   * A session posts in its channel. A session the helper does not know is registered first from what the
   * command sends along (its folder and entry point), so Discord turned on mid-session still works.
   */
  private async send(req: Request): Promise<Record<string, unknown>> {
    this.requireOn();
    const sessionId = text(req.sessionId, "sessionId");
    const body = typeof req.text === "string" ? req.text : "";
    if (body.trim() === "") throw new RequestError("invalid", "There is nothing to send.");
    if (!(await this.adopt(sessionId, optionalText(req.entrypoint), optionalText(req.cwd)))) {
      throw new RequestError("not-linked", "This session has no Discord channel (only interactive sessions get one).");
    }
    const ping = req.ping === true;
    const done = req.done === true;
    const pieces = this.post(sessionId, body, { ping });
    this.sessions.update(sessionId, (e) => {
      e.lastSendAt = this.deps.clock.now();
      if (done) e.doneAt = this.deps.clock.now();
    });
    for (const listener of this.sendListeners) {
      try {
        listener({ sessionId, text: body, ping, done });
      } catch (error) {
        this.deps.log.warn(`a send listener failed: ${(error as Error).message}`);
      }
    }
    return { queued: pieces, online: this.gateway.state === "connected" };
  }
}

