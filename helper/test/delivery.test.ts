import { describe, expect, test } from "bun:test";
import { REPLIES } from "../src/inbound.ts";
import { BETWEEN_LISTENS_MS } from "../src/listeners.ts";
import { GUILD_ID } from "./fakes/fake-rest.ts";
import { inboundKit } from "./helpers/inbound-kit.ts";
import { waitFor } from "./helpers/wait.ts";

function stopHookInput(sessionId: string): string {
  return JSON.stringify({ session_id: sessionId, hook_event_name: "Stop", stop_hook_active: false });
}

describe("delivery", () => {
  test("with a listener attached, the message arrives as a text event at once", async () => {
    const k = await inboundKit();
    const event = k.listen();
    await k.attached();
    const id = await k.say("can you also run the linter?");
    expect(await event).toEqual({ type: "text", id, text: "can you also run the linter?", at: k.clock.now() });
    expect(k.replies()).toEqual([]);
  });

  test("open without a listener: inbox and a reply, and the Stop hook hands it over", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId, "busy");
    await k.say("one more thing");
    await k.say("and another");
    expect(k.replies()).toEqual([REPLIES.notListening, REPLIES.notListening]);
    expect(REPLIES.notListening).toBe("The session is open but not listening. It will see this when its current turn ends.");
    expect(k.daemon.sessions.get(k.sessionId)!.inbox.map((e) => e.text)).toEqual(["one more thing", "and another"]);

    const r = await k.cli(["hook", "stop"], { stdin: stopHookInput(k.sessionId) });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.decision).toBe("block");
    expect(out.reason.startsWith("Discord message(s) for this session:")).toBe(true);
    expect(out.reason).toContain("1. one more thing");
    expect(out.reason).toContain("2. and another");
    expect(k.daemon.sessions.get(k.sessionId)!.inbox).toEqual([]);

    // Nothing left: the next Stop prints nothing.
    expect(await k.cli(["hook", "stop"], { stdin: stopHookInput(k.sessionId) })).toMatchObject({ code: 0, out: "" });
  });

  test("the Stop hook stays quiet while a listener is attached", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId);
    await k.say("queued first");
    const listener = k.listen();
    expect(await listener).toMatchObject({ type: "text", text: "queued first", queued: true });
    // This one is still waiting when the test ends and the daemon stops.
    void k.listen().catch(() => null);
    await k.attached();
    expect(await k.cli(["hook", "stop"], { stdin: stopHookInput(k.sessionId) })).toMatchObject({ code: 0, out: "" });
  });

  test("events from the inbox come with queued: true, oldest first, when a listener attaches", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId);
    await k.say("first");
    await k.say("stop");
    expect(await k.listen()).toMatchObject({ type: "text", text: "first", queued: true });
    expect(await k.listen()).toEqual({ type: "stop", queued: true });
    const next = k.listen();
    await k.attached();
    await k.say("live again");
    expect(await next).toMatchObject({ type: "text", text: "live again" });
    expect((await next as { queued?: boolean }).queued).toBeUndefined();
  });

  test("right after a listener took an event, a message waits quietly for the next listener", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId);
    const first = k.listen();
    await k.attached();
    await k.say("one");
    await first;
    await k.say("two");
    expect(k.replies()).toEqual([]);
    expect(await k.listen()).toMatchObject({ text: "two", queued: true });
    await k.clock.advance(BETWEEN_LISTENS_MS);
    await k.say("three");
    expect(k.replies()).toEqual([REPLIES.notListening]);
  });

  test("a second listener replaces the first, which gets replaced", async () => {
    const k = await inboundKit();
    const older = k.listen();
    await k.attached();
    const newer = k.listen();
    expect(await older).toEqual({ type: "replaced" });
    await k.attached();
    await k.say("for the newer one");
    expect(await newer).toMatchObject({ type: "text", text: "for the newer one" });
  });

  test("a listener that goes away leaves nothing attached", async () => {
    const k = await inboundKit();
    const gone = new AbortController();
    const { callHelper } = await import("../src/client.ts");
    const call = callHelper(k.paths.socket, { op: "listen", sessionId: k.sessionId }, { signal: gone.signal }).catch(() => null);
    await k.attached();
    gone.abort();
    await call;
    await waitFor(() => !k.features.hub.isListening(k.sessionId));
  });

  test("turning Discord off sends disabled to every listener, and listen then answers disabled", async () => {
    const k = await inboundKit();
    const event = k.listen();
    await k.attached();
    k.setConfig((c) => {
      c.enabled = false;
    });
    await k.call({ op: "reload" });
    expect(await event).toEqual({ type: "disabled" });
    expect(await k.listen()).toEqual({ type: "disabled" });
  });

  test("a deleted channel sends unlinked; listening for an unknown session is unlinked too", async () => {
    const k = await inboundKit();
    const event = k.listen();
    await k.attached();
    k.gateway.dispatch("CHANNEL_DELETE", { id: k.channelId(), guild_id: GUILD_ID, type: 0 });
    expect(await event).toEqual({ type: "unlinked" });
    expect(await k.listen("never-registered")).toEqual({ type: "unlinked" });
  });

  test("a session listens before its chat starts, and hears the first message once it has a channel", async () => {
    const k = await inboundKit();
    await k.register("dddd4444");
    const event = k.listen("dddd4444");
    await k.attached("dddd4444");
    await k.call({ op: "stop-hook", sessionId: "dddd4444" });
    await waitFor(() => k.daemon.sessions.get("dddd4444")?.channelId != null);
    await k.say("hello there", { channelId: k.daemon.sessions.get("dddd4444")!.channelId! });
    expect(await event).toMatchObject({ type: "text", text: "hello there" });
  });

  test("a full inbox drops the oldest and the reply says so", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId);
    for (let i = 0; i < 50; i++) k.daemon.sessions.pushInbox(k.sessionId, { type: "text", id: `${i}`, text: `old ${i}`, at: 0 });
    await k.say("the fifty-first");
    expect(k.replies().at(-1)).toBe(`${REPLIES.notListening} ${REPLIES.inboxFull}`);
    const inbox = k.daemon.sessions.get(k.sessionId)!.inbox;
    expect(inbox).toHaveLength(50);
    expect(inbox[0]!.text).toBe("old 1");
    expect(inbox.at(-1)!.text).toBe("the fifty-first");
  });

  test("a closed desktop or VS Code session keeps the message and says how to get it there; nothing is woken", async () => {
    for (const [entrypoint, reply] of [
      ["claude-desktop", "This session is closed. Open it in the Claude desktop app and it will pick this up."],
      ["claude-vscode", "This session is closed. Open it in VS Code and it will pick this up."],
    ] as const) {
      const k = await inboundKit({ entrypoint });
      k.claude.addClosed(k.sessionId);
      k.daemon.channels.ended(k.sessionId);
      await k.say("are you there?");
      expect(k.replies()).toEqual([reply]);
      expect(k.daemon.sessions.get(k.sessionId)!.inbox).toHaveLength(1);
      expect(k.claude.launchLines()).toEqual([]);
    }
  });

  test("an open desktop session the list leaves out still counts as open", async () => {
    const k = await inboundKit({ entrypoint: "claude-desktop" });
    await k.say("hello");
    expect(k.replies()).toEqual([REPLIES.notListening]);
  });
});

describe("sk-discord listen", () => {
  test("prints the event as one JSON line", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId);
    await k.say("queued text");
    const r = await k.cli(["listen", "--session", k.sessionId]);
    expect(r.code).toBe(0);
    expect(r.out.endsWith("\n")).toBe(true);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.out)).toMatchObject({ type: "text", text: "queued text", queued: true });
  });

  test("with the helper down it prints helper-down and exits 2", async () => {
    const { daemonKit } = await import("./helpers/daemon-kit.ts");
    const k = await daemonKit({ noStart: true });
    const r = await k.cli(["listen", "--session", "abc"]);
    expect(r).toEqual({ code: 2, out: '{"type":"helper-down"}\n', err: "" });
  });

  test("with Discord off it prints disabled", async () => {
    const { daemonKit } = await import("./helpers/daemon-kit.ts");
    const k = await daemonKit({ enabled: false, noStart: true });
    expect(await k.cli(["listen", "--session", "abc"])).toEqual({ code: 0, out: '{"type":"disabled"}\n', err: "" });
  });

  test("needs --session", async () => {
    const { daemonKit } = await import("./helpers/daemon-kit.ts");
    const k = await daemonKit({ noStart: true });
    expect((await k.cli(["listen"])).code).toBe(1);
  });
});
