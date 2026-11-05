import { describe, expect, test } from "bun:test";
import { RENAME_SPACING_MS, SERVER_SOFT_LIMIT } from "../src/channels.ts";
import { GUILD_ID } from "./fakes/fake-rest.ts";
import { type ChannelKit, SID, channelKit } from "./helpers/channel-kit.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function startup(sessionId = SID, entrypoint = "claude-desktop", source = "startup", cwd = "/work/session-kit") {
  return { sessionId, source, cwd, transcriptPath: null, entrypoint };
}

/** A session that started and whose chat got under way (its first prompt, or its first turn ended). */
async function open(k: ChannelKit, input: ReturnType<typeof startup>) {
  await k.channels.register(input);
  await k.channels.ensureChannel(input.sessionId);
  return k.channels.describe(input.sessionId);
}

describe("registering sessions", () => {
  test("startup records the session but makes no channel", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    const result = await k.channels.register(startup());
    expect(result).toEqual({ registered: true, channelName: "session-kit-caa2-desktop", category: "Desktop", pending: true, linked: false });
    expect(k.writes()).toHaveLength(0);
    expect(k.sessions.get(SID)).toMatchObject({ surface: "desktop", cwd: "/work/session-kit", channelId: null });
  });

  test("the chat starting makes one channel in its surface's category, with the topic", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await k.channels.register(startup());
    k.channels.activate(SID);
    await k.channels.settle();
    const posts = k.fake.requestsMatching("POST", `/guilds/${GUILD_ID}/channels`);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      name: "session-kit-caa2-desktop",
      type: 0,
      parent_id: k.categories.desktop.id,
      topic: `session ${SID} · desktop · session-kit`,
    });
    const entry = k.sessions.get(SID)!;
    expect(entry).toMatchObject({ surface: "desktop", cwd: "/work/session-kit", channelName: "session-kit-caa2-desktop" });
    expect(k.fake.channels.get(entry.channelId!)?.parent_id).toBe(k.categories.desktop.id);
    expect(k.channels.describe(SID)).toEqual({
      registered: true,
      channelName: "session-kit-caa2-desktop",
      category: "Desktop",
      pending: false,
      linked: true,
    });
    // Later prompts and turns change nothing.
    k.channels.activate(SID);
    await k.channels.settle();
    expect(k.fake.requestsMatching("POST", `/guilds/${GUILD_ID}/channels`)).toHaveLength(1);
  });

  test("a session that never starts a chat never gets a channel", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await k.channels.register(startup("ecbc0000", "cli"));
    k.channels.ended("ecbc0000");
    await k.channels.settle();
    expect(k.writes()).toHaveLength(0);
    await k.clock.advance(31 * DAY);
    await k.channels.sweep();
    expect(k.sessions.get("ecbc0000")).toBeUndefined();
    expect(k.writes()).toHaveLength(0);
  });

  test("activating a session the helper doesn't know does nothing", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    k.channels.activate("never-registered");
    await k.channels.settle();
    expect(k.writes()).toHaveLength(0);
    expect(k.sessions.ids()).toEqual([]);
  });

  test("each surface goes to its own category", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    expect((await open(k, startup("aaaa0000", "claude-vscode"))).category).toBe("VS Code");
    expect((await open(k, startup("bbbb0000", "cli"))).category).toBe("CLI");
    expect(k.fake.channelNamed("session-kit-aaaa-vs")?.parent_id).toBe(k.categories.vs.id);
    expect(k.fake.channelNamed("session-kit-bbbb-cli")?.parent_id).toBe(k.categories.cli.id);
  });

  test("resume reuses the channel, and the resumed chat brings it out of Archive", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await open(k, startup());
    const channelId = k.sessions.get(SID)!.channelId!;
    k.channels.ended(SID);
    expect(k.sessions.get(SID)!.closedAt).not.toBeNull();
    const again = await k.channels.register(startup(SID, "claude-desktop", "resume"));
    expect(again).toMatchObject({ channelName: "session-kit-caa2-desktop", pending: false, linked: true });
    expect(k.sessions.get(SID)!.closedAt).toBeNull();
    k.channels.activate(SID);
    await k.channels.settle();
    expect(k.fake.requestsMatching("POST", `/guilds/${GUILD_ID}/channels`)).toHaveLength(1);

    k.fake.channels.get(channelId)!.parent_id = k.categories.archive.id;
    k.sessions.update(SID, (e) => {
      e.archived = true;
    });
    await k.channels.register(startup(SID, "claude-desktop", "resume"));
    expect(k.fake.channels.get(channelId)!.parent_id).toBe(k.categories.archive.id);
    k.channels.activate(SID);
    await k.channels.settle();
    expect(k.fake.channels.get(channelId)!.parent_id).toBe(k.categories.desktop.id);
    expect(k.sessions.get(SID)!.archived).toBe(false);
  });

  test("new session ids with nothing linking them to another chat get channels of their own", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await open(k, startup());
    await open(k, startup("dddd1111", "claude-desktop", "clear"));
    await open(k, startup("eeee2222", "claude-desktop", "fork"));
    expect(k.fake.requestsMatching("POST", `/guilds/${GUILD_ID}/channels`)).toHaveLength(3);
    expect(k.sessions.ids().sort()).toEqual([SID, "dddd1111", "eeee2222"].sort());
  });

  test("compact changes nothing for a known session", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await open(k, startup());
    const before = k.fake.requests.length;
    const result = await k.channels.register(startup(SID, "claude-desktop", "compact"));
    expect(result).toMatchObject({ registered: true, channelName: "session-kit-caa2-desktop", pending: false, linked: true });
    expect(k.fake.requests.length).toBe(before);
  });

  test("an sdk-cli session (or any non-interactive entry point) gets no channel and no entry", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    for (const entrypoint of ["sdk-cli", "local-agent", "remote", undefined]) {
      const result = await k.channels.register({ ...startup(), entrypoint });
      expect(result).toEqual({ registered: false, channelName: null, category: null, pending: false, linked: false });
    }
    expect(k.writes()).toHaveLength(0);
    expect(k.sessions.ids()).toEqual([]);
  });

  test("offline, a chat that starts gets its channel once connected", async () => {
    const k = await channelKit({ online: false });
    const result = await k.channels.register(startup());
    expect(result).toEqual({ registered: true, channelName: "session-kit-caa2-desktop", category: "Desktop", pending: true, linked: false });
    expect(k.sessions.get(SID)!.wantsChannel).toBe(false);
    k.channels.activate(SID);
    expect(k.writes()).toHaveLength(0);
    expect(k.sessions.get(SID)!.wantsChannel).toBe(true);
    k.state.online = true;
    await k.channels.onConnected();
    expect(k.fake.channelNamed("session-kit-caa2-desktop")).toBeDefined();
    expect(k.sessions.get(SID)!.wantsChannel).toBe(false);
  });

  test("a second session with the same name gets four id characters before the suffix", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await open(k, startup("1111aaaa"));
    await open(k, startup("a91c2222"));
    k.channels.applyNames(new Map([["1111aaaa", "Fix login bug"]]));
    await k.channels.settle();
    k.channels.applyNames(new Map([["a91c2222", "Fix login bug"]]));
    await k.channels.settle();
    expect(k.sessions.get("1111aaaa")!.channelName).toBe("fix-login-bug-desktop");
    expect(k.sessions.get("a91c2222")!.channelName).toBe("fix-login-bug-a91c-desktop");
  });

  test("a channel deleted by hand unlinks its session; later turns leave it, the next post makes a new one", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await open(k, startup());
    k.channels.activate(SID);
    const old = k.sessions.get(SID)!.channelId!;
    k.fake.channels.delete(old);
    k.channels.onChannelEvent("CHANNEL_DELETE", { id: old, guild_id: GUILD_ID, type: 0 });
    expect(k.sessions.get(SID)!.channelId).toBeNull();
    k.channels.activate(SID);
    await k.channels.settle();
    expect(k.fake.requestsMatching("POST", `/guilds/${GUILD_ID}/channels`)).toHaveLength(1);
    const fresh = await k.channels.ensureChannel(SID);
    expect(fresh).not.toBe(old);
    expect(k.fake.channels.get(fresh!)?.name).toBe("session-kit-caa2-desktop");
  });

  test("restart reconciliation unlinks a session whose channel is gone", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await open(k, startup());
    k.fake.channels.delete(k.sessions.get(SID)!.channelId!);
    await k.channels.reconcile();
    expect(k.sessions.get(SID)).toMatchObject({ channelId: null, channelName: null });
  });

  test("a category deleted by hand is made again when needed", async () => {
    const k = await channelKit();
    k.fake.channels.delete(k.categories.cli.id);
    await k.channels.reconcile();
    expect(k.config().categories.cli).toBeUndefined();
    await open(k, startup("bbbb0000", "cli"));
    const made = k.fake.channelNamed("CLI");
    expect(made?.type).toBe(4);
    expect(k.config().categories.cli).toBe(made!.id);
    expect(k.fake.channelNamed("session-kit-bbbb-cli")?.parent_id).toBe(made!.id);
  });
});

