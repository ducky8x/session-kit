import { type CallHelper, HelperError, NOT_RUNNING } from "./client.ts";
import { configExists, loadConfig } from "./config.ts";
import type { Paths } from "./paths.ts";
import { HELPER_DOWN } from "./status.ts";

/** `sk-discord send` exit codes. */
export const SEND_EXIT = { ok: 0, error: 1, helperDown: 2, off: 3, notLinked: 4 } as const;
export const OFF_MESSAGE = "Discord is off (/discord on to turn it on)";
/** Registering an unknown session first can take a moment; the post itself is only queued. */
export const SEND_TIMEOUT_MS = 10_000;

export const SEND_USAGE = 'usage: sk-discord send --session <id> [--ping] [--done] "<text>"   ("-" reads the text from stdin)';

export interface SendArgs {
  sessionId: string;
  /** The text, or "-" for stdin. */
  text: string;
  ping: boolean;
  done: boolean;
}

/** Read `send`'s arguments. A string is an error message. */
export function parseSendArgs(args: readonly string[]): SendArgs | string {
  let sessionId: string | null = null;
  let ping = false;
  let done = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--ping") ping = true;
    else if (arg === "--done") done = true;
    else if (arg === "--session") sessionId = args[++i] ?? null;
    else if (arg.startsWith("--session=")) sessionId = arg.slice("--session=".length);
    else if (arg === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    else if (arg.startsWith("--")) return `Unknown option ${arg}.`;
    else words.push(arg);
  }
  if (!sessionId) return "--session <id> is required.";
  if (words.length !== 1) return "Give the text as one argument (quote it), or - to read it from stdin.";
  return { sessionId, text: words[0]!, ping, done };
}

export interface SendDeps {
  paths: Paths;
  env: Record<string, string | undefined>;
  cwd: string;
  readStdin(): Promise<string>;
  err(text: string): void;
  call: CallHelper;
}

/**
 * `sk-discord send --session <id> [--ping] [--done] "<text>"`: post in the session's channel.
 * Exit 0 posted or queued, 1 error, 2 helper not running, 3 Discord off, 4 session not linked.
 */
export async function sendCommand(args: readonly string[], deps: SendDeps): Promise<number> {
  const parsed = parseSendArgs(args);
  if (typeof parsed === "string") {
    deps.err(`${parsed}\n${SEND_USAGE}\n`);
    return SEND_EXIT.error;
  }
  if (!configExists(deps.paths) || !loadConfig(deps.paths).enabled) {
    deps.err(`${OFF_MESSAGE}\n`);
    return SEND_EXIT.off;
  }
  const text = parsed.text === "-" ? await deps.readStdin() : parsed.text;
  try {
    await deps.call(
      deps.paths.socket,
      {
        op: "send",
        sessionId: parsed.sessionId,
        text,
        ping: parsed.ping,
        done: parsed.done,
        cwd: deps.cwd,
        entrypoint: deps.env.CLAUDE_CODE_ENTRYPOINT ?? null,
      },
      { timeoutMs: SEND_TIMEOUT_MS },
    );
    return SEND_EXIT.ok;
  } catch (error) {
    const code = error instanceof HelperError ? error.code : "error";
    if (code === NOT_RUNNING) {
      deps.err(`${HELPER_DOWN}\n`);
      return SEND_EXIT.helperDown;
    }
    if (code === "off") {
      deps.err(`${OFF_MESSAGE}\n`);
      return SEND_EXIT.off;
    }
    deps.err(`${(error as Error).message}\n`);
    return code === "not-linked" ? SEND_EXIT.notLinked : SEND_EXIT.error;
  }
}
