import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Reply = Record<string, unknown> | null;

/**
 * Something listening on the helper's socket that records each request and answers with whatever the test
 * says (null: never answer). For testing the command-line side without a daemon.
 */
export class StubHelper {
  readonly requests: Record<string, unknown>[] = [];
  private listener: ReturnType<typeof Bun.listen> | null = null;

  constructor(public answer: (request: Record<string, unknown>) => Reply = () => ({ ok: true })) {}

  static start(socketPath: string, answer?: (request: Record<string, unknown>) => Reply): StubHelper {
    const stub = new StubHelper(answer);
    mkdirSync(dirname(socketPath), { recursive: true });
    let buffer = "";
    stub.listener = Bun.listen({
      unix: socketPath,
      socket: {
        data(socket, chunk) {
          buffer += chunk.toString();
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
          buffer = "";
          stub.requests.push(request);
          const reply = stub.answer(request);
          if (reply !== null) {
            socket.write(`${JSON.stringify(reply)}\n`);
            socket.end();
          }
        },
      },
    });
    return stub;
  }

  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }
}