describe("renames", () => {
  test("a name change at minute 1 renames at once; one at minute 3 waits until minute 6, with the latest name", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await open(k, startup());
    const channelId = k.sessions.get(SID)!.channelId!;
    const renames = () => k.fake.requestsMatching("PATCH", `/channels/${channelId}`).map((r) => r.body.name);
    expect(RENAME_SPACING_MS).toBe(5 * MINUTE);

    await k.clock.advance(MINUTE);
    k.channels.applyNames(new Map([[SID, "First name"]]));
    await k.channels.settle();
    expect(renames()).toEqual(["first-name-desktop"]);

    await k.clock.advance(2 * MINUTE); // minute 3
    k.channels.applyNames(new Map([[SID, "Second name"]]));
    await k.channels.settle();
    await k.clock.advance(MINUTE); // minute 4
    k.channels.applyNames(new Map([[SID, "Third name"]]));
    await k.channels.settle();
    await k.clock.advance(2 * MINUTE - 1); // just before minute 6
    expect(renames()).toEqual(["first-name-desktop"]);
    await k.clock.advance(1);
    await k.channels.settle();
    expect(renames()).toEqual(["first-name-desktop", "third-name-desktop"]);
    expect(k.sessions.get(SID)!.channelName).toBe("third-name-desktop");
  });

  test('"New session" keeps the folder name; an unchanged name sends nothing', async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await open(k, startup());
    k.channels.applyNames(new Map([[SID, "New session"]]));
    await k.channels.settle();
    expect(k.fake.requestsMatching("PATCH", /\/channels\//)).toHaveLength(0);
  });

  test("a 429 on a rename waits retry_after and sends only the latest wanted name", async () => {
    const k = await channelKit();
    await k.channels.reconcile();
    await open(k, startup());
    const channelId = k.sessions.get(SID)!.channelId!;
    k.fake.failNext({ method: "PATCH", path: `/channels/${channelId}`, status: 429, body: { retry_after: 90 } });
    k.channels.applyNames(new Map([[SID, "Old wish"]]));
    await k.channels.settle();
    k.channels.applyNames(new Map([[SID, "New wish"]]));
    await k.channels.settle();
    await k.clock.advance(89_999);
    expect(k.fake.requestsMatching("PATCH", `/channels/${channelId}`)).toHaveLength(1);
    await k.clock.advance(1);
    await k.channels.settle();
    const bodies = k.fake.requestsMatching("PATCH", `/channels/${channelId}`).map((r) => r.body.name);
    expect(bodies).toEqual(["old-wish-desktop", "new-wish-desktop"]);
    expect(k.fake.channels.get(channelId)!.name).toBe("new-wish-desktop");
  });
});

