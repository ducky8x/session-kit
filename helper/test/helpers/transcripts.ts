import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./tmp.ts";

/**
 * Synthetic transcripts in a temp folder, shaped like the lines Claude Code writes. Only the record types the
 * helper reads matter; the conversation lines carry placeholder text.
 */
export function transcripts() {
  const dir = tmpDir("t");
  const pathOf = (sessionId: string) => join(dir, `${sessionId}.jsonl`);
  const write = (sessionId: string, records: Record<string, unknown>[]) => {
    appendFileSync(pathOf(sessionId), records.map((r) => `${JSON.stringify({ ...r, sessionId })}\n`).join(""));
  };
  return {
    dir,
    pathOf,
    /** A short chat: one prompt and one answer. */
    chat(sessionId: string): string {
      writeFileSync(pathOf(sessionId), "");
      return this.turn(sessionId);
    },
    /** One more prompt and answer at the end of the transcript. */
    turn(sessionId: string): string {
      write(sessionId, [
        { type: "user", message: { role: "user", content: "placeholder prompt" } },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "placeholder answer" }] } },
      ]);
      return pathOf(sessionId);
    },
    /** What Claude Code appends when the chat moves to a background session with a new id. */
    continuedIn(sessionId: string, next: string): void {
      write(sessionId, [
        { type: "attachment", attachment: { type: "session_cron_carry", tasks: [] } },
        { type: "continued-in", timestamp: new Date(0).toISOString(), continuedInSessionId: next },
        { type: "last-prompt", lastPrompt: "placeholder prompt" },
      ]);
    },
  };
}
