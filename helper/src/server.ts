import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { Socket } from "bun";
import type { Logger } from "./log.ts";
import { ensurePrivateDir } from "./state.ts";
import { dirname } from "node:path";

/** The longest request line accepted. */
const MAX_REQUEST = 1024 * 1024;

/** A request handler throws this to answer `{"ok":false,"error":code,"message":message}`. */
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Another helper already answers on the socket. */
export class AlreadyRunning extends Error {
  constructor(socketPath: string) {
    super(`another sk-discord daemon is already running (${socketPath})`);
  }
}

export type Request = { op: string } & Record<string, unknown>;
export type Reply = Record<string, unknown>;

export interface RequestContext {
  /** Run `cleanup` if the client disconnects before the reply (a `listen` that was stopped). */
  onClose(cleanup: () => void): void;
  /** The client has already gone. */
  readonly closed: boolean;
}

/** Answers one op. Returns the reply's fields (`ok: true` is added) or throws a RequestError. */
export type Handler = (request: Request, context: RequestContext) => Reply | Promise<Reply>;

/** The socket's ops, by name. New commands add theirs with `add`. */
export class HandlerRegistry {
  private readonly handlers = new Map<string, Handler>();

  add(op: string, handler: Handler): this {
    this.handlers.set(op, handler);
    return this;
  }

  get(op: string): Handler | undefined {
    return this.handlers.get(op);
  }

  ops(): string[] {
    return [...this.handlers.keys()].sort();
  }
}

interface Connection {
  buffer: string;
  started: boolean;
  closed: boolean;
  cleanups: (() => void)[];
  /** Reply bytes the socket has not taken yet. */
  pending: Uint8Array | null;
  endAfterFlush: boolean;
}

/** Is something answering on this socket? */
export async function socketAnswers(socketPath: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: socketPath, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * The control socket that hooks and commands use: a Unix socket only this user can open. Each connection
 * carries one newline-terminated JSON request and gets one JSON reply, then is closed. A handler may take as
 * long as it needs (a `listen` waits for an event); if the client leaves first, its cleanups run.
 */
export class ControlServer {
  private listener: ReturnType<typeof Bun.listen<Connection>> | null = null;
  private readonly sockets = new Set<Socket<Connection>>();

  constructor(
    readonly socketPath: string,
    private readonly registry: HandlerRegistry,
    private readonly log: Logger,
  ) {}

  async listen(): Promise<void> {
    ensurePrivateDir(dirname(this.socketPath));
    if (existsSync(this.socketPath)) {
      if (await socketAnswers(this.socketPath)) throw new AlreadyRunning(this.socketPath);
      unlinkSync(this.socketPath); // left behind by a crash
    }
    // Born user-only, so there is no moment when another account could connect.
    const oldMask = process.umask(0o177);
    try {
      this.listener = Bun.listen<Connection>({
        unix: this.socketPath,
        socket: {
          open: (socket) => {
            socket.data = { buffer: "", started: false, closed: false, cleanups: [], pending: null, endAfterFlush: false };
            this.sockets.add(socket);
          },
          data: (socket, chunk) => this.onData(socket, chunk),
          drain: (socket) => this.flush(socket),
          close: (socket) => this.onClose(socket),
          error: (socket) => this.onClose(socket),
        },
      });
    } finally {
      process.umask(oldMask);
    }
    chmodSync(this.socketPath, 0o600);
  }

  close(): void {
    for (const socket of this.sockets) {
      this.onClose(socket);
      socket.end();
    }
    this.sockets.clear();
    this.listener?.stop(true);
    this.listener = null;
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // already gone
      }
    }
  }

  private onClose(socket: Socket<Connection>): void {
    const conn = socket.data;
    this.sockets.delete(socket);
    if (!conn || conn.closed) return;
    conn.closed = true;
    for (const cleanup of conn.cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        this.log.warn(`a request cleanup failed: ${(error as Error).message}`);
      }
    }
  }

  private onData(socket: Socket<Connection>, chunk: Uint8Array): void {
    const conn = socket.data;
    if (conn.started) return; // one request per connection
    conn.buffer += Buffer.from(chunk).toString("utf8");
    if (conn.buffer.length > MAX_REQUEST) {
      socket.end();
      return;
    }
    const newline = conn.buffer.indexOf("\n");
    if (newline < 0) return;
    conn.started = true;
    const line = conn.buffer.slice(0, newline);
    conn.buffer = "";
    void this.answer(socket, line);
  }

  private async answer(socket: Socket<Connection>, line: string): Promise<void> {
    const conn = socket.data;
    let reply: Reply;
    try {
      const request = JSON.parse(line) as unknown;
      if (!request || typeof request !== "object" || Array.isArray(request) || typeof (request as Request).op !== "string") {
        throw new RequestError("invalid", "The request must be a JSON object with an op.");
      }
      const op = (request as Request).op;
      const handler = this.registry.get(op);
      if (!handler) throw new RequestError("unknown-op", `Unknown op "${op}".`);
      const context: RequestContext = {
        onClose: (cleanup) => {
          if (conn.closed) cleanup();
          else conn.cleanups.push(cleanup);
        },
        get closed() {
          return conn.closed;
        },
      };
      reply = { ok: true, ...(await handler(request as Request, context)) };
    } catch (error) {
      if (error instanceof RequestError) {
        reply = { ok: false, error: error.code, message: error.message };
      } else if (error instanceof SyntaxError) {
        reply = { ok: false, error: "invalid", message: "The request is not JSON." };
      } else {
        this.log.error(`a control request failed: ${(error as Error).message}`);
        reply = { ok: false, error: "internal", message: "Something went wrong inside the Discord helper." };
      }
    }
    if (conn.closed) return;
    conn.cleanups.length = 0;
    conn.pending = new TextEncoder().encode(`${JSON.stringify(reply)}\n`);
    conn.endAfterFlush = true;
    this.flush(socket);
  }

  private flush(socket: Socket<Connection>): void {
    const conn = socket.data;
    if (!conn.pending) return;
    const written = socket.write(conn.pending);
    conn.pending = written >= conn.pending.length ? null : conn.pending.subarray(Math.max(0, written));
    if (conn.pending === null && conn.endAfterFlush) socket.end();
  }
}
