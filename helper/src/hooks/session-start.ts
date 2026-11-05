import { surfaceFor } from "../channels.ts";
import { type CallHelper, HelperError, NOT_RUNNING } from "../client.ts";
import { configExists, loadConfig } from "../config.ts";
import type { Paths } from "../paths.ts";
import { HELPER_DOWN, SETUP_NEEDED, STATUS_PROBLEMS, type StatusCode } from "../status.ts";
import { parseHookInput, stringField } from "./input.ts";

/** How long the hook waits for the helper to register the session. */
export const REGISTER_TIMEOUT_MS = 2000;

export const NOT_OFFERED =
  'Discord: not offered yet. Add the question "Set up Discord now?" to the startup questions (session-kit:start skill).';
export const LISTENER_HINT = "Start it as a background command now, and again after every event (session-kit:discord skill).";

/** The listener command, written with `~` so it reads the same on every machine. */
export function listenerCommand(sessionId: string): string {
  return `~/.claude/session-kit/bin/sk-discord listen --session ${sessionId}`;
}

export interface HookDeps {
  paths: Paths;
  env: Record<string, string | undefined>;
  platform: string;
  readStdin(): Promise<string>;
  out(text: string): void;
  call: CallHelper;
  /** Tests shorten the socket wait. */
  timeoutMs?: number;
}

/**
 * `sk-discord hook session-start`: register the session with the helper and print the lines the session
 * reads (its channel, the listener command). Exits 0 with nothing printed when Discord is off or the session
 * isn't interactive, and non-zero (printing nothing) when something fails.
 */
export async function sessionStartHook(deps: HookDeps): Promise<number> {
  const input = parseHookInput(await deps.readStdin());
  if (!input) return 1;
  const source = stringField(input, "source");
  if (source === "compact") return 0;

  if (!configExists(deps.paths)) {
    const fresh = source === null || source === "startup" || source === "clear";
    if (deps.platform === "darwin" && fresh) deps.out(`${NOT_OFFERED}\n`);
    return 0;
  }
  if (!loadConfig(deps.paths).enabled) return 0;
  const entrypoint = deps.env.CLAUDE_CODE_ENTRYPOINT;
  if (surfaceFor(entrypoint) === null) return 0;

  const sessionId = input.session_id;
  let reply: Record<string, any>;
  try {
    reply = await deps.call(
      deps.paths.socket,
      {
        op: "register",
        sessionId,
        source: source ?? "startup",
        cwd: stringField(input, "cwd") ?? "",
        transcriptPath: stringField(input, "transcript_path"),
        entrypoint: entrypoint ?? null,
      },
      { timeoutMs: deps.timeoutMs ?? REGISTER_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof HelperError && error.code === NOT_RUNNING) {
      deps.out(`${HELPER_DOWN}\n`);
      return 0;
    }
    return 1;
  }
  if (reply.registered !== true) return 0;

  const status = reply.status as StatusCode | undefined;
  if (status !== undefined && SETUP_NEEDED.has(status)) {
    // The helper says whether this session has already been told.
    if (reply.notice === true) {
      const problem = STATUS_PROBLEMS[status]!;
      deps.out(
        `Discord is on but not set up: ${problem.problem} (fix: ${problem.fix}). Run the Discord setup (session-kit:discord skill) before anything else.\n`,
      );
    }
    return 0;
  }

  const where = reply.pending === true || typeof reply.category !== "string" ? "being created" : reply.category;
  deps.out(`Discord: #${reply.channelName} (${where})\n`);
  deps.out(`Discord listener: ${listenerCommand(sessionId)}\n`);
  deps.out(`${LISTENER_HINT}\n`);
  return 0;
}
