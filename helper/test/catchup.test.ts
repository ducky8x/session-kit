import { describe, expect, test } from "bun:test";
import { MINUTE_MS } from "../src/channels.ts";
import { REPLIES } from "../src/inbound.ts";
import { newSession } from "../src/state.ts";
import { BOT_ID, GUILD_ID } from "./fakes/fake-rest.ts";
import { type BatteryKit, STRANGER, batteryKit, idAt } from "./helpers/battery-kit.ts";
import { SID } from "./helpers/daemon-kit.ts";
import { waitFor } from "./helpers/wait.ts";

const HOUR_MS = 60 * MINUTE_MS;

/**
 * A helper about to start, as after a restart: SID's chat has a channel (and is open in a terminal, so messages
 * for it wait in its inbox), and the channel's cursor is a message seen two hours ago, unless `cursor` is null.
 * `typed` adds a message sent some minutes ago; `start` starts the helper and waits for what READY set off.
 */
async function beforeStart(o: { cursor?: null; power?: "ac" | "battery"; catchUpMaxAgeMs?: number } = {}) {
  const { cursor, ...kitOptions } = o;
  const k = await batteryKit({ power: "ac", ...kitOptions, start: false });
  const channel = k.rest.addChannel({ name: "session-kit-caa2-cli", parent_id: k.categories.cli.id });
  k.daemon.sessions.put({
    ...newSession({ sessionId: SID, surface: "cli", cwd: "/work/session-kit", transcriptPath: null, now: k.clock.now() }),
    channelId: channel.id,
    channelName: channel.name,
  });
  const seen = k.rest.addMessage({ channelId: channel.id, content: "seen two hours ago", id: idAt(k.clock.now() - 2 * HOUR_MS) });
  if (cursor !== null) k.daemon.cursors.advance(channel.id, seen.id);
  const typed = (content: string, minutesAgo: number, m: { author?: { id: string; bot?: boolean }; channelId?: string } = {}) =>
    k.rest.addMessage({
      channelId: m.channelId ?? channel.id,
      content,
      id: idAt(k.clock.now() - minutesAgo * MINUTE_MS),
      ...(m.author ? { author: m.author } : {}),
    });
  const start = async () => {
    await k.daemon.start();
    await k.connected();
    await k.settleAll();
  };
  return { ...k, channelId: channel.id, cursorAtStart: seen.id, typed, start };
}

/** Move the fake clock a second at a time, letting the loopback sockets answer in between, until `check` holds. */
async function until(k: BatteryKit, check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) {
    await k.clock.advance(1000);
    await Bun.sleep(2);
  }
  expect(check()).toBe(true);
}

