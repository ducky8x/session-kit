import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RestClient } from "../src/discord/rest.ts";
import { memoryLogger } from "../src/log.ts";
import { HOLD_CHECK_MS, Outbox, type OutboxEntry, OUTBOX_MAX_AGE_MS, formatTime } from "../src/outbound.ts";
import { Presence } from "../src/presence.ts";
import { FakeClock } from "./fakes/fake-clock.ts";
import { type FakeIdle, fakeIdle } from "./fakes/fake-idle.ts";
import { FakeProcessRunner } from "./fakes/fake-process.ts";
import { type FakeChannel, FakeDiscordRest } from "./fakes/fake-rest.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { waitFor } from "./helpers/wait.ts";

const MINUTE = 60_000;
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
  /** The user's keyboard and mouse, as ioreg reports them. */
  idle: FakeIdle;
  /** Open items still waiting for the user, by key. */
  open: Set<string>;
  released: string[];
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
  const runner = new FakeProcessRunner();
  // Until a test says otherwise, the user has been away for an hour.
  const idle = fakeIdle(runner, clock);
  idle.idleFor(HOUR);
  const presence = new Presence({ runner, clock, log });
  const open = new Set<string>();
  const released: string[] = [];
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
    readIdle: () => presence.read(),
    awayMs: () => 5 * MINUTE,
    isOpen: async (entry) => open.has(entry.open!),
    onReleased: (entry) => void released.push(entry.content),
  });
  return { clock, outbox, file, control, channels, unknown, postedEvents, log, idle, open, released, fake: server };
}

function post(target: string, content: string): Omit<OutboxEntry, "id" | "at"> {
  return { target, content };
}

/** A post that waits while the user is at the computer. */
function held(target: string, content: string, open?: string): Omit<OutboxEntry, "id" | "at"> {
  return { target, content, held: true, ...(open === undefined ? {} : { open }) };
}

/** Let time pass and wait for what it started. */
async function pass(kit: Kit, ms: number): Promise<void> {
  await kit.clock.advance(ms);
  await kit.outbox.idle();
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
    const good: OutboxEntry = { id: "a1", at: Date.now(), target: "s1", content: "good" };
    writeFileSync(file, `{ broken\n${JSON.stringify(good)}\n`);
    const kit = await setup({ file, clock: new FakeClock(Date.now()) });
    expect(kit.outbox.size).toBe(1);
    expect(existsSync(file)).toBe(true);
  });

  test("an entry an older helper queued with an @mention loses the mention, and goes out with parse: []", async () => {
    const file = `${tmpDir()}/discord/outbox.jsonl`;
    mkdirSync(dirname(file), { recursive: true });
    const now = Date.now();
    const old = [
      { id: "a1", at: now, target: "s1", content: "<@123456789012345678> Claude needs your permission", allowedMentions: { parse: [], users: ["123456789012345678"] } },
      { id: "a2", at: now, target: "s1", content: "plain, with <@42> typed by the session", allowedMentions: { parse: [] } },
    ];
    writeFileSync(file, old.map((e) => `${JSON.stringify(e)}\n`).join(""));
    const kit = await setup({ file, clock: new FakeClock(now) });
    const channel = kit.fake.addChannel({ name: "work-cli" });
    kit.channels.set("s1", channel.id);
    kit.outbox.setOnline(true);
    await kit.outbox.idle();
    expect(kit.fake.posted(channel.id).map((m) => [m.content, m.allowed_mentions])).toEqual([
      ["Claude needs your permission", { parse: [] }],
      ["plain, with <@42> typed by the session", { parse: [] }],
    ]);
  });
});

