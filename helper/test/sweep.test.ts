import { describe, expect, test } from "bun:test";
import { DAY_MS, DEFAULT_TIMING, sweepEveryMs, timingFromEnv } from "../src/channels.ts";
import { BOT_ID, GUILD_ID, OWNER_ID } from "./fakes/fake-rest.ts";
import { SID, channelKit } from "./helpers/channel-kit.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function withSession() {
  const k = await channelKit();
  await k.channels.reconcile();
  await k.channels.register({ sessionId: SID, source: "startup", cwd: "/work/session-kit", transcriptPath: null, entrypoint: "cli" });
  await k.channels.ensureChannel(SID);
  const channelId = k.sessions.get(SID)!.channelId!;
  return { ...k, channelId };
}

function message(channelId: string, authorId: string, bot = false) {
  return { id: "1", channel_id: channelId, guild_id: GUILD_ID, author: { id: authorId, bot }, content: "hello" };
}

describe("sweep", () => {
  test("7 days and 1 minute without messages moves the channel to Archive", async () => {
    const k = await withSession();
    await k.clock.advance(7 * DAY_MS - MINUTE);
    await k.channels.sweep();
    expect(k.fake.channels.get(k.channelId)!.parent_id).toBe(k.categories.cli.id);
    await k.clock.advance(2 * MINUTE);
    await k.channels.sweep();
    expect(k.fake.channels.get(k.channelId)!.parent_id).toBe(k.categories.archive.id);
    expect(k.sessions.get(SID)!.archived).toBe(true);
    // Sweeping again does nothing more.
    const writes = k.writes().length;
    await k.channels.sweep();
    expect(k.writes()).toHaveLength(writes);
  });

  test("30 days without messages deletes the channel and the session entry", async () => {
    const k = await withSession();
    await k.clock.advance(7 * DAY_MS + MINUTE);
    await k.channels.sweep();
    await k.clock.advance(23 * DAY_MS);
    await k.channels.sweep();
    expect(k.fake.channels.has(k.channelId)).toBe(false);
    expect(k.sessions.get(SID)).toBeUndefined();
    expect(k.fake.requestsMatching("DELETE", `/channels/${k.channelId}`)).toHaveLength(1);
  });

  test("an open session that stays quiet is archived all the same", async () => {
    const k = await withSession();
    expect(k.sessions.get(SID)!.closedAt).toBeNull();
    await k.clock.advance(7 * DAY_MS + MINUTE);
    await k.channels.sweep();
    expect(k.sessions.get(SID)!.archived).toBe(true);
  });

  test("a message from the bot or the owner resets the timers; one from anyone else does not", async () => {
    const k = await withSession();
    const who = { ownerId: OWNER_ID, botId: BOT_ID };
    await k.clock.advance(5 * DAY_MS);
    await k.channels.noteMessage(message(k.channelId, BOT_ID, true), who);
    await k.clock.advance(3 * DAY_MS);
    await k.channels.sweep();
    expect(k.sessions.get(SID)!.archived).toBe(false);
    await k.channels.noteMessage(message(k.channelId, "999999999999999999"), who);
    await k.clock.advance(4 * DAY_MS + MINUTE);
    await k.channels.sweep();
    expect(k.sessions.get(SID)!.archived).toBe(true);
  });

  test("an owner message in an archived channel moves it back before it is handed on", async () => {
    const k = await withSession();
    await k.clock.advance(7 * DAY_MS + MINUTE);
    await k.channels.sweep();
    expect(k.sessions.get(SID)!.archived).toBe(true);
    const entry = await k.channels.noteMessage(message(k.channelId, OWNER_ID), { ownerId: OWNER_ID, botId: BOT_ID });
    // By the time noteMessage returns (and the message is delivered), the channel is back.
    expect(entry?.sessionId).toBe(SID);
    expect(k.fake.channels.get(k.channelId)!.parent_id).toBe(k.categories.cli.id);
    expect(k.sessions.get(SID)).toMatchObject({ archived: false, lastMessageAt: k.clock.now() });
    const moves = k.fake.requestsMatching("PATCH", `/channels/${k.channelId}`).map((r) => r.body.parent_id);
    expect(moves).toEqual([k.categories.archive.id, k.categories.cli.id]);
  });

  test("a post to an archived session moves the channel back first", async () => {
    const k = await withSession();
    await k.clock.advance(7 * DAY_MS + MINUTE);
    await k.channels.sweep();
    expect(await k.channels.ensureChannel(SID)).toBe(k.channelId);
    expect(k.fake.channels.get(k.channelId)!.parent_id).toBe(k.categories.cli.id);
    expect(k.sessions.get(SID)!.archived).toBe(false);
  });

  test("runs on its own every hour once started", async () => {
    const k = await withSession();
    k.channels.startSweeper();
    await k.clock.advance(7 * DAY_MS + HOUR);
    await k.channels.settle();
    expect(k.sessions.get(SID)!.archived).toBe(true);
    k.channels.stop();
  });

  test("a full Archive gets an Archive 2", async () => {
    const k = await withSession();
    for (let i = 0; i < 50; i++) k.fake.addChannel({ name: `old-${i}`, parent_id: k.categories.archive.id });
    await k.channels.reconcile();
    await k.clock.advance(7 * DAY_MS + MINUTE);
    await k.channels.sweep();
    const overflow = k.fake.channelNamed("Archive 2")!;
    expect(k.fake.channels.get(k.channelId)!.parent_id).toBe(overflow.id);
    expect(k.config().categories["archive-2"]).toBe(overflow.id);
  });
});

describe("timing", () => {
  test("defaults to 7 days to Archive and 30 to delete, swept hourly", () => {
    expect(DEFAULT_TIMING.archiveMs).toBe(7 * DAY_MS);
    expect(DEFAULT_TIMING.deleteMs).toBe(30 * DAY_MS);
    expect(sweepEveryMs(DEFAULT_TIMING)).toBe(HOUR);
  });

  test("SK_DISCORD_ARCHIVE_DAYS and SK_DISCORD_DELETE_DAYS shorten them, and the sweep keeps up", () => {
    const timing = timingFromEnv({ SK_DISCORD_ARCHIVE_DAYS: "0.01", SK_DISCORD_DELETE_DAYS: "0.02" });
    expect(timing.archiveMs).toBe(0.01 * DAY_MS);
    expect(timing.deleteMs).toBe(0.02 * DAY_MS);
    expect(sweepEveryMs(timing)).toBe(timing.archiveMs / 10);
    expect(timingFromEnv({ SK_DISCORD_ARCHIVE_DAYS: "nope", SK_DISCORD_DELETE_DAYS: "-3" })).toEqual(DEFAULT_TIMING);
  });
});
