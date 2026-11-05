import { describe, expect, test } from "bun:test";
import { buildPosts } from "../src/outbound.ts";
import { SEND_EXIT, parseSendArgs } from "../src/send.ts";
import { HELPER_DOWN } from "../src/status.ts";
import { OWNER_ID } from "./fakes/fake-rest.ts";
import { SID, daemonKit } from "./helpers/daemon-kit.ts";
import { waitFor } from "./helpers/wait.ts";

async function connectedWithSession() {
  const k = await daemonKit();
  await k.connected();
  await k.register(SID);
  const channelId = k.daemon.sessions.get(SID)!.channelId!;
  return { ...k, channelId };
}

describe("buildPosts", () => {
  test("a ping puts the owner's mention first and allows only the owner", () => {
    expect(buildPosts("Waiting on you", { ping: true, ownerId: "42" })).toEqual([
      { content: "<@42> Waiting on you", allowedMentions: { parse: [], users: ["42"] } },
    ]);
    expect(buildPosts("No ping", { ownerId: "42" })).toEqual([{ content: "No ping", allowedMentions: { parse: [] } }]);
  });

  test("a long pinged post keeps every piece within 2,000 characters and mentions once", () => {
    const pieces = buildPosts("word ".repeat(900), { ping: true, ownerId: "123456789012345678" });
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.content.length).toBeLessThanOrEqual(2000);
    expect(pieces.filter((p) => p.content.includes("<@123456789012345678>"))).toHaveLength(1);
    expect(pieces.slice(1).every((p) => p.allowedMentions.users === undefined)).toBe(true);
  });
});

describe("parseSendArgs", () => {
  test("reads the session, the flags and the text", () => {
    expect(parseSendArgs(["--session", SID, "--ping", "--done", "hi there"])).toEqual({
      sessionId: SID,
      text: "hi there",
      ping: true,
      done: true,
    });
    expect(parseSendArgs([`--session=${SID}`, "-"])).toMatchObject({ text: "-", ping: false, done: false });
    expect(parseSendArgs(["hi"])).toBe("--session <id> is required.");
    expect(typeof parseSendArgs(["--session", SID, "two", "words"])).toBe("string");
    expect(typeof parseSendArgs(["--session", SID, "--loud", "x"])).toBe("string");
  });
});

