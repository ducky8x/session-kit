import { configExists, loadConfig } from "../config.ts";
import { parseHookInput } from "./input.ts";
import type { HookDeps } from "./session-start.ts";

export const STOP_TIMEOUT_MS = 2000;

/**
 * `sk-discord hook stop`: when Discord messages waited for this session and no listener is running, print
 * `{"decision":"block","reason":"Discord message(s) for this session: ..."}` so the session reads them
 * before it stops. Otherwise print nothing.
 */
export async function stopHook(deps: HookDeps): Promise<number> {
  const input = parseHookInput(await deps.readStdin());
  if (!input) return 1;
  if (!configExists(deps.paths) || !loadConfig(deps.paths).enabled) return 0;
  let reply: Record<string, unknown>;
  try {
    reply = await deps.call(deps.paths.socket, { op: "stop-hook", sessionId: input.session_id }, {
      timeoutMs: deps.timeoutMs ?? STOP_TIMEOUT_MS,
    });
  } catch {
    return 1;
  }
  if (reply.decision === "block" && typeof reply.reason === "string") {
    deps.out(`${JSON.stringify({ decision: "block", reason: reply.reason })}\n`);
  }
  return 0;
}
