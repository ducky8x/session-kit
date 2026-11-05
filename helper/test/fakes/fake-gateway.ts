import type { ServerWebSocket } from "bun";
import { BOT_ID, GUILD_ID } from "./fake-rest.ts";

/**
 * A Discord gateway on a loopback port. It says HELLO, answers IDENTIFY with READY, RESUME with RESUMED and
 * heartbeats with ACKs, and lets a test send events, close connections with a code, or drop them.
 */

export interface Frame {
  op: number;
  d?: any;
  s?: number | null;
  t?: string | null;
}

interface ConnData {
  id: number;
  path: string;
}

export class FakeConnection {
  readonly received: Frame[] = [];
  closed = false;
  closeCode: number | null = null;

  constructor(
    readonly id: number,
    readonly path: string,
    readonly socket: ServerWebSocket<ConnData>,
  ) {}

  send(frame: Frame): void {
    if (!this.closed) this.socket.send(JSON.stringify(frame));
  }

  ops(op: number): Frame[] {
    return this.received.filter((f) => f.op === op);
  }
}

export class FakeGateway {
  readonly connections: FakeConnection[] = [];
  heartbeatInterval = 41_250;
  sessionId = "fake-session-1";
  seq = 0;
  /** Send HELLO as soon as a client connects. */
  autoHello = true;
  /** Answer heartbeats with ACKs. */
  ackHeartbeats = true;
  /** Close every new connection at once with this code, before HELLO (a gateway that keeps failing). */
  closeOnOpen: number | null = null;
  /** Close with this code when the client identifies (4004 bad token, 4014 intents not allowed). */
  closeOnIdentify: number | null = null;
  /** Answer RESUME with INVALID_SESSION (d = false) instead of RESUMED. */
  refuseResume = false;
  /** The guilds READY lists. */
  readyGuilds: { id: string; unavailable: boolean }[] = [{ id: GUILD_ID, unavailable: true }];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private nextId = 1;
  private identities = 0;

  static async start(): Promise<FakeGateway> {
    const fake = new FakeGateway();
    fake.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, server) => {
        const path = new URL(req.url).pathname;
        if (server.upgrade(req, { data: { id: fake.nextId++, path } })) return undefined;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        data: {} as ConnData,
        open: (ws) => fake.onOpen(ws),
        message: (ws, message) => fake.onMessage(ws, String(message)),
        close: (ws, code) => {
          const conn = fake.find(ws);
          if (conn) {
            conn.closed = true;
            conn.closeCode ??= code;
          }
        },
      },
    });
    return fake;
  }

  /** The URL a client starts with. */
  get url(): string {
    return `ws://127.0.0.1:${this.server!.port}/?v=10&encoding=json`;
  }

  /** What READY gives as `resume_gateway_url` (no query, as Discord sends it). */
  get resumeUrl(): string {
    return `ws://127.0.0.1:${this.server!.port}/resume`;
  }

  get latest(): FakeConnection | undefined {
    return this.connections.at(-1);
  }

  get open(): FakeConnection[] {
    return this.connections.filter((c) => !c.closed);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /** Send an event to the newest open connection. */
  dispatch(t: string, d: unknown): number {
    const conn = this.open.at(-1);
    if (!conn) throw new Error("no open connection");
    const s = ++this.seq;
    conn.send({ op: 0, t, s, d });
    return s;
  }

  sendOp(op: number, d: unknown = null): void {
    this.open.at(-1)?.send({ op, d, s: null, t: null });
  }

  hello(conn: FakeConnection | undefined = this.latest): void {
    conn?.send({ op: 10, d: { heartbeat_interval: this.heartbeatInterval } });
  }

  /** Close the newest connection with a close frame. */
  closeLatest(code: number, reason = ""): void {
    const conn = this.open.at(-1);
    if (!conn) return;
    conn.closeCode = code;
    conn.socket.close(code, reason);
  }

  /** Cut the newest connection with no close frame, like a network drop. */
  dropLatest(): void {
    const conn = this.open.at(-1);
    if (!conn) return;
    conn.socket.terminate();
  }

  private find(ws: ServerWebSocket<ConnData>): FakeConnection | undefined {
    return this.connections.find((c) => c.id === ws.data.id);
  }

  private onOpen(ws: ServerWebSocket<ConnData>): void {
    const conn = new FakeConnection(ws.data.id, ws.data.path, ws);
    this.connections.push(conn);
    if (this.closeOnOpen !== null) {
      conn.closeCode = this.closeOnOpen;
      ws.close(this.closeOnOpen, "closing");
      return;
    }
    if (this.autoHello) this.hello(conn);
  }

  private onMessage(ws: ServerWebSocket<ConnData>, text: string): void {
    const conn = this.find(ws);
    if (!conn) return;
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      return;
    }
    conn.received.push(frame);
    switch (frame.op) {
      case 1:
        if (this.ackHeartbeats) conn.send({ op: 11 });
        return;
      case 2: {
        if (this.closeOnIdentify !== null) {
          conn.closeCode = this.closeOnIdentify;
          ws.close(this.closeOnIdentify, "refused");
          return;
        }
        this.identities++;
        this.sessionId = `fake-session-${this.identities}`;
        this.seq = 0;
        const s = ++this.seq;
        conn.send({
          op: 0,
          t: "READY",
          s,
          d: {
            v: 10,
            session_id: this.sessionId,
            resume_gateway_url: this.resumeUrl,
            user: { id: BOT_ID, username: "session-kit", bot: true },
            guilds: this.readyGuilds,
          },
        });
        return;
      }
      case 6: {
        if (this.refuseResume || frame.d?.session_id !== this.sessionId) {
          conn.send({ op: 9, d: false });
          return;
        }
        const s = ++this.seq;
        conn.send({ op: 0, t: "RESUMED", s, d: {} });
        return;
      }
    }
  }
}