describe("sk-discord send", () => {
  test("posts in the session's channel only", async () => {
    const k = await connectedWithSession();
    const other = k.rest.addChannel({ name: "other", parent_id: k.categories.cli.id });
    const r = await k.cli(["send", "--session", SID, "Build finished: all 42 tests pass."]);
    expect(r).toEqual({ code: 0, out: "", err: "" });
    await waitFor(() => k.rest.posted(k.channelId).length === 1);
    expect(k.rest.posted(k.channelId)[0]).toMatchObject({
      content: "Build finished: all 42 tests pass.",
      allowed_mentions: { parse: [] },
    });
    expect(k.rest.posted(other.id)).toHaveLength(0);
    expect(k.rest.posted(k.control.id)).toHaveLength(0);
  });

  test("--ping sends the mention and allowed_mentions.users with only the owner", async () => {
    const k = await connectedWithSession();
    expect((await k.cli(["send", "--session", SID, "--ping", "Waiting for your OK"])).code).toBe(0);
    await waitFor(() => k.rest.posted(k.channelId).length === 1);
    expect(k.rest.posted(k.channelId)[0]).toMatchObject({
      content: `<@${OWNER_ID}> Waiting for your OK`,
      allowed_mentions: { parse: [], users: [OWNER_ID] },
    });
  });

  test("a text with @everyone sends parse: [] and pings nobody", async () => {
    const k = await connectedWithSession();
    expect((await k.cli(["send", "--session", SID, "hey @everyone and @here, <@&123> too"])).code).toBe(0);
    await waitFor(() => k.rest.posted(k.channelId).length === 1);
    const message = k.rest.posted(k.channelId)[0]!;
    expect(message.content).toBe("hey @everyone and @here, <@&123> too");
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });

  test("- reads the text from stdin, and a long text goes out as ordered pieces", async () => {
    const k = await connectedWithSession();
    const paragraphs = [0, 1, 2].map((n) => `Part ${n}. ${"detail ".repeat(200)}`.trim());
    expect((await k.cli(["send", "--session", SID, "-"], { stdin: paragraphs.join("\n\n") })).code).toBe(0);
    await waitFor(() => k.rest.posted(k.channelId).length === 3);
    expect(k.rest.posted(k.channelId).map((m) => m.content)).toEqual(paragraphs);
  });

  test("a very long text (60 KB on stdin) arrives whole, in order", async () => {
    const k = await connectedWithSession();
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(4, "0")} ${"é".repeat(50)}`);
    expect((await k.cli(["send", "--session", SID, "-"], { stdin: lines.join("\n") })).code).toBe(0);
    await k.daemon.settle();
    const posted = k.rest.posted(k.channelId).map((m) => m.content);
    expect(posted.length).toBeGreaterThan(25);
    expect(posted.join("\n").split("\n")).toEqual(lines);
  });

  test("exit 2 with the fix when the helper isn't running", async () => {
    const k = await daemonKit({ noStart: true });
    const r = await k.cli(["send", "--session", SID, "hello"]);
    expect(r.code).toBe(SEND_EXIT.helperDown);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${HELPER_DOWN}\n`);
  });

  test("exit 3 when Discord is off, and nothing is queued", async () => {
    const k = await daemonKit({ enabled: false });
    const r = await k.cli(["send", "--session", SID, "hello"]);
    expect(r.code).toBe(3);
    expect(r.err).toBe("Discord is off (/discord on to turn it on)\n");
    expect(k.daemon.outbox.size).toBe(0);
    // The helper refuses too while it still has Discord off (config.json changed without a reload).
    k.setConfig((c) => {
      c.enabled = true;
    });
    const again = await k.cli(["send", "--session", SID, "hello"]);
    expect(again.code).toBe(3);
  });

  test("exit 4 for a session that is not linked and cannot be", async () => {
    const k = await daemonKit();
    await k.connected();
    const r = await k.cli(["send", "--session", "unknown-session", "hello"], { entrypoint: "sdk-cli" });
    expect(r.code).toBe(4);
    expect(r.err).toContain("no Discord channel");
    expect(k.daemon.outbox.size).toBe(0);
  });

  test("an unknown interactive session is registered from what send knows, then posts", async () => {
    const k = await daemonKit();
    await k.connected();
    const r = await k.cli(["send", "--session", "abcd9999", "turned on mid-session"], { entrypoint: "claude-vscode", cwd: "/work/app" });
    expect(r.code).toBe(0);
    await waitFor(() => k.rest.channelNamed("app-abcd-vs") !== undefined);
    const channel = k.rest.channelNamed("app-abcd-vs")!;
    expect(channel.parent_id).toBe(k.categories.vs.id);
    await waitFor(() => k.rest.posted(channel.id).length === 1);
    expect(k.rest.posted(channel.id)[0]!.content).toBe("turned on mid-session");
  });

  test("a session whose channel was deleted gets a new one for its next post", async () => {
    const k = await connectedWithSession();
    k.rest.channels.delete(k.channelId);
    k.daemon.sessions.unlink(SID);
    expect((await k.cli(["send", "--session", SID, "still here"])).code).toBe(0);
    await waitFor(() => k.rest.posted().length === 1);
    const fresh = k.daemon.sessions.get(SID)!.channelId!;
    expect(fresh).not.toBe(k.channelId);
    expect(k.rest.posted(fresh)[0]!.content).toBe("still here");
  });

  test("offline, a post is queued (exit 0) and goes out once connected", async () => {
    const k = await daemonKit({ noStart: true });
    k.gateway.autoHello = false;
    await k.daemon.start();
    await k.register(SID);
    expect((await k.cli(["send", "--session", SID, "while offline"])).code).toBe(0);
    expect(k.daemon.outbox.size).toBe(1);
    await waitFor(() => k.gateway.connections.length === 1);
    k.gateway.hello();
    await k.connected();
    await waitFor(() => k.rest.posted().some((m) => m.content === "while offline"));
  });

  test("--done marks the run finished and tells listeners", async () => {
    const k = await connectedWithSession();
    const seen: { sessionId: string; done: boolean }[] = [];
    k.daemon.onSend((e) => seen.push({ sessionId: e.sessionId, done: e.done }));
    expect((await k.cli(["send", "--session", SID, "--done", "All finished."])).code).toBe(0);
    expect(k.daemon.sessions.get(SID)!.doneAt).toBe(k.clock.now());
    expect(seen).toEqual([{ sessionId: SID, done: true }]);
  });

  test("an empty text or a missing session fails with exit 1", async () => {
    const k = await connectedWithSession();
    expect((await k.cli(["send", "--session", SID, "   "])).code).toBe(1);
    expect((await k.cli(["send", "hello"])).code).toBe(1);
  });
});
