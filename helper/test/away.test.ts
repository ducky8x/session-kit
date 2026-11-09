import { describe, expect, test } from "bun:test";
import { CONVERSATION_MS } from "../src/daemon.ts";
import { couldNotWake } from "../src/inbound.ts";
import { heldLine } from "../src/send.ts";
import { SID, daemonKit } from "./helpers/daemon-kit.ts";
import { inboundKit } from "./helpers/inbound-kit.ts";

const MINUTE = 60_000;

async function withChannel() {
  const k = await daemonKit();
  await k.connected();
  await k.startChat(SID);
  const channelId = k.daemon.sessions.get(SID)!.channelId!;
  const sent = () => k.rest.posted(channelId).map((m) => m.content);
  /** Let time pass and wait for what it started. */
  const pass = async (ms: number) => {
    await k.clock.advance(ms);
    await k.daemon.settle();
  };
  return { ...k, channelId, sent, pass };
}

describe("posts while the user is at the computer", () => {
  test("a post made after 5 minutes without input goes out at once, and send prints nothing", async () => {
    const k = await withChannel();
    k.idle.idleFor(5 * MINUTE);
    expect(await k.cli(["send", "--session", SID, "Tests pass."])).toEqual({ code: 0, out: "", err: "" });
    await k.daemon.settle();
    expect(k.sent()).toEqual(["Tests pass."]);
  });

  test("a post made while the user is active is held (send says so, exit 0) and goes out after 5 idle minutes", async () => {
    const k = await withChannel();
    k.idle.touch();
    const r = await k.cli(["send", "--session", SID, "--done", "Finished the refactor."]);
    expect(r).toEqual({ code: 0, out: `${heldLine(5)}\n`, err: "" });
    expect(heldLine(5)).toBe("Held: you're at the computer. It goes out if you're away for 5 minutes.");
    expect(heldLine(1)).toBe("Held: you're at the computer. It goes out if you're away for 1 minute.");
    // --done still marks the run finished at once.
    expect(k.daemon.sessions.get(SID)!.doneAt).toBe(k.clock.now());
    await k.pass(4 * MINUTE + 30_000);
    expect(k.sent()).toEqual([]);
    await k.pass(30_000);
    expect(k.sent()).toEqual(["Finished the refactor."]);
  });

  test("a held post is dropped once the user uses the computer after it was made", async () => {
    const k = await withChannel();
    k.idle.touch();
    expect((await k.cli(["send", "--session", SID, "Step 1 done."])).out).toBe(`${heldLine(5)}\n`);
    await k.pass(15_000);
    k.idle.touch();
    await k.pass(15_000);
    expect(k.daemon.outbox.size).toBe(0);
    expect(k.log.lines.filter((l) => l.startsWith("debug dropped held post"))).toHaveLength(1);
    await k.pass(30 * MINUTE);
    expect(k.sent()).toEqual([]);
  });

  test("awayMinutes from config.json sets the wait, and /discord on reads it again", async () => {
    const k = await withChannel();
    k.setConfig((c) => {
      c.awayMinutes = 2;
    });
    expect((await k.cli(["on"])).code).toBe(0);
    await k.connected();
    k.idle.touch();
    expect((await k.cli(["send", "--session", SID, "Short wait."])).out).toBe(`${heldLine(2)}\n`);
    await k.pass(2 * MINUTE);
    expect(k.sent()).toEqual(["Short wait."]);
  });

  test("sk-discord status counts the held posts", async () => {
    const k = await withChannel();
    k.idle.touch();
    await k.cli(["send", "--session", SID, "one"]);
    await k.cli(["send", "--session", SID, "two"]);
    expect(await k.call({ op: "status" })).toMatchObject({ outbox: 0, held: 2, awayMinutes: 5 });
    const r = await k.cli(["status"]);
    expect(r.out).toContain("Held while you're at the computer: 2 posts (they go out after 5 minutes away).");
    expect(r.out).not.toContain("Posts waiting");
  });

  test("held posts survive a restart of the helper and go out once the user is away", async () => {
    const first = await withChannel();
    first.idle.touch();
    await first.cli(["send", "--session", SID, "made before the restart"]);
    await first.daemon.stop();

    const second = await daemonKit({ home: first.home, noStart: true });
    const kept = first.channelId;
    second.rest.addChannel({ id: kept, name: "session-kit-caa2-cli", parent_id: second.categories.cli.id });
    second.setConfig((c) => {
      c.categories = {
        desktop: second.categories.desktop.id,
        vs: second.categories.vs.id,
        cli: second.categories.cli.id,
        archive: second.categories.archive.id,
      };
    });
    // The same keyboard and mouse: no input since the post was made.
    second.idle.state.lastInputAt = first.idle.state.lastInputAt;
    await second.daemon.start();
    await second.connected();
    await second.daemon.settle();
    expect(second.daemon.outbox.heldCount).toBe(1);
    await second.clock.advance(5 * MINUTE);
    await second.daemon.settle();
    expect(second.rest.posted(kept).map((m) => m.content)).toEqual(["made before the restart"]);
  });
});

describe("a conversation in Discord", () => {
  test("a session post within 30 minutes of the owner's last message in its channel goes out at once while active", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId);
    await k.say("how is the deploy going?");
    k.idle.touch();
    await k.clock.advance(29 * MINUTE);
    k.idle.touch();
    expect(await k.cli_send("Deploy is halfway.")).toEqual({ code: 0, out: "", err: "" });
    await k.settle();
    expect(k.replies().at(-1)).toBe("Deploy is halfway.");
    expect(CONVERSATION_MS).toBe(30 * MINUTE);

    // Thirty minutes after the owner's message, the session's posts are held again.
    await k.clock.advance(MINUTE);
    k.idle.touch();
    expect((await k.cli_send("Deploy finished.")).out).toBe(`${heldLine(5)}\n`);
    await k.settle();
    expect(k.replies().at(-1)).toBe("Deploy is halfway.");
  });

  test("a message in another session's channel doesn't count", async () => {
    const k = await inboundKit();
    const other = "dddd4444-0000-4000-8000-000000000004";
    await k.startChat(other);
    const otherChannel = k.daemon.sessions.get(other)!.channelId!;
    await k.say("hello over there", { channelId: otherChannel });
    k.idle.touch();
    expect((await k.cli_send("This one is held.")).out).toBe(`${heldLine(5)}\n`);
  });

  test("control-word and status replies go out at once while the user is active", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId);
    k.idle.touch();
    await k.say("stop");
    await k.say("status");
    await k.say("status", { channelId: k.control.id });
    expect(k.replies()[0]).toBe("Stopping.");
    expect(k.replies()[1]).toContain("Last post from the session");
    expect(k.rest.posted(k.control.id).at(-1)!.content).toContain("linked session");
    expect(k.daemon.outbox.size).toBe(0);
  });

  test("a couldn't-wake reply goes out at once while the user is active", async () => {
    const k = await inboundKit();
    k.claude.addClosed(k.sessionId);
    k.claude.launchCode = 1;
    k.idle.touch();
    await k.say("hello");
    expect(k.replies()).toEqual([couldNotWake("exit 1")]);
  });
});
