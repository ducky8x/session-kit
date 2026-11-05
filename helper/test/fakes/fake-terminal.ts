import { EventEmitter } from "node:events";
import type { SecretInput, SecretStreams } from "../../src/tty.ts";

/**
 * A terminal for `readSecret`: `type` delivers chunks the way a real terminal would (one `data` event each),
 * and everything written to stderr is kept. Nothing touches the real stdin or stderr.
 */
export class FakeTerminal implements SecretInput {
  readonly isTTY: boolean;
  /** Every `setRawMode` call, in order. */
  readonly rawModes: boolean[] = [];
  encoding: string | null = null;
  paused = true;
  stderrText = "";
  private readonly events = new EventEmitter();
  /** What `readAll` returns when stdin is a pipe. */
  private readonly piped: string;

  constructor(o: { isTTY?: boolean; piped?: string } = {}) {
    this.isTTY = o.isTTY ?? true;
    this.piped = o.piped ?? "";
  }

  get streams(): SecretStreams {
    return {
      stdin: this,
      stderr: { write: (text: string) => void (this.stderrText += text) },
      readAll: async () => this.piped,
    };
  }

  /** Whether `readSecret` is still listening. */
  get listening(): boolean {
    return this.events.listenerCount("data") > 0;
  }

  /** Deliver each chunk as its own `data` event. */
  type(...chunks: string[]): void {
    for (const chunk of chunks) this.events.emit("data", chunk);
  }

  setRawMode(on: boolean): void {
    this.rawModes.push(on);
  }

  setEncoding(encoding: "utf8"): void {
    this.encoding = encoding;
  }

  resume(): void {
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
  }

  on(event: "data", listener: (chunk: string) => void): void {
    this.events.on(event, listener);
  }

  off(event: "data", listener: (chunk: string) => void): void {
    this.events.off(event, listener);
  }
}
