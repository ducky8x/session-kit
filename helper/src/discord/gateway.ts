import { backoffMs } from "../backoff.ts";
import type { Clock, TimerHandle } from "../clock.ts";
import type { Logger } from "../log.ts";

export const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** GUILDS (1), GUILD_MESSAGES (512) and MESSAGE_CONTENT (32768, a privileged intent). */
export const INTENTS = 1 | 512 | 32768;

/**
 * Where the connection stands. `token-rejected` (close code 4004) and `intent-missing` (4014) stop the client
 * until `start` is called again; `stopped` is a deliberate stop.
 */
export type GatewayState = "idle" | "connecting" | "connected" | "token-rejected" | "intent-missing" | "stopped";

export interface GatewayOptions {
  token: () => string | null;
  url?: string;
  clock: Clock;
  log: Logger;
  random?: () => number;
  WebSocket?: typeof WebSocket;
  /** Every event (op 0), READY and RESUMED included. */
  onDispatch(type: string, data: any): void;
  onStateChange?(state: GatewayState): void;
}

interface Payload {
  op: number;
  d?: any;
  s?: number | null;
  t?: string | null;
}

const OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const;

/** `resume_gateway_url` comes without the version and encoding; they are added here. */
function withGatewayQuery(base: string): string {
  try {
    const url = new URL(base);
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");
    return url.toString();
  } catch {
    return GATEWAY_URL;
  }
}

/** Close codes after which a session cannot be resumed, only identified afresh. */
const FRESH_START_CODES = new Set([4007, 4009]);
/** The code the client closes with when it means to resume (1000 and 1001 would end the session). */
const CLOSE_TO_RESUME = 4000;

/**
 * The bot's one gateway connection. It identifies, keeps the heartbeat, resumes after a drop, an op 7 or a
 * missed ACK, identifies again after an op 9, and backs off 1, 2, 4 ... 60 seconds between failed attempts.
 */
export class GatewayClient {
  private ws: WebSocket | null = null;
  private _state: GatewayState = "idle";
  private active = false;
  private _sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private seq: number | null = null;
  private resuming = false;
  private interval = 0;
  private acked = true;
  private failures = 0;
  private heartbeatTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private identifyTimer: TimerHandle | null = null;
  private readonly url: string;
  private readonly random: () => number;
  private readonly WS: typeof WebSocket;

  constructor(private readonly o: GatewayOptions) {
    this.url = o.url ?? GATEWAY_URL;
    this.random = o.random ?? Math.random;
    this.WS = o.WebSocket ?? WebSocket;
  }

  get state(): GatewayState {
    return this._state;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Connect (again). Safe to call while running. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.failures = 0;
    this.connect();
  }

  stop(): void {
    this.halt("stopped");
  }

  private setState(state: GatewayState): void {
    if (state === this._state) return;
    this._state = state;
    this.o.onStateChange?.(state);
  }

  private clearTimers(): void {
    for (const t of [this.heartbeatTimer, this.reconnectTimer, this.identifyTimer]) {
      if (t !== null) this.o.clock.clearTimeout(t);
    }
    this.heartbeatTimer = this.reconnectTimer = this.identifyTimer = null;
  }

  /** Stop for good (until `start`), in the given state. */
  private halt(state: GatewayState): void {
    this.active = false;
    this.clearTimers();
    this.closeSocket(1000);
    this.setState(state);
  }

  private closeSocket(code: number): void {
    const ws = this.ws;
    this.ws = null; // its close event is ignored from here on
    if (!ws) return;
    try {
      ws.close(code);
    } catch {
      // already closed
    }
  }

