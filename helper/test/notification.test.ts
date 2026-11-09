import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { SID, daemonKit } from "./helpers/daemon-kit.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { waitFor } from "./helpers/wait.ts";

const MINUTE = 60_000;

function hookInput(type: string, message = "Claude needs your permission to use Bash", transcriptPath?: string) {
  return JSON.stringify({
    session_id: SID,
    cwd: "/work/session-kit",
    hook_event_name: "Notification",
    message,
    notification_type: type,
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
  });
}

/** A transcript line holding a tool's result, written at `at`. Made up, in the shape Claude Code writes. */
function toolResultLine(at: number, toolUseId = "toolu_02"): string {
  const block = { type: "tool_result", tool_use_id: toolUseId, content: "ok" };
  return JSON.stringify({ type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: [block] } });
}

async function withChannel() {
  const k = await daemonKit();
  await k.connected();
  await k.startChat(SID);
  const channelId = k.daemon.sessions.get(SID)!.channelId!;
  const sent = () => k.rest.posted(channelId).map((m) => m.content);
  const pass = async (ms: number) => {
    await k.clock.advance(ms);
    await k.daemon.settle();
  };
  return { ...k, channelId, sent, pass };
}

describe("hook notification", () => {
  test("permission_prompt and elicitation_dialog post their message, mentioning nobody", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    for (const [type, message] of [
      ["permission_prompt", "Claude needs your permission to use Bash"],
      ["elicitation_dialog", "Claude is asking for input"],
    ] as const) {
      const r = await k.cli(["hook", "notification"], { stdin: hookInput(type, message) });
      expect(r).toEqual({ code: 0, out: "", err: "" });
    }
    await waitFor(() => k.rest.posted(channelId).length === 2);
    expect(k.rest.posted(channelId).map((m) => [m.content, m.allowed_mentions])).toEqual([
      ["Claude needs your permission to use Bash", { parse: [] }],
      ["Claude is asking for input", { parse: [] }],
    ]);
  });

  test("a permission prompt in a session with no channel yet makes the channel and posts there", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    expect(await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt") })).toEqual({ code: 0, out: "", err: "" });
    await waitFor(() => k.daemon.sessions.get(SID)?.channelId != null);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    await waitFor(() => k.rest.posted(channelId).length === 1);
    expect(k.rest.posted(channelId)[0]!.content).toBe("Claude needs your permission to use Bash");
  });

  test("idle_prompt and auth_success post nothing", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    for (const type of ["idle_prompt", "auth_success"]) {
      const r = await k.cli(["hook", "notification"], { stdin: hookInput(type, "Claude is waiting for your input") });
      expect(r).toEqual({ code: 0, out: "", err: "" });
    }
    await k.daemon.settle();
    expect(k.rest.posted()).toHaveLength(0);
    expect(k.daemon.outbox.size).toBe(0);
  });

  test("with Discord off it posts nothing and exits 0", async () => {
    const k = await daemonKit({ enabled: false });
    const r = await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt") });
    expect(r).toEqual({ code: 0, out: "", err: "" });
    expect(k.daemon.outbox.size).toBe(0);
  });

  test("with the helper down it prints nothing", async () => {
    const k = await daemonKit({ noStart: true });
    const r = await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt") });
    expect(r.out).toBe("");
    expect(r.err).toBe("");
  });
});

describe("a permission prompt while the user is at the computer", () => {
  test("waits, isn't dropped for using the computer, and goes out the first time the user is away", async () => {
    const k = await withChannel();
    k.idle.touch();
    expect(await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt") })).toEqual({ code: 0, out: "", err: "" });
    for (let i = 0; i < 10; i++) {
      await k.pass(MINUTE);
      k.idle.touch();
    }
    expect(k.sent()).toEqual([]);
    expect(k.daemon.outbox.heldCount).toBe(1);
    await k.pass(5 * MINUTE);
    expect(k.sent()).toEqual(["Claude needs your permission to use Bash"]);
  });

  test("a typed prompt, the end of the turn, a new question, the session's own post or its end settles it", async () => {
    const questions = [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }];
    const settlers: [string, (k: Awaited<ReturnType<typeof withChannel>>) => Promise<unknown>][] = [
      ["a typed prompt", (k) => k.cli(["hook", "prompt"], { stdin: JSON.stringify({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "go on" }) })],
      ["the end of the turn", (k) => k.call({ op: "stop-hook", sessionId: SID })],
      ["a new question", (k) => k.call({ op: "ask", sessionId: SID, toolUseId: "toolu_09", questions })],
      ["the session's own post", (k) => k.cli(["send", "--session", SID, "Allowed, carrying on."])],
      ["the session's end", (k) => k.call({ op: "ended", sessionId: SID })],
    ];
    for (const [what, settle] of settlers) {
      const k = await withChannel();
      k.idle.touch();
      await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt") });
      await k.pass(MINUTE);
      await settle(k);
      await k.daemon.settle();
      expect({ what, held: k.daemon.outbox.has((e) => e.open?.startsWith("prompt:") === true) }).toEqual({ what, held: false });
      await k.pass(10 * MINUTE);
      expect({ what, sent: k.sent().filter((m) => m.startsWith("Claude needs")) }).toEqual({ what, sent: [] });
    }
  });

  test("a tool result in the transcript after the prompt means it was answered at the keyboard", async () => {
    const k = await withChannel();
    const transcript = `${tmpDir()}/t.jsonl`;
    writeFileSync(transcript, `${toolResultLine(k.clock.now() - MINUTE, "toolu_01")}\n`);
    k.idle.touch();
    await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt", "Claude needs your permission to use Bash", transcript) });
    await k.pass(MINUTE);
    writeFileSync(transcript, `${toolResultLine(k.clock.now() - 2 * MINUTE, "toolu_01")}\n${toolResultLine(k.clock.now())}\n`);
    await k.pass(5 * MINUTE);
    expect(k.sent()).toEqual([]);
    expect(k.daemon.outbox.size).toBe(0);
  });

  test("a tool result from before the prompt doesn't count: the prompt still goes out", async () => {
    const k = await withChannel();
    const transcript = `${tmpDir()}/t.jsonl`;
    writeFileSync(transcript, `${toolResultLine(k.clock.now() - MINUTE, "toolu_01")}\n{ torn\n`);
    k.idle.touch();
    await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt", "Claude needs your permission to use Bash", transcript) });
    await k.pass(5 * MINUTE);
    expect(k.sent()).toEqual(["Claude needs your permission to use Bash"]);
  });

  test("a newer prompt takes the place of a held one", async () => {
    const k = await withChannel();
    k.idle.touch();
    await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt", "Claude needs your permission to use Bash") });
    await k.pass(MINUTE);
    k.idle.touch();
    await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt", "Claude needs your permission to use Write") });
    expect(k.daemon.outbox.heldCount).toBe(1);
    await k.pass(5 * MINUTE);
    expect(k.sent()).toEqual(["Claude needs your permission to use Write"]);
  });
});
