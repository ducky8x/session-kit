import { configExists, loadConfig } from "../config.ts";
import type { HookDeps } from "./session-start.ts";
import { parseHookInput, stringField } from "./input.ts";

/**
 * SessionEnd hooks share a 1.5-second budget, so this waits at most half a second for the helper, which
 * records the time and answers without talking to Discord.
 */
export const ENDED_TIMEOUT_MS = 500;

/** `sk-discord hook session-end`: tell the helper the session closed. Always exits 0 and prints nothing. */
export async function sessionEndHook(deps: HookDeps): Promise<number> {
  const input = parseHookInput(await deps.readStdin());
  if (!input || !configExists(deps.paths) || !loadConfig(deps.paths).enabled) return 0;
  try {
    await deps.call(
      deps.paths.socket,
      { op: "ended", sessionId: input.session_id, reason: stringField(input, "reason") },
      { timeoutMs: deps.timeoutMs ?? ENDED_TIMEOUT_MS },
    );
  } catch {
    // The helper isn't running or is slow: the sweep still ages the channel out.
  }
  return 0;
}
