import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RestClient } from "../src/discord/rest.ts";
import { memoryLogger } from "../src/log.ts";
import { Outbox, type OutboxEntry, OUTBOX_MAX_AGE_MS, formatTime } from "../src/outbound.ts";
import { FakeClock } from "./fakes/fake-clock.ts";
import { type FakeChannel, FakeDiscordRest } from "./fakes/fake-rest.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { waitFor } from "./helpers/wait.ts";

const HOUR = 3_600_000;
const TOKEN = "FAKE00000000000000000000.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";

let fake: FakeDiscordRest | undefined;
afterEach(() => {
  fake?.stop();
  fake = undefined;
});

interface Kit {
  clock: FakeClock;
  outbox: Outbox;
  file: string;
  control: FakeChannel;
  channels: Map<string, string>;
  unknown: string[];
  postedEvents: { sessionId: string | null; channelId: string }[];
  log: ReturnType<typeof memoryLogger>;
}

async function setup(o: { file?: string; clock?: FakeClock; fetch?: typeof fetch } = {}): Promise<Kit & { fake: FakeDiscordRest }> {
  fake ??= await FakeDiscordRest.start();
  const server = fake;
  const clock = o.clock ?? new FakeClock();
  const log = memoryLogger();
  const rest = new RestClient({
    baseUrl: server.baseUrl,
    token: () => TOKEN,
    clock,
    log,
    maxRetries: 1,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const control = server.channelNamed("session-kit") ?? server.addChannel({ name: "session-kit" });
  const channels = new Map<string, string>();
  const unknown: string[] = [];
  const postedEvents: { sessionId: string | null; channelId: string }[] = [];
  const file = o.file ?? `${tmpDir()}/outbox.jsonl`;
  const outbox = new Outbox({
    file,
    clock,
    log,
    rest,
    controlChannelId: () => control.id,
    resolveChannel: async (entry) => {
      if (entry.target === "control") return control.id;
      return channels.get(entry.target) ?? null;
    },
    onUnknownChannel: (entry) => {
      unknown.push(entry.target);
      channels.set(entry.target, server.addChannel({ name: "remade" }).id);
    },
    onPosted: (entry, channelId) => postedEvents.push({ sessionId: entry.target === "control" ? null : entry.target, channelId }),
  });
  return { clock, outbox, file, control, channels, unknown, postedEvents, log, fake: server };
}

function post(target: string, content: string): Omit<OutboxEntry, "id" | "at"> {
  return { target, content, allowedMentions: { parse: [] } };
}

describe("Outbox", () => {
  test("posts queue while offline and go out in order on reconnect", async () => {
    const kit = await setup();
    const fake = kit.fake;
    const channel = fake.addChannel({ name: "work-cli" });
    kit.channels.set("s1", channel.id);
    kit.outbox.enqueue([post("s1", "one"), post("s1", "two")]);
    kit.outbox.enqueue([post("s1", "three")]);
    await kit.outbox.idle();
    expect(fake.requests).toHaveLength(0);
    expect(kit.outbox.size).toBe(3);
    expect(readFileSync(kit.file, "utf8").trim().split("\n")).toHaveLength(3);

    kit.outbox.setOnline(true);
    await kit.outbox.idle();
    expect(fake.posted(channel.id).map((m) => m.content)).toEqual(["one", "two", "three"]);
    expect(kit.outbox.size).toBe(0);
    expect(readFileSync(kit.file, "utf8")).toBe("");
    expect(kit.postedEvents).toEqual([
      { sessionId: "s1", channelId: channel.id },
      { sessionId: "s1", channelId: channel.id },
      { sessionId: "s1", channelId: channel.id },
    ]);
  });

  test("what was queued before a restart is sent after it", async () => {
    const file = `${tmpDir()}/outbox.jsonl`;
    const first = await setup({ file });
    const fake = first.fake;
    const channel = fake.addChannel({ name: "work-cli" });
    first.outbox.enqueue([post("s1", "kept across a restart")]);
    await first.outbox.idle();
    first.outbox.close();

    const second = await setup({ file, clock: first.clock });
    second.channels.set("s1", channel.id);
    expect(second.outbox.size).toBe(1);
    second.outbox.setOnline(true);
    await second.outbox.idle();
    expect(fake.posted(channel.id).map((m) => m.content)).toEqual(["kept across a restart"]);
  });

  test("entries over 24 hours old are dropped, with one notice in the control channel", async () => {
    const kit = await setup();
    const fake = kit.fake;
    const channel = fake.addChannel({ name: "work-cli" });
    kit.channels.set("s1", channel.id);
    const start = kit.clock.now();
    kit.outbox.enqueue([post("s1", "stale one")]);
    await kit.clock.advance(HOUR);
    kit.outbox.enqueue([post("s1", "stale two")]);
    await kit.clock.advance(2 * HOUR);
    kit.outbox.enqueue([post("s1", "fresh")]);
    await kit.clock.advance(OUTBOX_MAX_AGE_MS - 2 * HOUR + 1); // the first two are now past 24 hours

    kit.outbox.setOnline(true);
    await kit.outbox.idle();
    expect(fake.posted(channel.id).map((m) => m.content)).toEqual(["fresh"]);
    const notices = fake.posted(kit.control.id).map((m) => m.content);
    expect(notices).toEqual([
      `2 posts from ${formatTime(start)} to ${formatTime(start + HOUR)} were dropped while offline.`,
    ]);
    expect(fake.posted(kit.control.id)[0]!.allowed_mentions).toEqual({ parse: [] });

    // Reconnecting again sends no second notice.
    kit.outbox.setOnline(false);
    kit.outbox.setOnline(true);
    await kit.outbox.idle();
    expect(fake.posted(kit.control.id)).toHaveLength(1);
  });

  test("one dropped post gets a singular notice", async () => {
    const kit = await setup();
    const fake = kit.fake;
    kit.channels.set("s1", fake.addChannel({ name: "work-cli" }).id);
    const start = kit.clock.now();
    kit.outbox.enqueue([post("s1", "old")]);
    await kit.clock.advance(OUTBOX_MAX_AGE_MS + 1);
    kit.outbox.setOnline(true);
    await kit.outbox.idle();
    expect(fake.posted(kit.control.id).map((m) => m.content)).toEqual([
      `1 post from ${formatTime(start)} was dropped while offline.`,
    ]);
  });

  test("a post Discord refuses (403) is dropped and the rest still go", async () => {
    const kit = await setup();
    const fake = kit.fake;
    const channel = fake.addChannel({ name: "work-cli" });
    kit.channels.set("s1", channel.id);
    fake.failNext({ path: `/channels/${channel.id}/messages`, status: 403, body: { code: 50001, message: "Missing Access" } });
    kit.outbox.enqueue([post("s1", "refused"), post("s1", "accepted")]);
    kit.outbox.setOnline(true);
    await kit.outbox.idle();
    expect(fake.posted(channel.id).map((m) => m.content)).toEqual(["accepted"]);
    expect(kit.outbox.size).toBe(0);
  });

  test("a deleted channel unlinks the session and the post goes to its new channel", async () => {
    const kit = await setup();
    const fake = kit.fake;
    const channel = fake.addChannel({ name: "work-cli" });
    kit.channels.set("s1", channel.id);
    fake.channels.delete(channel.id);
    kit.outbox.enqueue([post("s1", "after the delete")]);
    kit.outbox.setOnline(true);
    await kit.outbox.idle();
    expect(kit.unknown).toEqual(["s1"]);
    expect(fake.posted(kit.channels.get("s1")!).map((m) => m.content)).toEqual(["after the delete"]);
  });

  test("a post for a session with no channel to resolve is dropped", async () => {
    const kit = await setup();
    const fake = kit.fake;
    kit.outbox.enqueue([post("gone", "nowhere to go")]);
    kit.outbox.setOnline(true);
    await kit.outbox.idle();
    expect(kit.outbox.size).toBe(0);
    expect(fake.posted()).toHaveLength(0);
  });

  test("a network failure while online keeps the post at the front and tries again later, in order", async () => {
    let down = true;
    const flaky = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (down) return Promise.reject(new TypeError("fetch failed"));
      return fetch(input, init);
    }) as typeof fetch;
    const kit = await setup({ fetch: flaky });
    const fake = kit.fake;
    const channel = fake.addChannel({ name: "work-cli" });
    kit.channels.set("s1", channel.id);
    kit.outbox.enqueue([post("s1", "first"), post("s1", "second")]);
    kit.outbox.setOnline(true);
    await waitFor(() => kit.clock.pending === 1); // the client's one retry
    await kit.clock.advance(1000);
    await waitFor(() => kit.clock.pending === 1); // the outbox's own wait
    expect(kit.outbox.size).toBe(2);
    down = false;
    await kit.clock.advance(60_000);
    await kit.outbox.idle();
    expect(fake.posted(channel.id).map((m) => m.content)).toEqual(["first", "second"]);
  });

  test("an unreadable line in the file is skipped", async () => {
    const file = `${tmpDir()}/discord/outbox.jsonl`;
    mkdirSync(dirname(file), { recursive: true });
    const good: OutboxEntry = { id: "a1", at: Date.now(), target: "s1", content: "good", allowedMentions: { parse: [] } };
    writeFileSync(file, `{ broken\n${JSON.stringify(good)}\n`);
    const kit = await setup({ file, clock: new FakeClock(Date.now()) });
    expect(kit.outbox.size).toBe(1);
    expect(existsSync(file)).toBe(true);
  });
});
