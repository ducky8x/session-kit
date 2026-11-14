import { type CallHelper, HelperError } from "./client.ts";
import type { Clock } from "./clock.ts";
import { configExists, loadConfig } from "./config.ts";
import type { Paths } from "./paths.ts";

export const LISTEN_USAGE = "usage: sk-discord listen --session <id>";

/** Errors that mean the helper is gone (or went away while listening). */
const HELPER_GONE = new Set(["not-running", "closed", "connection", "protocol"]);

/** How long the helper may stay out of reach before `listen` reports `helper-down`: long enough for a restart. */
export const LISTEN_GRACE_MS = 180_000;
/** How long `listen` waits between tries while the helper is out of reach. */
export const LISTEN_RETRY_MS = 2_000;

export interface ListenDeps {
  paths: Paths;
  out(text: string): void;
  err(text: string): void;
  call: CallHelper;
  /** Times the outage and the waits between tries. */
  clock: Clock;
  signal?: AbortSignal;
  /** Tests shorten these. */
  graceMs?: number;
  retryMs?: number;
}

/** Wait `ms` on the clock. False when `signal` fired first. */
function pause(clock: Clock, ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clock.clearTimeout(timer);
      resolve(false);
    };
    const timer = clock.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `sk-discord listen --session <id>`: wait for one event for the session, print it as one JSON line and exit 0.
 * When the helper can't be reached, or goes away while this waits (it restarted), keep trying the same `listen`
 * until the helper is back; the helper keeps what arrived meanwhile in the session's inbox. Only when it stays
 * out of reach for the whole grace period does this print `{"type":"helper-down"}` and exit 2.
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
  const { clock, signal } = deps;
  const graceMs = deps.graceMs ?? LISTEN_GRACE_MS;
  const retryMs = deps.retryMs ?? LISTEN_RETRY_MS;
  const stopped = () => {
    deps.err("Stopped.\n");
    return 1;
  };
  /** When the helper was first out of reach in this outage, or null while there is none. */
  let downSince: number | null = null;
  for (;;) {
    if (signal?.aborted) return stopped();
    const triedAt = clock.now();
    try {
      const reply = await deps.call(deps.paths.socket, { op: "listen", sessionId }, signal ? { signal } : {});
      deps.out(`${JSON.stringify(reply.event)}\n`);
      return 0;
    } catch (error) {
      if (!(error instanceof HelperError && HELPER_GONE.has(error.code))) {
        deps.err(`${(error as Error).message}\n`);
        return 1;
      }
    }
    const now = clock.now();
    // A connection that held for a whole grace period means the helper was back, so this is a new outage. One
    // that drops sooner (a helper that keeps failing soon after it starts) counts toward the outage under way.
    if (downSince === null || now - triedAt >= graceMs) downSince = now;
    const left = downSince + graceMs - now;
    if (left <= 0) {
      deps.out(`${JSON.stringify({ type: "helper-down" })}\n`);
      return 2;
    }
    if (!(await pause(clock, Math.min(retryMs, left), signal))) return stopped();
  }
}
