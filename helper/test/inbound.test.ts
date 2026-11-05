import { describe, expect, test } from "bun:test";
import { REPLIES } from "../src/inbound.ts";
import { BOT_ID, OWNER_ID } from "./fakes/fake-rest.ts";
import { inboundKit } from "./helpers/inbound-kit.ts";

const STRANGER = { id: "500000000000000005", bot: false };

describe("which messages count", () => {
  test("another member, a bot, another server or an unknown channel: no event and no reply", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId);
    const event = k.listen();
    await k.attached();
    await k.say("from someone else", { author: STRANGER });
    await k.say("from a bot", { author: { id: "600000000000000006", bot: true } });
    await k.say("from the bot itself", { author: { id: BOT_ID, bot: true } });
    await k.say("posing as the owner, but a bot", { author: { id: OWNER_ID, bot: true } });
    const other = k.rest.addChannel({ name: "random" });
    await k.say("in a channel that is no session's", { channelId: other.id });
    k.gateway.dispatch("MESSAGE_CREATE", {
      id: "1",
      channel_id: k.channelId(),
      guild_id: "700000000000000007",
      author: { id: OWNER_ID },
      content: "from another server",
      type: 0,
    });
    await k.say("a pin notice", { type: 6 });
    expect(k.features.hub.isListening(k.sessionId)).toBe(true);
    expect(k.rest.posted()).toHaveLength(0);
    expect(k.daemon.sessions.get(k.sessionId)!.inbox).toEqual([]);

    await k.say("the owner, for real");
    expect(await event).toMatchObject({ type: "text", text: "the owner, for real" });
  });
});

describe("control words", () => {
  test("stop, pause and resume reach the listener and get their replies, whatever the case", async () => {
    const k = await inboundKit();
    for (const [typed, type, reply] of [
      ["stop", "stop", "Stopping."],
      ["  Pause ", "pause", "Pausing after this step."],
      ["RESUME", "resume", "Resuming."],
    ] as const) {
      const event = k.listen();
      await k.attached();
      await k.say(typed);
      expect(await event).toEqual({ type });
      expect(k.replies().at(-1)).toBe(reply);
    }
  });

  test("a control word inside a longer message is just text", async () => {
    const k = await inboundKit();
    const event = k.listen();
    await k.attached();
    await k.say("please stop the build");
    expect(await event).toMatchObject({ type: "text", text: "please stop the build" });
    expect(k.replies()).toEqual([]);
  });

  test("status in a session's channel: name, surface, state, last post and folder", async () => {
    const k = await inboundKit({ entrypoint: "claude-vscode" });
    k.claude.addInteractive(k.sessionId, "busy");
    k.daemon.channels.applyNames(new Map([[k.sessionId, "Fix login bug"]]));
    await k.settle();
    expect((await k.cli_send("All tests pass.")).code).toBe(0);
    await k.say("Status");
    const reply = k.replies().at(-1)!;
    expect(reply.split("\n")).toEqual([
      "Fix login bug · VS Code · open",
      expect.stringMatching(/^Last post from the session: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
      "Folder: session-kit",
    ]);
    expect(k.claude.runs.some((r) => r.cmd.join(" ") === "/opt/tools/claude agents --json --all")).toBe(true);
  });

  test("status says closed for a session that ended and the list leaves out", async () => {
    const k = await inboundKit();
    k.daemon.channels.ended(k.sessionId);
    await k.say("status");
    expect(k.replies().at(-1)!.split("\n")[0]).toMatch(/· CLI · closed$/);
    expect(k.replies().at(-1)).toContain("Last post from the session: none yet");
  });

  test("status in #session-kit lists every linked session; anything else there gets a pointer", async () => {
    const k = await inboundKit();
    await k.startChat("bbbb2222", "claude-desktop");
    k.claude.addInteractive(k.sessionId);
    await k.say("status", { channelId: k.control.id });
    const listing = k.rest.posted(k.control.id).at(-1)!.content.split("\n");
    expect(listing[0]).toBe("2 linked sessions:");
    expect(listing.slice(1).sort()).toEqual([
      "- #session-kit-bbbb-desktop · Desktop · open · no posts yet",
      "- #session-kit-caa2-cli · CLI · open · no posts yet",
    ]);
    await k.say("hello?", { channelId: k.control.id });
    expect(k.rest.posted(k.control.id).at(-1)!.content).toBe(REPLIES.controlHint);
  });
});

describe("attachments", () => {
  test("an attachment-only message gets the reply and nothing else", async () => {
    const k = await inboundKit();
    const event = k.listen();
    await k.attached();
    await k.say("", { attachments: [{ id: "1", filename: "log.txt" }] });
    expect(k.replies()).toEqual(["Attachments aren't supported; paste the text instead."]);
    expect(k.features.hub.isListening(k.sessionId)).toBe(true);
    // Text sent with an attachment still goes through.
    await k.say("see the file", { attachments: [{ id: "2", filename: "log.txt" }] });
    expect(await event).toMatchObject({ type: "text", text: "see the file" });
    expect(k.replies()).toEqual([REPLIES.attachments, REPLIES.attachments]);
  });
});
