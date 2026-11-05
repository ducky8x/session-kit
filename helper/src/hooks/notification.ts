import { configExists, loadConfig } from "../config.ts";
import { parseHookInput, stringField } from "./input.ts";
import type { HookDeps } from "./session-start.ts";

/** Notifications that mean the session is waiting on the owner: these post with an @mention. */
export const NEEDS_YOU = new Set(["permission_prompt", "elicitation_dialog"]);
export const NOTIFY_TIMEOUT_MS = 2000;

/**
 * `sk-discord hook notification`: post a permission prompt or an input dialog in the session's channel with
 * an @mention of the owner. Other notifications (idle, sign-in) post nothing. Prints nothing.
 */
export async function notificationHook(deps: HookDeps): Promise<number> {
  const input = parseHookInput(await deps.readStdin());
  if (!input) return 1;
  const type = stringField(input, "notification_type");
  const message = stringField(input, "message");
  if (type === null || !NEEDS_YOU.has(type) || message === null || message.trim() === "") return 0;
  if (!configExists(deps.paths) || !loadConfig(deps.paths).enabled) return 0;
  try {
    await deps.call(
      deps.paths.socket,
      {
        op: "send",
        sessionId: input.session_id,
        text: message,
        ping: true,
        cwd: stringField(input, "cwd") ?? "",
        entrypoint: deps.env.CLAUDE_CODE_ENTRYPOINT ?? null,
      },
      { timeoutMs: deps.timeoutMs ?? NOTIFY_TIMEOUT_MS },
    );
    return 0;
  } catch {
    return 1;
  }
}