  private connect(): void {
    this.clearTimers();
    const resume = this._sessionId !== null && this.seq !== null;
    this.resuming = resume;
    const url = resume && this.resumeUrl ? withGatewayQuery(this.resumeUrl) : this.url;
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new this.WS(url);
    } catch (error) {
      this.o.log.warn(`gateway connect failed: ${(error as Error).message}`);
      this.retryLater();
      return;
    }
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      if (this.ws === ws) this.onMessage(String((event as MessageEvent).data));
    });
    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClose((event as CloseEvent).code);
    });
  }

  private send(payload: Payload): void {
    const ws = this.ws;
    if (ws && ws.readyState === this.WS.OPEN) ws.send(JSON.stringify(payload));
  }

  private onMessage(raw: string): void {
    let p: Payload;
    try {
      p = JSON.parse(raw) as Payload;
    } catch {
      return;
    }
    switch (p.op) {
      case OP.hello:
        return this.onHello(p.d);
      case OP.heartbeatAck:
        this.acked = true;
        return;
      case OP.heartbeat:
        this.send({ op: OP.heartbeat, d: this.seq });
        return;
      case OP.dispatch:
        return this.onDispatch(p);
      case OP.reconnect:
        this.o.log.info("gateway asked for a reconnect");
        return this.reconnectNow();
      case OP.invalidSession:
        return this.onInvalidSession(p.d === true);
    }
  }

  private onHello(d: any): void {
    const interval = typeof d?.heartbeat_interval === "number" ? d.heartbeat_interval : 41_250;
    this.interval = interval;
    this.acked = true;
    this.heartbeatTimer = this.o.clock.setTimeout(() => this.beat(), interval * this.random());
    if (this.resuming && this._sessionId !== null && this.seq !== null) {
      this.send({ op: OP.resume, d: { token: this.o.token() ?? "", session_id: this._sessionId, seq: this.seq } });
    } else {
      this.identify();
    }
  }

  private identify(): void {
    this.send({
      op: OP.identify,
      d: {
        token: this.o.token() ?? "",
        intents: INTENTS,
        properties: { os: process.platform, browser: "sk-discord", device: "sk-discord" },
      },
    });
  }

  private beat(): void {
    this.heartbeatTimer = null;
    if (!this.acked) {
      this.o.log.warn("no heartbeat ACK; reconnecting");
      this.reconnectNow();
      return;
    }
    this.acked = false;
    this.send({ op: OP.heartbeat, d: this.seq });
    this.heartbeatTimer = this.o.clock.setTimeout(() => this.beat(), this.interval);
  }

  private onDispatch(p: Payload): void {
    if (typeof p.s === "number") this.seq = p.s;
    const type = p.t ?? "";
    if (type === "READY") {
      this._sessionId = typeof p.d?.session_id === "string" ? p.d.session_id : null;
      this.resumeUrl = typeof p.d?.resume_gateway_url === "string" ? p.d.resume_gateway_url : null;
      this.failures = 0;
      this.setState("connected");
    } else if (type === "RESUMED") {
      this.failures = 0;
      this.setState("connected");
    }
    this.o.onDispatch(type, p.d);
  }

  private onInvalidSession(resumable: boolean): void {
    if (resumable) {
      this.reconnectNow();
      return;
    }
    this.o.log.info("gateway session is no longer valid; identifying again");
    this._sessionId = null;
    this.seq = null;
    this.resuming = false;
    const wait = 1000 + this.random() * 4000;
    this.identifyTimer = this.o.clock.setTimeout(() => {
      this.identifyTimer = null;
      if (this.ws && this.ws.readyState === this.WS.OPEN) this.identify();
      else this.connect();
    }, wait);
  }

  /** Close the socket (keeping the session) and connect again right away. */
  private reconnectNow(): void {
    this.closeSocket(CLOSE_TO_RESUME);
    this.connect();
  }

  private onClose(code: number): void {
    this.clearTimers();
    if (!this.active) return;
    if (code === 4004) {
      this.o.log.error("gateway closed with 4004: the bot token was rejected");
      this.halt("token-rejected");
      return;
    }
    if (code === 4014 || code === 4013) {
      this.o.log.error(`gateway closed with ${code}: the Message Content intent is not allowed`);
      this.halt("intent-missing");
      return;
    }
    if (FRESH_START_CODES.has(code)) {
      this._sessionId = null;
      this.seq = null;
    }
    this.o.log.info(`gateway closed (${code}); reconnecting`);
    this.retryLater();
  }

  private retryLater(): void {
    this.setState("connecting");
    const wait = backoffMs(this.failures++);
    this.reconnectTimer = this.o.clock.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) this.connect();
    }, wait);
  }
}
