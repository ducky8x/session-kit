/**
 * The command-line side of the control socket: one JSON request per connection, one JSON reply.
 * A reply `{"ok":false,"error":"<code>","message":"<text>"}` becomes a thrown HelperError with that code.
 */

/** Nothing is listening on the socket: the helper isn't running. */
export const NOT_RUNNING = "not-running";
/** The helper did not answer within the time the caller gave. */
export const TIMEOUT = "timeout";

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CallOptions {
  /** Give up after this long (real time). Without it, wait as long as the helper takes (`listen`). */
  timeoutMs?: number;
  /** Close the connection early (Ctrl-C). */
  signal?: AbortSignal;
}

export type HelperRequest = { op: string } & Record<string, unknown>;
export type HelperReply = { ok: true } & Record<string, any>;

export type CallHelper = (socketPath: string, request: HelperRequest, opts?: CallOptions) => Promise<HelperReply>;

export const callHelper: CallHelper = (socketPath, request, opts = {}) =>
  new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let buffer = "";
    let settled = false;
    let socket: { end(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        socket?.end();
      } catch {
        // already closed
      }
      action();
    };

    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(() => reject(new HelperError(TIMEOUT, "The Discord helper did not answer in time."))),
        opts.timeoutMs,
      );
    }
    opts.signal?.addEventListener("abort", () => finish(() => reject(new HelperError("aborted", "Stopped."))));

    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          socket = s;
          if (settled) s.end();
          else s.write(`${JSON.stringify(request)}\n`);
        },
        data(_s, chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          let reply: Record<string, unknown>;
          try {
            reply = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
          } catch {
            finish(() => reject(new HelperError("protocol", "The Discord helper sent something unreadable.")));
            return;
          }
          if (reply.ok === true) finish(() => resolve(reply as HelperReply));
          else {
            const code = typeof reply.error === "string" ? reply.error : "error";
            const message = typeof reply.message === "string" ? reply.message : "The request failed.";
            finish(() => reject(new HelperError(code, message)));
          }
        },
        close() {
          finish(() => reject(new HelperError("closed", "The Discord helper closed the connection without an answer.")));
        },
        error(_s, error) {
          finish(() => reject(new HelperError("connection", error.message)));
        },
      },
    }).catch(() => finish(() => reject(new HelperError(NOT_RUNNING, "The Discord helper isn't running."))));
  });
