import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { MINUTE_MS } from "../src/channels.ts";
import { sessionFeatures } from "../src/features.ts";
import { REPLIES } from "../src/inbound.ts";
import { pathsFor } from "../src/paths.ts";
import { CursorStore, PAGE_SIZE } from "../src/poller.ts";
import { newSession } from "../src/state.ts";
import { GUILD_ID } from "./fakes/fake-rest.ts";
import { AC_OUTPUT, BATTERY_OUTPUT, STRANGER, batteryKit } from "./helpers/battery-kit.ts";
import { SID } from "./helpers/daemon-kit.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { waitFor } from "./helpers/wait.ts";

describe("CursorStore", () => {
  test("moves forward only, ignores ids that aren't ids, and survives a restart", () => {
    const paths = pathsFor(tmpDir());
    const cursors = new CursorStore(paths);
    expect(cursors.get("111111111111111111")).toBeUndefined();
    cursors.advance("111111111111111111", "900000000000000005");
    cursors.advance("111111111111111111", "900000000000000003");
    cursors.advance("111111111111111111", "not-an-id");
    cursors.advance("222222222222222222", "1000000000000000000");
    expect(cursors.get("111111111111111111")).toBe("900000000000000005");
    // A longer id is a later one.
    cursors.advance("222222222222222222", "999999999999999999");
    expect(cursors.get("222222222222222222")).toBe("1000000000000000000");
    expect(new CursorStore(paths).snapshot()).toEqual(
      new Map([
        ["111111111111111111", "900000000000000005"],
        ["222222222222222222", "1000000000000000000"],
      ]),
    );
  });

  test("retain forgets other channels, clear forgets all, and a broken file reads as empty", () => {
    const paths = pathsFor(tmpDir());
    const cursors = new CursorStore(paths);
    cursors.advance("111111111111111111", "900000000000000005");
    cursors.advance("222222222222222222", "900000000000000006");
    cursors.retain(new Set(["222222222222222222"]));
    expect([...new CursorStore(paths).snapshot().keys()]).toEqual(["222222222222222222"]);
    cursors.clear();
    expect(new CursorStore(paths).snapshot().size).toBe(0);
    writeFileSync(paths.cursors, "{ broken");
    expect(new CursorStore(paths).snapshot().size).toBe(0);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.cursors, JSON.stringify({ "111111111111111111": 5, "333333333333333333": "900000000000000001" }));
    expect(new CursorStore(paths).snapshot()).toEqual(new Map([["333333333333333333", "900000000000000001"]]));
  });
});

