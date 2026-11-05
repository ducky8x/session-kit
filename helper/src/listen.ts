import { type CallHelper, HelperError } from "./client.ts";
import { configExists, loadConfig } from "./config.ts";
import type { Paths } from "./paths.ts";

export const LISTEN_USAGE = "usage: sk-discord listen --session <id>";

/** Errors that mean the helper is gone (or went away while listening). */
const HELPER_GONE = new Set(["not-running", "closed", "connection", "protocol"]);

export interface ListenDeps {
  paths: Paths;
  out(text: string): void;
  err(text: string): void;
  call: CallHelper;
  signal?: AbortSignal;
}

/**
 * `sk-discord listen --session <id>`: wait for one event for the session, print it as one JSON line and exit 0.
 * With the helper not running it prints `{"type":"helper-down"}` and exits 2.
 */
export async function listenCommand(args: readonly string[], deps: ListenDeps): Promise<number> {
  let sessionId: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--session") sessionId = args[++i] ?? null;
    else if (arg.startsWith("--session=")) sessionId = arg.slice("--session=".length);
    else {
      deps.err(`Unknown argument ${arg}.\n${LISTEN_USAGE}\n`);
      return 1;
    }
  }
  if (!sessionId) {
    deps.err(`--session <id> is required.\n${LISTEN_USAGE}\n`);
    return 1;
  }
  if (!configExists(deps.paths) || !loadConfig(deps.paths).enabled) {
    deps.out(`${JSON.stringify({ type: "disabled" })}\n`);
    return 0;
  }
  try {
    const reply = await deps.call(deps.paths.socket, { op: "listen", sessionId }, deps.signal ? { signal: deps.signal } : {});
    deps.out(`${JSON.stringify(reply.event)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof HelperError && HELPER_GONE.has(error.code)) {
      deps.out(`${JSON.stringify({ type: "helper-down" })}\n`);
      return 2;
    }
    deps.err(`${(error as Error).message}\n`);
    return 1;
  }
}
