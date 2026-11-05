import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { pathsFor } from "../src/paths.ts";
import { INBOX_LIMIT, type SessionEntry, SessionStore, newSession, realAtomicFs, writeFileAtomic } from "../src/state.ts";
import { tmpDir } from "./helpers/tmp.ts";

function entry(sessionId: string, channelId: string | null, extra: Partial<SessionEntry> = {}): SessionEntry {
  return {
    ...newSession({ sessionId, surface: "cli", cwd: "/work/demo", transcriptPath: null, now: 1000 }),
    channelId,
    channelName: channelId ? `demo-${sessionId.slice(0, 4)}-cli` : null,
    ...extra,
  };
}

describe("writeFileAtomic", () => {
  test("writes through a temp file and leaves no temp file behind", () => {
    const dir = tmpDir();
    const file = `${dir}/data.json`;
    writeFileAtomic(file, "one");
    expect(readFileSync(file, "utf8")).toBe("one");
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a crash between the write and the rename leaves the old file whole", () => {
    const dir = tmpDir();
    const file = `${dir}/data.json`;
    writeFileAtomic(file, "old contents");
    const crashing = {
      ...realAtomicFs,
      rename: () => {
        throw new Error("power cut");
      },
    };
    expect(() => writeFileAtomic(file, "new contents", crashing)).toThrow("power cut");
    expect(readFileSync(file, "utf8")).toBe("old contents");
  });
});

describe("SessionStore", () => {
  test("survives a crash mid-save: a restart reads the last complete save", () => {
    const paths = pathsFor(tmpDir());
    const store = new SessionStore(paths);
    store.put(entry("aaaa1111", "c1"));
    // The next save dies after writing its temp file.
    const crashing = {
      ...realAtomicFs,
      rename: () => {
        throw new Error("power cut");
      },
    };
    const doomed = new SessionStore(paths, crashing);
    expect(() => doomed.put(entry("bbbb2222", "c2"))).toThrow("power cut");
    expect(existsSync(`${paths.sessions}.tmp`)).toBe(true);

    const restarted = new SessionStore(paths);
    expect(restarted.ids()).toEqual(["aaaa1111"]);
    // And the next save still works, replacing the stale temp file.
    restarted.put(entry("cccc3333", "c3"));
    expect(new SessionStore(paths).ids()).toEqual(["aaaa1111", "cccc3333"]);
  });

  test("keeps one entry per session id, in a user-only file", () => {
    const paths = pathsFor(tmpDir());
    const store = new SessionStore(paths);
    store.put(entry("aaaa1111", "c1"));
    store.put(entry("aaaa1111", "c9"));
    expect(store.ids()).toEqual(["aaaa1111"]);
    expect(store.get("aaaa1111")?.channelId).toBe("c9");
    const raw = JSON.parse(readFileSync(paths.sessions, "utf8"));
    expect(Object.keys(raw)).toEqual(["aaaa1111"]);
    expect(raw.aaaa1111).toMatchObject({
      channelId: "c9",
      surface: "cli",
      cwd: "/work/demo",
      createdAt: 1000,
      lastMessageAt: 1000,
      archived: false,
      closedAt: null,
      inbox: [],
      question: null,
    });
    expect(statSync(paths.sessions).mode & 0o777).toBe(0o600);
  });

  test("update changes an entry and saves; remove deletes it", () => {
    const paths = pathsFor(tmpDir());
    const store = new SessionStore(paths);
    store.put(entry("aaaa1111", "c1"));
    store.update("aaaa1111", (s) => {
      s.closedAt = 5000;
    });
    expect(new SessionStore(paths).get("aaaa1111")?.closedAt).toBe(5000);
    expect(store.update("missing", () => {})).toBeUndefined();
    store.remove("aaaa1111");
    expect(new SessionStore(paths).ids()).toEqual([]);
  });

  test("finds a session by its channel", () => {
    const store = new SessionStore(pathsFor(tmpDir()));
    store.put(entry("aaaa1111", "c1"));
    store.put(entry("bbbb2222", "c2"));
    expect(store.byChannel("c2")?.sessionId).toBe("bbbb2222");
    expect(store.byChannel("c3")).toBeUndefined();
  });

  test("restart reconciliation marks a session whose channel was deleted as unlinked", () => {
    const paths = pathsFor(tmpDir());
    const store = new SessionStore(paths);
    store.put(entry("aaaa1111", "c1"));
    store.put(entry("bbbb2222", "c2", { archived: true }));
    store.put(entry("cccc3333", null));
    const unlinked = store.unlinkMissing(new Set(["c1"]));
    expect(unlinked).toEqual(["bbbb2222"]);
    const after = new SessionStore(paths);
    expect(after.get("aaaa1111")?.channelId).toBe("c1");
    expect(after.get("bbbb2222")).toMatchObject({ channelId: null, channelName: null, archived: false });
    // The session itself stays registered: a later post makes a new channel from what is stored.
    expect(after.get("bbbb2222")?.cwd).toBe("/work/demo");
  });

  test("a file that is not JSON is set aside and the helper starts empty", () => {
    const paths = pathsFor(tmpDir());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.sessions, "{ broken");
    expect(new SessionStore(paths).ids()).toEqual([]);
    expect(existsSync(`${paths.sessions}.bad`)).toBe(true);
  });

  test("entries missing newer fields get their defaults", () => {
    const paths = pathsFor(tmpDir());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.sessions,
      JSON.stringify({ aaaa1111: { channelId: "c1", surface: "vs", cwd: "/w", createdAt: 1, lastMessageAt: 2 }, junk: 3 }),
    );
    const store = new SessionStore(paths);
    expect(store.ids()).toEqual(["aaaa1111"]);
    expect(store.get("aaaa1111")).toMatchObject({ sessionId: "aaaa1111", inbox: [], question: null, archived: false });
  });

  test("the inbox keeps the newest 50 events and says how many it dropped", () => {
    const store = new SessionStore(pathsFor(tmpDir()));
    store.put(entry("aaaa1111", "c1"));
    expect(INBOX_LIMIT).toBe(50);
    for (let i = 0; i < 50; i++) expect(store.pushInbox("aaaa1111", { type: "text", text: `m${i}` })).toBe(0);
    expect(store.pushInbox("aaaa1111", { type: "text", text: "m50" })).toBe(1);
    const inbox = store.get("aaaa1111")!.inbox;
    expect(inbox).toHaveLength(50);
    expect(inbox[0]).toMatchObject({ text: "m1" });
    expect(inbox.at(-1)).toMatchObject({ text: "m50" });
  });
});