describe("Outbox holding posts while the user is at the computer", () => {
  async function online() {
    const kit = await setup();
    const channel = kit.fake.addChannel({ name: "work-cli" });
    kit.channels.set("s1", channel.id);
    kit.outbox.setOnline(true);
    const sent = () => kit.fake.posted(channel.id).map((m) => m.content);
    return { ...kit, channel, sent };
  }

  test("a held post made after 5 minutes without input goes out at once", async () => {
    const kit = await online();
    kit.idle.idleFor(5 * MINUTE);
    kit.outbox.enqueue([held("s1", "away already")]);
    await kit.outbox.idle();
    expect(kit.sent()).toEqual(["away already"]);
    expect(kit.outbox.size).toBe(0);
    expect(kit.released).toEqual(["away already"]);
  });

  test("a post made while the user is active waits, then goes at the first check after 5 idle minutes", async () => {
    const kit = await online();
    kit.idle.touch();
    const [entry] = kit.outbox.enqueue([held("s1", "finished the build")]);
    await kit.outbox.idle();
    expect(kit.sent()).toEqual([]);
    expect(kit.outbox.heldCount).toBe(1);
    expect(entry).toMatchObject({ held: true, madeAt: kit.clock.now(), inputAt: kit.clock.now() });
    expect(HOLD_CHECK_MS).toBe(30_000);
    await pass(kit, 5 * MINUTE - 1);
    expect(kit.sent()).toEqual([]);
    await pass(kit, 1);
    expect(kit.sent()).toEqual(["finished the build"]);
    expect(kit.outbox.size).toBe(0);
    // Nothing is held, so ioreg is no longer read.
    const reads = kit.idle.reads();
    await pass(kit, 10 * MINUTE);
    expect(kit.idle.reads()).toBe(reads);
  });

  test("a held post is dropped, with one debug line, once the user uses the computer after it was made", async () => {
    const kit = await online();
    kit.idle.touch();
    kit.outbox.enqueue([held("s1", "done with step 1")]);
    await pass(kit, 10_000);
    kit.idle.touch();
    await pass(kit, 20_000);
    expect(kit.outbox.size).toBe(0);
    expect(kit.log.lines.filter((l) => l.startsWith("debug"))).toEqual([expect.stringMatching(/^debug dropped held post \S+: the user was at the computer$/)]);
    await pass(kit, HOUR);
    expect(kit.sent()).toEqual([]);
    expect(kit.released).toEqual([]);
  });

  test("held posts keep their order; a post that isn't held goes out at once", async () => {
    const kit = await online();
    kit.idle.touch();
    kit.outbox.enqueue([held("s1", "first")]);
    await pass(kit, MINUTE);
    kit.outbox.enqueue([held("s1", "second, in two"), held("s1", "pieces")]);
    kit.outbox.enqueue([post("s1", "a reply")]);
    await kit.outbox.idle();
    expect(kit.sent()).toEqual(["a reply"]);
    await pass(kit, 4 * MINUTE);
    expect(kit.sent()).toEqual(["a reply", "first", "second, in two", "pieces"]);
  });

  test("of the held posts, those made before the user's last input are dropped and later ones go", async () => {
    const kit = await online();
    kit.idle.touch();
    kit.outbox.enqueue([held("s1", "made while active")]);
    await pass(kit, 10_000);
    kit.idle.touch();
    await pass(kit, 10_000);
    kit.outbox.enqueue([held("s1", "made after the last input")]);
    await pass(kit, 10_000);
    expect(kit.outbox.size).toBe(1);
    // Five minutes after the last input, at 5:10, the next check (5:30) sends it.
    await pass(kit, 4 * MINUTE + 50_000);
    expect(kit.sent()).toEqual([]);
    await pass(kit, 10_000);
    expect(kit.sent()).toEqual(["made after the last input"]);
  });

  test("an unknown idle time counts as away", async () => {
    const kit = await online();
    kit.idle.touch();
    kit.outbox.enqueue([held("s1", "held")]);
    await kit.outbox.idle();
    expect(kit.sent()).toEqual([]);
    kit.idle.state.result = "failed";
    await pass(kit, HOLD_CHECK_MS);
    expect(kit.sent()).toEqual(["held"]);
    kit.idle.state.result = "unreadable";
    kit.outbox.enqueue([held("s1", "unreadable")]);
    await kit.outbox.idle();
    expect(kit.sent()).toEqual(["held", "unreadable"]);
  });

  test("an open item isn't dropped for activity: it goes out the first time the user is away, while still open", async () => {
    const kit = await online();
    kit.open.add("question:s1:q1");
    kit.idle.touch();
    kit.outbox.enqueue([held("s1", "the question", "question:s1:q1")]);
    for (let i = 0; i < 20; i++) {
      await pass(kit, MINUTE);
      kit.idle.touch();
    }
    expect(kit.sent()).toEqual([]);
    expect(kit.outbox.heldCount).toBe(1);
    await pass(kit, 5 * MINUTE);
    expect(kit.sent()).toEqual(["the question"]);
  });

  test("an open item settled meanwhile is dropped when the user is away, and never sent", async () => {
    const kit = await online();
    kit.open.add("prompt:s1");
    kit.idle.touch();
    kit.outbox.enqueue([held("s1", "Claude needs your permission", "prompt:s1")]);
    await pass(kit, MINUTE);
    kit.open.delete("prompt:s1");
    await pass(kit, 5 * MINUTE);
    expect(kit.sent()).toEqual([]);
    expect(kit.outbox.size).toBe(0);
  });

  test("discardHeld drops matching held posts at once", async () => {
    const kit = await online();
    kit.idle.touch();
    kit.outbox.enqueue([held("s1", "keep"), held("s1", "settled", "prompt:s1")]);
    await kit.outbox.idle();
    expect(kit.outbox.discardHeld((e) => e.open === "prompt:s1")).toBe(1);
    expect(kit.outbox.heldCount).toBe(1);
    await pass(kit, 5 * MINUTE);
    expect(kit.sent()).toEqual(["keep"]);
  });

  test("held posts survive a restart, keep their order, and still drop on input made while the helper was down", async () => {
    const file = `${tmpDir()}/outbox.jsonl`;
    const first = await setup({ file });
    first.idle.touch();
    first.outbox.enqueue([held("s1", "one"), held("s1", "two")]);
    await first.outbox.idle();
    first.outbox.close();

    const second = await setup({ file, clock: first.clock });
    const channel = second.fake.addChannel({ name: "work-cli" });
    second.channels.set("s1", channel.id);
    second.idle.state.lastInputAt = first.idle.state.lastInputAt;
    expect(second.outbox.heldCount).toBe(2);
    second.outbox.setOnline(true);
    second.outbox.recheck();
    await second.outbox.idle();
    expect(second.fake.posted(channel.id)).toHaveLength(0);
    await pass(second, 5 * MINUTE);
    expect(second.fake.posted(channel.id).map((m) => m.content)).toEqual(["one", "two"]);

    const third = await setup({ file: `${tmpDir()}/outbox.jsonl`, clock: first.clock });
    third.idle.touch();
    third.outbox.enqueue([held("s1", "made before a restart")]);
    await third.outbox.idle();
    third.outbox.close();
    await first.clock.advance(MINUTE);
    const fourth = await setup({ file: third.file, clock: first.clock });
    fourth.idle.touch(); // input while no helper ran
    fourth.outbox.recheck();
    await fourth.outbox.idle();
    expect(fourth.outbox.size).toBe(0);
  });

  test("the notice about dropped posts is held too while the user is at the computer", async () => {
    const kit = await setup();
    kit.channels.set("s1", kit.fake.addChannel({ name: "work-cli" }).id);
    kit.outbox.enqueue([post("s1", "old")]);
    await kit.clock.advance(OUTBOX_MAX_AGE_MS + 1);
    kit.idle.touch();
    kit.outbox.setOnline(true);
    await kit.outbox.idle();
    expect(kit.fake.posted(kit.control.id)).toHaveLength(0);
    expect(kit.outbox.heldCount).toBe(1);
    await pass(kit, 5 * MINUTE);
    expect(kit.fake.posted(kit.control.id).map((m) => m.content)).toEqual([expect.stringMatching(/^1 post from .* was dropped while offline\.$/)]);
  });

  test("a post held for longer than 24 hours (an open item) isn't counted as dropped while offline", async () => {
    const kit = await online();
    kit.open.add("question:s1:q1");
    kit.idle.touch();
    kit.outbox.enqueue([held("s1", "the question", "question:s1:q1")]);
    for (let i = 0; i < 26; i++) {
      await pass(kit, HOUR);
      kit.idle.touch();
    }
    await pass(kit, 5 * MINUTE);
    expect(kit.sent()).toEqual(["the question"]);
    expect(kit.fake.posted(kit.control.id)).toHaveLength(0);
  });
});
