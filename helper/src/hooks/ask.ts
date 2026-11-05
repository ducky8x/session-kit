import { configExists, loadConfig } from "../config.ts";
import { classifyAskResponse, readAskItems, typedByUser } from "../questions.ts";
import { parseHookInput, stringField } from "./input.ts";
import type { HookDeps } from "./session-start.ts";

export const ASK_TIMEOUT_MS = 2000;
/** The prompt hook holds up every prompt the user sends, so it waits less. */
export const PROMPT_TIMEOUT_MS = 1000;

function discordOn(deps: HookDeps): boolean {
  return configExists(deps.paths) && loadConfig(deps.paths).enabled;
}

/**
 * `sk-discord hook pre-ask` (PreToolUse on AskUserQuestion): record the questions, so they go to Discord if
 * nobody answers at the keyboard within 2 minutes. Prints nothing.
 */
export async function preAskHook(deps: HookDeps): Promise<number> {
  const input = parseHookInput(await deps.readStdin());
  if (!input) return 1;
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const questions = readAskItems(toolInput?.questions);
  if (questions === null || !discordOn(deps)) return 0;
  try {
    await deps.call(
      deps.paths.socket,
      {
        op: "ask",
        sessionId: input.session_id,
        toolUseId: stringField(input, "tool_use_id"),
        questions,
        cwd: stringField(input, "cwd"),
        transcriptPath: stringField(input, "transcript_path"),
        entrypoint: deps.env.CLAUDE_CODE_ENTRYPOINT ?? null,
      },
      { timeoutMs: deps.timeoutMs ?? ASK_TIMEOUT_MS },
    );
    return 0;
  } catch {
    return 1;
  }
}

/**
 * `sk-discord hook post-ask` (PostToolUse on AskUserQuestion): the dialog closed. When the user answered, the
 * question is closed (and its Discord post, if any, says so). When the auto-continue timeout closed it
 * unanswered, the question stays open and still goes to Discord. Prints nothing.
 */
export async function postAskHook(deps: HookDeps): Promise<number> {
  const input = parseHookInput(await deps.readStdin());
  if (!input) return 1;
  if (!discordOn(deps) || classifyAskResponse(input.tool_response) === "unanswered") return 0;
  try {
    await deps.call(
      deps.paths.socket,
      { op: "answer", sessionId: input.session_id, toolUseId: stringField(input, "tool_use_id"), source: "keyboard" },
      { timeoutMs: deps.timeoutMs ?? ASK_TIMEOUT_MS },
    );
    return 0;
  } catch {
    return 1;
  }
}

/**
 * `sk-discord hook prompt` (UserPromptSubmit): a prompt the user typed means they are at the keyboard, so the
 * session's open question is settled there and never posted, or, when it already went out, gets no reminder
 * and no autonomous step. It is the only hook that runs after the dialog is closed with Esc or "clarify":
 * Claude Code denies the tool then, so PostToolUse doesn't run. Prompts the user didn't type are ignored.
 * Prints nothing, since what this hook prints would be added to the prompt.
 */
export async function promptHook(deps: HookDeps): Promise<number> {
  const input = parseHookInput(await deps.readStdin());
  if (!input) return 1;
  const prompt = stringField(input, "prompt");
  if (prompt === null || !typedByUser(prompt) || !discordOn(deps)) return 0;
  try {
    await deps.call(deps.paths.socket, { op: "present", sessionId: input.session_id }, { timeoutMs: deps.timeoutMs ?? PROMPT_TIMEOUT_MS });
    return 0;
  } catch {
    return 1;
  }
}