describe("on battery power", () => {
  test("the gateway stays closed; Discord is checked at once and then every 5 minutes", async () => {
    const k = await batteryKit();
    expect(k.gateway.connections).toHaveLength(0);
    expect(k.daemon.statusCode()).toBe("connected");
    const first = k.reads().length;
    expect(first).toBe(1); // #session-kit
    await k.tick(5 * MINUTE_MS - 1);
    expect(k.reads()).toHaveLength(first);
    await k.tick(1);
    expect(k.reads()).toHaveLength(first + 1);
    await k.tick();
    expect(k.reads()).toHaveLength(first + 2);
    expect(k.gateway.connections).toHaveLength(0);
  });

  test("switching to battery closes the gateway, which then stays closed", async () => {
    const k = await batteryKit({ power: "ac" });
    await k.connected();
    expect(k.reads()).toHaveLength(0);
    await k.toBattery();
    await waitFor(() => k.gateway.latest!.closed);
    expect(k.daemon.gateway.state).toBe("stopped");
    expect(k.log.lines).toContain("info on battery power");
    expect(k.reads()).toHaveLength(1);
    for (let i = 0; i < 6; i++) await k.tick();
    expect(k.gateway.connections).toHaveLength(1);
    expect(k.daemon.statusCode()).toBe("connected");
    expect(k.reads()).toHaveLength(7);
  });

  test("a check hands a new owner message on once and moves the cursor; the next check finds nothing new", async () => {
    const k = await batteryKit();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    // A channel made on battery starts its cursor at its own id, so the first message in it counts.
    expect(k.daemon.cursors.get(channelId)).toBe(channelId);
    const message = k.rest.addMessage({ channelId, content: "hello from the phone" });
    await k.tick();
    expect(k.seen).toEqual([["hello from the phone", SID]]);
    expect(k.reads(channelId)[0]!.query).toBe(`?after=${channelId}&limit=100`);
    expect(k.daemon.cursors.get(channelId)).toBe(message.id);
    expect(JSON.parse(readFileSync(k.paths.cursors, "utf8"))[channelId]).toBe(message.id);
    await k.tick();
    await k.tick();
    expect(k.seen).toEqual([["hello from the phone", SID]]);
  });

  test("a message found by a check is handled like one from the gateway: inbox, listener, control words, #session-kit", async () => {
    const k = await batteryKit();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    const replies = () => k.rest.posted(channelId).map((m) => m.content);

    k.rest.addMessage({ channelId, content: "run the tests" });
    await k.tick();
    expect(k.daemon.sessions.get(SID)!.inbox).toMatchObject([{ type: "text", text: "run the tests" }]);
    expect(replies()).toContain(REPLIES.notListening);
    expect((await k.call({ op: "listen", sessionId: SID })).event).toMatchObject({ type: "text", text: "run the tests", queued: true });

    const next = k.call({ op: "listen", sessionId: SID });
    await waitFor(() => sessionFeatures(k.daemon).hub.isListening(SID));
    k.rest.addMessage({ channelId, content: "someone else", author: { id: STRANGER } });
    k.rest.addMessage({ channelId, content: "STOP" });
    await k.tick();
    expect((await next).event).toEqual({ type: "stop" });
    expect(replies()).toContain(REPLIES.stop);

    k.rest.addMessage({ channelId: k.control.id, content: "status" });
    await k.tick();
    expect(k.rest.posted(k.control.id).at(-1)!.content).toContain("1 linked session");
    expect(k.seen.map(([text]) => text)).toEqual(["run the tests", "STOP", "status"]);
  });

  test("a full page is followed by the next one, oldest first", async () => {
    const k = await batteryKit();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    const order: string[] = [];
    k.daemon.onInbound((message) => {
      if (message.author?.id === STRANGER) order.push(message.content ?? "");
    });
    const sent = Array.from({ length: PAGE_SIZE + 20 }, (_, i) =>
      k.rest.addMessage({ channelId, content: `m${i}`, author: { id: STRANGER } }),
    );
    await k.tick();
    expect(order).toEqual(sent.map((m) => m.content));
    expect(k.reads(channelId).map((r) => r.query)).toEqual([
      `?after=${channelId}&limit=100`,
      `?after=${sent[PAGE_SIZE - 1]!.id}&limit=100`,
    ]);
    expect(k.daemon.cursors.get(channelId)).toBe(sent.at(-1)!.id);
  });

  test("the first check of a channel with no cursor hands on nothing from before it", async () => {
    const k = await batteryKit({ start: false });
    const channel = k.rest.addChannel({ name: "old-chat-cli", parent_id: k.categories.cli.id });
    k.daemon.sessions.put({
      ...newSession({ sessionId: SID, surface: "cli", cwd: "/work/session-kit", transcriptPath: null, now: k.clock.now() }),
      channelId: channel.id,
      channelName: "old-chat-cli",
    });
    k.rest.addMessage({ channelId: channel.id, content: "typed last week" });
    const newest = k.rest.addMessage({ channelId: channel.id, content: "typed yesterday" });
    await k.daemon.start();
    await k.settleAll();
    expect(k.seen).toEqual([]);
    expect(k.reads(channel.id).map((r) => r.query)).toEqual(["?limit=1"]);
    expect(k.daemon.cursors.get(channel.id)).toBe(newest.id);
    // #session-kit has no messages yet: its own id is the starting point.
    expect(k.daemon.cursors.get(k.control.id)).toBe(k.control.id);
    k.rest.addMessage({ channelId: channel.id, content: "typed now" });
    k.rest.addMessage({ channelId: k.control.id, content: "status" });
    await k.tick();
    expect(k.seen).toEqual([
      ["typed now", SID],
      ["status", null],
    ]);
  });

  test("archived channels and sessions without a channel are not read", async () => {
    const k = await batteryKit();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    await k.register("bbbb0000-0000-4000-8000-000000000000");
    // Archived on Discord too: every check reads the server's channels again.
    k.rest.channels.get(channelId)!.parent_id = k.categories.archive.id;
    k.daemon.sessions.update(SID, (e) => {
      e.archived = true;
    });
    const before = k.reads(channelId).length;
    await k.tick();
    expect(k.reads(channelId)).toHaveLength(before);
    expect(k.reads().length).toBeGreaterThan(0);
  });

  test("a channel deleted by hand unlinks its session at the next check", async () => {
    const k = await batteryKit();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    k.rest.channels.delete(channelId);
    await k.tick();
    expect(k.daemon.sessions.get(SID)!.channelId).toBeNull();
    expect(k.daemon.cursors.get(channelId)).toBeUndefined();
  });

  test("Discord saying a channel is unknown while reading it unlinks its session", async () => {
    const k = await batteryKit();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    k.rest.failNext({ method: "GET", path: `/channels/${channelId}/messages`, status: 404, body: { message: "Unknown Channel", code: 10003 } });
    await k.tick();
    expect(k.daemon.sessions.get(SID)!.channelId).toBeNull();
  });

  test("channels are still made and posts still go out", async () => {
    const k = await batteryKit();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    expect(k.rest.channels.get(channelId)!.name).toBe("session-kit-caa2-cli");
    expect(k.rest.channels.get(channelId)!.parent_id).toBe(k.categories.cli.id);
    const sent = await k.cli(["send", "--session", SID, "done on battery"]);
    expect(sent.code).toBe(0);
    expect(await k.call({ op: "send", sessionId: SID, text: "and one more" })).toMatchObject({ queued: 1, online: true });
    await k.settleAll();
    expect(k.rest.posted(channelId).map((m) => m.content)).toEqual(["done on battery", "and one more"]);
    expect(k.daemon.outbox.size).toBe(0);
    k.daemon.post("control", "a notice");
    await k.settleAll();
    expect(k.rest.posted(k.control.id).map((m) => m.content)).toEqual(["a notice"]);
  });

  test("a session that posts first, on battery, gets its channel and the post", async () => {
    const k = await batteryKit();
    expect((await k.cli(["send", "--session", SID, "first post"])).code).toBe(0);
    await k.settleAll();
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    expect(k.rest.posted(channelId).map((m) => m.content)).toEqual(["first post"]);
  });

  test("the bot's own user id is read once, since no gateway says it", async () => {
    const k = await batteryKit();
    await k.tick();
    expect(k.daemon.botUserId).toBe("300000000000000003");
    expect(k.rest.requestsMatching("GET", "/users/@me")).toHaveLength(1);
  });

  test("a token Discord refuses is token-rejected, checks stop, and a reload tries again", async () => {
    const k = await batteryKit({ start: false });
    k.rest.failNext({ method: "GET", path: "/users/@me", status: 401, body: { message: "401: Unauthorized", code: 0 } });
    await k.daemon.start();
    await k.settleAll();
    expect(k.daemon.statusCode()).toBe("token-rejected");
    expect((await k.call({ op: "status" })).fix).toBe("sk-discord setup token");
    await k.tick(30 * MINUTE_MS);
    expect(k.reads()).toHaveLength(0);
    expect(k.gateway.connections).toHaveLength(0);
    expect((await k.call({ op: "reload" })).status).toBe("connected");
    await k.settleAll();
    expect(k.reads()).toHaveLength(1);
  });

  test("a bot that was removed from the server is not-in-server", async () => {
    const k = await batteryKit({ start: false });
    k.rest.failNext({ method: "GET", path: `/guilds/${GUILD_ID}/channels`, status: 403, body: { message: "Missing Access", code: 50001 } });
    await k.daemon.start();
    await k.settleAll();
    expect(k.daemon.statusCode()).toBe("not-in-server");
    await k.tick();
    expect(k.daemon.statusCode()).toBe("connected");
  });

  test("network trouble ends the check early and the next one tries again", async () => {
    const k = await batteryKit({ start: false });
    // Six 500s: the first try and the five retries, 1, 2, 4, 8 and 16 seconds apart.
    k.rest.failNext({ method: "GET", path: `/guilds/${GUILD_ID}/channels`, status: 500, times: 6 });
    await k.daemon.start();
    const stopped = () => k.log.lines.some((line) => line.startsWith("warn checking Discord stopped"));
    for (let i = 0; i < 100 && !stopped(); i++) {
      await k.clock.advance(1000);
      await Bun.sleep(2);
    }
    expect(stopped()).toBe(true);
    await k.settleAll();
    expect(k.reads()).toHaveLength(0);
    await k.tick();
    expect(k.reads()).toHaveLength(1);
  });
});