describe("categories and the server limit", () => {
  test("a full Desktop category gets a Desktop 2", async () => {
    const k = await channelKit();
    for (let i = 0; i < 50; i++) k.fake.addChannel({ name: `filler-${i}`, parent_id: k.categories.desktop.id });
    await k.channels.reconcile();
    const result = await open(k, startup());
    expect(result.category).toBe("Desktop 2");
    const overflow = k.fake.channelNamed("Desktop 2")!;
    expect(overflow.type).toBe(4);
    expect(k.config().categories["desktop-2"]).toBe(overflow.id);
    expect(k.fake.channelNamed("session-kit-caa2-desktop")?.parent_id).toBe(overflow.id);
    // A second new session also fits in Desktop 2: no third category.
    await open(k, startup("bbbb0000"));
    expect(k.fake.requestsMatching("POST", `/guilds/${GUILD_ID}/channels`).filter((r) => r.body.type === 4)).toHaveLength(1);
  });

  test("at 490 channels the oldest archived channel is deleted before a new one is created", async () => {
    const k = await channelKit();
    expect(SERVER_SOFT_LIMIT).toBe(490);
    await k.channels.reconcile();
    await open(k, startup("old10000"));
    await open(k, startup("old20000"));
    const oldest = k.sessions.get("old10000")!.channelId!;
    const newer = k.sessions.get("old20000")!.channelId!;
    for (const [id, channelId, at] of [
      ["old10000", oldest, 1000],
      ["old20000", newer, 2000],
    ] as const) {
      k.fake.channels.get(channelId)!.parent_id = k.categories.archive.id;
      k.sessions.update(id, (e) => {
        e.archived = true;
        e.lastMessageAt = at;
      });
    }
    // Fill the server up to 490 (categories and #session-kit count too).
    let n = 0;
    while (k.fake.channels.size < 490) k.fake.addChannel({ name: `filler-${n++}` });
    await k.channels.reconcile();
    const before = k.fake.requests.length;
    await open(k, startup());
    const after = k.fake.requests.slice(before).filter((r) => r.method !== "GET");
    expect(after.map((r) => `${r.method} ${r.path}`)).toEqual([`DELETE /channels/${oldest}`, `POST /guilds/${GUILD_ID}/channels`]);
    expect(k.sessions.get("old10000")).toBeUndefined();
    expect(k.sessions.get("old20000")?.channelId).toBe(newer);
  });
});