describe("catching up when the gateway starts a new session", () => {
  test("a message typed while the helper restarted reaches the session once, after READY", async () => {
    const first = await batteryKit({ power: "ac" });
    await first.connected();
    await first.startChat(SID);
    const channelId = first.daemon.sessions.get(SID)!.channelId!;
    const live = first.rest.addMessage({ channelId, content: "seen live", id: idAt(first.clock.now() - 30 * MINUTE_MS) });
    first.gateway.dispatch("MESSAGE_CREATE", { ...live, guild_id: GUILD_ID });
    await waitFor(() => first.daemon.cursors.get(channelId) === live.id);
    expect((await first.call({ op: "listen", sessionId: SID })).event).toMatchObject({ text: "seen live", queued: true });
    await first.daemon.stop();

    // The next helper finds the same sessions and cursors, and a message typed while nothing ran.
    const second = await batteryKit({ home: first.home, power: "ac", start: false });
    second.rest.addChannel({ id: channelId, name: "session-kit-caa2-cli", parent_id: second.categories.cli.id });
    second.setConfig((c) => {
      c.categories = {
        desktop: second.categories.desktop.id,
        vs: second.categories.vs.id,
        cli: second.categories.cli.id,
        archive: second.categories.archive.id,
      };
    });
    const missed = second.rest.addMessage({ channelId, content: "typed while it restarted", id: idAt(second.clock.now() - MINUTE_MS) });
    await second.daemon.start();
    await second.connected();
    await second.settleAll();
    expect(second.seen).toEqual([["typed while it restarted", SID]]);
    expect(second.reads(channelId).map((r) => r.query)).toEqual([`?after=${live.id}&limit=100`]);
    expect(second.daemon.cursors.get(channelId)).toBe(missed.id);
    expect(second.rest.posted(channelId).at(-1)!.content).toBe(REPLIES.notListening);
    expect((await second.call({ op: "listen", sessionId: SID })).event).toMatchObject({
      type: "text",
      text: "typed while it restarted",
      queued: true,
    });
    expect(second.log.lines).toContain("info caught up on 1 message");
    await second.tick(30 * MINUTE_MS);
    expect(second.seen).toHaveLength(1);
    expect(second.reads(channelId)).toHaveLength(1);
  });

  test("a message that also comes over the gateway while the catch-up runs is handed on once", async () => {
    const k = await beforeStart();
    k.typed("typed while it was down", 2);
    // The catch-up's read is slow, so the gateway brings a message it will list too.
    const release = k.rest.holdNext({ method: "GET", path: `/channels/${k.channelId}/messages` });
    await k.daemon.start();
    await k.connected();
    await waitFor(() => k.reads(k.channelId).length === 1);
    const both = k.typed("typed just after the start", 0);
    k.gateway.dispatch("MESSAGE_CREATE", { ...both, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 1);
    // This one the catch-up lists first, and its gateway copy comes in after.
    const late = k.typed("typed a moment later", 0);
    release();
    await k.settleAll();
    k.gateway.dispatch("MESSAGE_CREATE", { ...late, guild_id: GUILD_ID });
    const next = k.typed("and one more", 0);
    k.gateway.dispatch("MESSAGE_CREATE", { ...next, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 4);
    await k.settleAll();
    const texts = ["typed just after the start", "typed while it was down", "typed a moment later", "and one more"];
    expect(k.seen).toEqual(texts.map((text) => [text, SID]));
    expect(k.daemon.sessions.get(SID)!.inbox.map((e) => e.text)).toEqual(texts);
    expect(k.log.lines).toContain("info caught up on 2 messages");
  });

  test("a message older than 15 minutes is skipped, and the log says how many were", async () => {
    const k = await beforeStart();
    k.typed("typed 40 minutes ago", 40);
    k.typed("typed 16 minutes ago", 16);
    const fresh = k.typed("typed 14 minutes ago", 14);
    await k.start();
    expect(k.seen).toEqual([["typed 14 minutes ago", SID]]);
    expect(k.log.lines).toContain("info caught up on 1 message, skipped 2 older than 15 minutes");
    expect(k.daemon.cursors.get(k.channelId)).toBe(fresh.id);
  });

  test("when every message is too old, none is handed on, and the cursor still moves past them", async () => {
    const k = await beforeStart();
    k.typed("typed 40 minutes ago", 40);
    const last = k.typed("typed 20 minutes ago", 20);
    await k.start();
    expect(k.seen).toEqual([]);
    expect(k.log.lines).toContain("info caught up on 0 messages, skipped 2 older than 15 minutes");
    expect(k.daemon.cursors.get(k.channelId)).toBe(last.id);
    // Nor does a check on battery power hand them on later.
    await k.toBattery();
    await k.tick();
    expect(k.reads(k.channelId).at(-1)!.query).toBe(`?after=${last.id}&limit=100`);
    expect(k.seen).toEqual([]);
  });

  test("the cutoff can be set", async () => {
    const k = await beforeStart({ catchUpMaxAgeMs: HOUR_MS });
    k.typed("typed 90 minutes ago", 90);
    k.typed("typed 40 minutes ago", 40);
    await k.start();
    expect(k.seen).toEqual([["typed 40 minutes ago", SID]]);
    expect(k.log.lines).toContain("info caught up on 1 message, skipped 1 older than 60 minutes");
  });

  test("a channel without a cursor is not read; the gateway's first message there starts one", async () => {
    const k = await beforeStart({ cursor: null });
    k.typed("typed while it was down", 1);
    await k.start();
    expect(k.reads()).toEqual([]);
    expect(k.seen).toEqual([]);
    expect(k.daemon.cursors.get(k.channelId)).toBeUndefined();
    const live = k.typed("typed now", 0);
    k.gateway.dispatch("MESSAGE_CREATE", { ...live, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 1);
    expect(k.daemon.cursors.get(k.channelId)).toBe(live.id);
  });

  test("a channel with nothing new keeps its cursor for the next time", async () => {
    const k = await beforeStart();
    await k.start();
    expect(k.reads(k.channelId)).toHaveLength(1);
    expect(k.daemon.cursors.get(k.channelId)).toBe(k.cursorAtStart);
  });

  test("the bot's own messages and other people's are filtered as on the live path", async () => {
    const k = await beforeStart();
    const all: (string | undefined)[] = [];
    k.daemon.onInbound((message) => void all.push(message.content));
    k.typed("a post from the bot", 3, { author: { id: BOT_ID, bot: true } });
    k.typed("someone else", 2, { author: { id: STRANGER } });
    const owner = k.typed("from the owner", 1);
    await k.start();
    // Every message reaches the handlers, as from the gateway, and only the owner's is taken.
    expect(all).toEqual(["a post from the bot", "someone else", "from the owner"]);
    expect(k.seen).toEqual([["from the owner", SID]]);
    expect(k.daemon.sessions.get(SID)!.inbox.map((e) => e.text)).toEqual(["from the owner"]);
    expect(k.rest.posted(k.channelId).filter((m) => m.content === REPLIES.notListening)).toHaveLength(1);
    expect(k.daemon.cursors.get(k.channelId)).toBe(owner.id);
  });

  test("#session-kit is caught up too", async () => {
    const k = await beforeStart();
    k.daemon.cursors.advance(k.control.id, idAt(k.clock.now() - HOUR_MS));
    k.typed("status", 1, { channelId: k.control.id });
    await k.start();
    expect(k.seen).toEqual([["status", null]]);
    expect(k.rest.posted(k.control.id).at(-1)!.content).toContain("1 linked session");
  });
});

describe("resumed and new gateway sessions", () => {
  test("a resumed session reads nothing and keeps the cursors: Discord sends what it missed", async () => {
    const k = await beforeStart();
    await k.start();
    const live = k.typed("seen live", 0);
    k.gateway.dispatch("MESSAGE_CREATE", { ...live, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 1);
    const reads = k.reads().length;
    k.gateway.dropLatest();
    await waitFor(() => k.daemon.gateway.state === "connecting");
    await k.clock.advance(1000);
    await waitFor(() => k.gateway.connections.length === 2 && k.daemon.gateway.state === "connected");
    expect(k.gateway.latest!.ops(6)).toHaveLength(1);
    expect(k.gateway.latest!.ops(2)).toHaveLength(0);
    await k.settleAll();
    expect(k.daemon.cursors.get(k.channelId)).toBe(live.id);
    const replayed = k.typed("typed during the drop", 0);
    k.gateway.dispatch("MESSAGE_CREATE", { ...replayed, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 2);
    await k.settleAll();
    expect(k.reads()).toHaveLength(reads);
    expect(k.daemon.cursors.get(k.channelId)).toBe(replayed.id);
  });

  test("a session that can't be resumed is followed by a new one, which catches up", async () => {
    const k = await beforeStart();
    await k.start();
    const live = k.typed("seen live", 0);
    k.gateway.dispatch("MESSAGE_CREATE", { ...live, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 1);
    k.gateway.closeLatest(4009);
    await waitFor(() => k.daemon.gateway.state === "connecting");
    k.typed("typed while the gateway was away", 0);
    await k.clock.advance(1000);
    await waitFor(() => k.gateway.connections.length === 2 && k.daemon.gateway.state === "connected");
    await k.settleAll();
    expect(k.gateway.latest!.ops(2)).toHaveLength(1);
    expect(k.reads(k.channelId).at(-1)!.query).toBe(`?after=${live.id}&limit=100`);
    expect(k.seen).toEqual([
      ["seen live", SID],
      ["typed while the gateway was away", SID],
    ]);
  });
});

describe("when a read fails during the catch-up", () => {
  test("a channel that can't be read is logged and starts again from its newest message; the rest are read", async () => {
    const k = await beforeStart();
    k.daemon.cursors.advance(k.control.id, idAt(k.clock.now() - HOUR_MS));
    k.typed("typed while it was down", 1);
    k.typed("status", 1, { channelId: k.control.id });
    k.rest.failNext({ method: "GET", path: `/channels/${k.channelId}/messages`, status: 403, body: { message: "Missing Access", code: 50001 } });
    await k.start();
    expect(k.log.lines).toContain(`warn GET /channels/${k.channelId}/messages -> 403 (code 50001)`);
    expect(k.seen).toEqual([["status", null]]);
    expect(k.daemon.cursors.get(k.channelId)).toBeUndefined();
    expect(k.daemon.statusCode()).toBe("connected");
    const live = k.typed("typed now", 0);
    k.gateway.dispatch("MESSAGE_CREATE", { ...live, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 2);
  });

  test("network trouble ends the catch-up with a warning, and the gateway carries on", async () => {
    const k = await beforeStart();
    k.typed("typed while it was down", 1);
    // Six 500s: the first try and the five retries, 1, 2, 4, 8 and 16 seconds apart.
    k.rest.failNext({ method: "GET", path: `/channels/${k.channelId}/messages`, status: 500, times: 6 });
    await k.daemon.start();
    await k.connected();
    const stopped = `warn catching up stopped: Discord failed on GET /channels/${k.channelId}/messages (500).`;
    await until(k, () => k.log.lines.includes(stopped));
    await k.settleAll();
    expect(k.seen).toEqual([]);
    expect(k.daemon.statusCode()).toBe("connected");
    const live = k.typed("typed now", 0);
    k.gateway.dispatch("MESSAGE_CREATE", { ...live, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 1);
  });

  test("a token refused by a read is only a warning: the gateway accepted the same token", async () => {
    const k = await beforeStart();
    k.typed("typed while it was down", 1);
    k.rest.failNext({ method: "GET", path: `/channels/${k.channelId}/messages`, status: 401, body: { message: "401: Unauthorized", code: 0 } });
    await k.start();
    expect(k.log.lines).toContain(`warn catching up stopped: Discord refused GET /channels/${k.channelId}/messages (401).`);
    expect(k.daemon.statusCode()).toBe("connected");
  });
});

describe("on battery power", () => {
  test("nothing changes: no gateway, and a check hands on messages of any age", async () => {
    const k = await beforeStart({ power: "battery" });
    k.typed("typed 40 minutes ago", 40);
    await k.start();
    expect(k.gateway.connections).toHaveLength(0);
    expect(k.seen).toEqual([["typed 40 minutes ago", SID]]);
    // The Mac slept on battery; back on AC, what came in meanwhile is handed on whatever its age.
    k.typed("typed during sleep", 20);
    await k.toAc();
    expect(k.seen).toEqual([
      ["typed 40 minutes ago", SID],
      ["typed during sleep", SID],
    ]);
    expect(k.log.lines.filter((line) => line.includes("caught up"))).toEqual([]);
  });
});
