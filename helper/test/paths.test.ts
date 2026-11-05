import { describe, expect, test } from "bun:test";
import { pathsFor } from "../src/paths.ts";

describe("pathsFor", () => {
  test("keeps everything under ~/.claude/session-kit", () => {
    const p = pathsFor("/home/someone");
    expect(p.dir).toBe("/home/someone/.claude/session-kit/discord");
    expect(p.config).toBe("/home/someone/.claude/session-kit/discord/config.json");
    expect(p.sessions).toBe("/home/someone/.claude/session-kit/discord/sessions.json");
    expect(p.outbox).toBe("/home/someone/.claude/session-kit/discord/outbox.jsonl");
    expect(p.log).toBe("/home/someone/.claude/session-kit/discord/helper.log");
    expect(p.socket).toBe("/home/someone/.claude/session-kit/discord/helper.sock");
    expect(p.bin).toBe("/home/someone/.claude/session-kit/bin/sk-discord");
  });
});
