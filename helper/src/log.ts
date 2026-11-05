import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from "node:fs";
import { type Clock, realClock } from "./clock.ts";

/**
 * Where the helper writes what it is doing. Callers log routes, ids, codes and counts, never message text;
 * the file logger also blanks out anything shaped like a bot token.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** A logger that keeps lines in memory (for tests). */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => void lines.push(`info ${m}`),
    warn: (m) => void lines.push(`warn ${m}`),
    error: (m) => void lines.push(`error ${m}`),
  };
}

/** `helper.log` is rotated when it would grow past this; one old file, `helper.log.1`, is kept. */
export const LOG_MAX_BYTES = 1024 * 1024;
/** Longer entries are cut, so one runaway message cannot fill the log. */
const MAX_ENTRY = 600;
const TOKEN_SHAPE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g;
const REDACTED = "[redacted]";

export class FileLogger implements Logger {
  private readonly clock: Clock;
  private readonly maxBytes: number;
  private readonly secrets = new Set<string>();

  constructor(
    readonly file: string,
    opts: { clock?: Clock; maxBytes?: number } = {},
  ) {
    this.clock = opts.clock ?? realClock;
    this.maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  }

  /** Never write this value (the token, once it is read). */
  addSecret(secret: string): void {
    if (secret.length >= 8) this.secrets.add(secret);
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  private clean(message: string): string {
    let text = message.replace(/\s*[\r\n]+\s*/g, " ");
    for (const secret of this.secrets) text = text.split(secret).join(REDACTED);
    text = text.replace(TOKEN_SHAPE, REDACTED);
    return text.length > MAX_ENTRY ? `${text.slice(0, MAX_ENTRY)}…` : text;
  }

  private write(level: string, message: string): void {
    const line = `${new Date(this.clock.now()).toISOString()} ${level} ${this.clean(message)}\n`;
    try {
      const size = existsSync(this.file) ? statSync(this.file).size : 0;
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, line, { mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch {
      // A log that cannot be written must never stop the helper.
    }
  }
}