describe("between AC and battery power", () => {
  test("a gateway message moves the cursor, so the switch to battery starts right after it", async () => {
    const k = await batteryKit({ power: "ac" });
    await k.connected();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    const live = k.rest.addMessage({ channelId, content: "typed on AC" });
    k.gateway.dispatch("MESSAGE_CREATE", { ...live, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 1);
    expect(k.daemon.cursors.get(channelId)).toBe(live.id);
    await k.toBattery();
    expect(k.reads(channelId).map((r) => r.query)).toEqual([`?after=${live.id}&limit=100`]);
    k.rest.addMessage({ channelId, content: "typed on battery" });
    await k.tick();
    expect(k.seen).toEqual([
      ["typed on AC", SID],
      ["typed on battery", SID],
    ]);
  });

  test("switching to AC reconnects the gateway, catches up once and stops checking", async () => {
    const k = await batteryKit();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    await k.tick();
    k.rest.addMessage({ channelId, content: "typed on the way home" });
    await k.toAc();
    expect(k.gateway.connections).toHaveLength(1);
    expect(k.seen).toEqual([["typed on the way home", SID]]);
    expect(k.log.lines).toContain("info on AC power");
    const reads = k.reads().length;
    await k.tick(30 * MINUTE_MS);
    expect(k.reads()).toHaveLength(reads);
    expect((await k.call({ op: "status" })).onBattery).toBeUndefined();
  });

  test("a message the gateway handled is not handed on again by a catch-up that overlaps it", async () => {
    const k = await batteryKit();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    await k.tick();
    k.rest.addMessage({ channelId, content: "typed between checks" });
    // The catch-up's read of the channel fails once and waits a second, so the gateway gets there first.
    k.rest.failNext({ method: "GET", path: `/channels/${channelId}/messages`, status: 500 });
    const before = k.reads(channelId).length;
    k.power.output = AC_OUTPUT;
    await k.clock.advance(MINUTE_MS);
    await waitFor(() => k.daemon.gateway.state === "connected");
    await waitFor(() => k.reads(channelId).length === before + 1);
    await waitFor(() => k.clock.nextDue === k.clock.now() + 1000);
    const live = k.rest.addMessage({ channelId, content: "typed live" });
    k.gateway.dispatch("MESSAGE_CREATE", { ...live, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 1);
    await k.tick(1000);
    expect(k.reads(channelId)).toHaveLength(before + 2);
    expect(k.seen).toEqual([
      ["typed live", SID],
      ["typed between checks", SID],
    ]);
  });

  test("a new gateway session forgets the cursors, so a message it missed isn't handed on later", async () => {
    const k = await batteryKit({ power: "ac" });
    await k.connected();
    await k.startChat(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    const first = k.rest.addMessage({ channelId, content: "seen live" });
    k.gateway.dispatch("MESSAGE_CREATE", { ...first, guild_id: GUILD_ID });
    await waitFor(() => k.seen.length === 1);
    // The connection ends in a way that can't be resumed; Discord gives the new one a new session.
    k.gateway.closeLatest(4009);
    await waitFor(() => k.daemon.gateway.state === "connecting");
    k.rest.addMessage({ channelId, content: "typed while the gateway was away" });
    await k.clock.advance(1000);
    await waitFor(() => k.gateway.connections.length === 2 && k.daemon.gateway.state === "connected");
    expect(k.daemon.cursors.get(channelId)).toBeUndefined();
    await k.toBattery();
    k.rest.addMessage({ channelId, content: "typed on battery" });
    await k.tick();
    expect(k.seen).toEqual([
      ["seen live", SID],
      ["typed on battery", SID],
    ]);
  });

  test("the cursors survive a restart on battery, and what came in meanwhile is handed on", async () => {
    const first = await batteryKit();
    await first.startChat(SID);
    const kept = first.daemon.sessions.get(SID)!.channelId!;
    await first.tick();
    await first.daemon.stop();
    const cursor = first.daemon.cursors.get(kept)!;
    expect(cursor).toBe(kept);

    const second = await batteryKit({ home: first.home, start: false });
    second.rest.addChannel({ id: kept, name: "session-kit-caa2-cli", parent_id: second.categories.cli.id });
    second.setConfig((c) => {
      c.categories = {
        desktop: second.categories.desktop.id,
        vs: second.categories.vs.id,
        cli: second.categories.cli.id,
        archive: second.categories.archive.id,
      };
    });
    second.rest.addMessage({ id: String(BigInt(cursor) + 1000n), channelId: kept, content: "typed while it restarted" });
    await second.daemon.start();
    await second.settleAll();
    expect(second.seen).toEqual([["typed while it restarted", SID]]);
  });
});

describe("Discord off or not set up", () => {
  test("with Discord off nothing is read and pmset isn't run", async () => {
    const k = await batteryKit({ enabled: false });
    await k.tick(30 * MINUTE_MS);
    expect(k.reads()).toHaveLength(0);
    expect(k.runner.commands.filter((c) => c.includes("pmset"))).toEqual([]);
    expect(k.daemon.statusCode()).toBe("off");
  });

  test("with no token nothing is read", async () => {
    const k = await batteryKit({ token: null });
    await k.tick(30 * MINUTE_MS);
    expect(k.reads()).toHaveLength(0);
    expect(k.daemon.statusCode()).toBe("no-token");
  });

  test("turning Discord off on battery stops the checks and forgets the cursors", async () => {
    const k = await batteryKit();
    expect(k.daemon.cursors.get(k.control.id)).toBe(k.control.id);
    k.setConfig((c) => {
      c.enabled = false;
    });
    expect(await k.call({ op: "reload" })).toMatchObject({ status: "off" });
    const reads = k.reads().length;
    await k.tick(30 * MINUTE_MS);
    expect(k.reads()).toHaveLength(reads);
    expect(k.daemon.cursors.get(k.control.id)).toBeUndefined();
    expect(k.gateway.connections).toHaveLength(0);
    expect((await k.call({ op: "status" })).onBattery).toBeUndefined();
  });

  test("a power switch while Discord is off connects nothing", async () => {
    const k = await batteryKit({ power: "ac" });
    await k.connected();
    k.setConfig((c) => {
      c.enabled = false;
    });
    await k.call({ op: "reload" });
    await waitFor(() => k.gateway.latest!.closed);
    k.power.output = BATTERY_OUTPUT;
    await k.tick(MINUTE_MS);
    k.power.output = AC_OUTPUT;
    await k.tick(MINUTE_MS);
    expect(k.reads()).toHaveLength(0);
    expect(k.gateway.connections).toHaveLength(1);
  });
});
