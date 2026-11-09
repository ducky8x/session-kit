import { readTailLines } from "./names.ts";

/** The open item a held permission prompt or input dialog stands for: the latest one in the session. */
export function promptKey(sessionId: string): string {
  return `prompt:${sessionId}`;
}

/**
 * Did the session's transcript get a tool result at or after `since`? A permission prompt holds up the tool
 * that asked, so a result written after the prompt appeared means it was answered at the keyboard: allowed, and
 * the tool ran, or denied. Only the end of the transcript is read; false when the file can't be read.
 */
export async function toolResultSince(path: string, since: number): Promise<boolean> {
  const lines = (await readTailLines(path)) ?? [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"tool_result"')) continue;
    let record: { timestamp?: unknown; message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a torn line
    }
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    if (at < since) return false; // the lines before this one are older still
    const content = record.message?.content;
    if (Array.isArray(content) && content.some((b) => (b as { type?: unknown } | null)?.type === "tool_result")) return true;
  }
  return false;
}
