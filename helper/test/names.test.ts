import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { channelNameFor, isUnnamed, slugify, surfaceFor } from "../src/channels.ts";
import { memoryLogger } from "../src/log.ts";
import {
  AGENTS_TIMEOUT_MS,
  DesktopRecords,
  NamePoller,
  POLL_INTERVAL_MS,
  parseAgentList,
  readCustomTitle,
} from "../src/names.ts";
import { pathsFor } from "../src/paths.ts";
import { SessionStore, newSession } from "../src/state.ts";
import { FakeClock } from "./fakes/fake-clock.ts";
import { FakeProcessRunner } from "./fakes/fake-process.ts";
import { tmpDir } from "./helpers/tmp.ts";

const SID = "caa24365-1b2c-4d5e-8f90-123456789abc";

describe("surfaceFor", () => {
  test("maps the three interactive entry points and nothing else", () => {
    expect(surfaceFor("claude-desktop")).toBe("desktop");
    expect(surfaceFor("claude-vscode")).toBe("vs");
    expect(surfaceFor("cli")).toBe("cli");
    for (const other of ["sdk-cli", "sdk-ts", "sdk-py", "local-agent", "remote", "", undefined]) {
      expect(surfaceFor(other)).toBeNull();
    }
  });
});

describe("channel names", () => {
  const session = (name: string | null, surface: "desktop" | "vs" | "cli", cwd = "/work/session-kit", sessionId = SID) => ({
    sessionId,
    name,
    cwd,
    surface,
  });

  test('"Fix login bug" in VS Code is fix-login-bug-vs', () => {
    expect(channelNameFor(session("Fix login bug", "vs"), new Set())).toBe("fix-login-bug-vs");
  });

  test('"New session" in ~/work/session-kit is the folder and four id characters', () => {
    expect(channelNameFor(session("New session", "desktop", "/home/someone/work/session-kit"), new Set())).toBe(
      "session-kit-caa2-desktop",
    );
    expect(channelNameFor(session(null, "cli"), new Set())).toBe("session-kit-caa2-cli");
    expect(channelNameFor(session("   ", "cli"), new Set())).toBe("session-kit-caa2-cli");
  });

  test("a name that slugs to nothing (emoji only) falls back to the folder rule", () => {
    expect(channelNameFor(session("🚀🔥", "desktop"), new Set())).toBe("session-kit-caa2-desktop");
  });

  test("a 120-character name is cut to 80 before the suffix", () => {
    const name = "a".repeat(120);
    const channel = channelNameFor(session(name, "desktop"), new Set());
    expect(channel).toBe(`${"a".repeat(80)}-desktop`);
  });

  test("a cut never leaves a dash before the suffix", () => {
    const name = `${"a".repeat(79)} b`;
    expect(channelNameFor(session(name, "cli"), new Set())).toBe(`${"a".repeat(79)}-cli`);
  });

  test("a name another linked session already has gets the four id characters before the suffix", () => {
    const taken = new Set(["fix-login-bug-desktop"]);
    expect(channelNameFor(session("Fix login bug", "desktop", "/w", "a91c0000-0000"), taken)).toBe(
      "fix-login-bug-a91c-desktop",
    );
    // The same name on another surface is a different channel name, so no suffix is needed.
    expect(channelNameFor(session("Fix login bug", "vs", "/w", "a91c0000-0000"), taken)).toBe("fix-login-bug-vs");
  });

  test("slugify lowercases and turns every other run into one dash", () => {
    expect(slugify("  Hello, World!! ")).toBe("hello-world");
    expect(slugify("Ça va? über_cool")).toBe("a-va-ber-cool");
    expect(slugify("---")).toBe("");
    expect(isUnnamed("New session")).toBe(true);
    expect(isUnnamed("new session")).toBe(true);
    expect(isUnnamed("Newer session")).toBe(false);
  });
});

describe("parseAgentList", () => {
  test("reads rows and keeps only known fields of the right type", () => {
    const entries = parseAgentList(
      JSON.stringify([
        { pid: 11, sessionId: "s2", kind: "interactive", name: "m", status: "busy", cwd: "/w" },
        { sessionId: 5, pid: "7", name: 3 },
      ]),
    );
    expect(entries).toEqual([{ pid: 11, sessionId: "s2", kind: "interactive", name: "m", status: "busy", cwd: "/w" }, {}]);
  });

  test("reads the rows in the shape the CLI prints them", () => {
    const sid = (n: number) => `1f0e2c9a-0000-4000-8000-00000000000${n}`;
    const listed = [
      // Open in the desktop app and in VS Code: interactive, with no id, no state and no entry point.
      { pid: 4101, cwd: "/work/app", kind: "interactive", startedAt: 1762300000000, sessionId: sid(1), name: "Fix login bug", status: "idle" },
      { pid: 4102, cwd: "/work/docs", kind: "interactive", startedAt: 1762300001000, sessionId: sid(2), name: "Docs pass", status: "busy" },
      // In the background and waiting on a dialog.
      {
        pid: 4103,
        id: "2b3c4d5e",
        cwd: "/work/app",
        kind: "background",
        startedAt: 1762300002000,
        sessionId: sid(3),
        name: "Migrate",
        status: "waiting",
        waitingFor: "dialog",
        state: "blocked",
      },
      // Finished, its process gone (listed with --all): no pid and no status.
      { id: "3c4d5e6f", cwd: "/work/app", kind: "background", startedAt: 1762300003000, sessionId: sid(4), name: "Old run", state: "done" },
    ];
    expect(parseAgentList(`${JSON.stringify(listed, null, 2)}\n`)).toEqual([
      { pid: 4101, cwd: "/work/app", kind: "interactive", sessionId: sid(1), name: "Fix login bug", status: "idle" },
      { pid: 4102, cwd: "/work/docs", kind: "interactive", sessionId: sid(2), name: "Docs pass", status: "busy" },
      { pid: 4103, id: "2b3c4d5e", cwd: "/work/app", kind: "background", sessionId: sid(3), name: "Migrate", status: "waiting", state: "blocked" },
      { id: "3c4d5e6f", cwd: "/work/app", kind: "background", sessionId: sid(4), name: "Old run", state: "done" },
    ]);
  });

  test("also reads a list wrapped in an object, and returns null for shapes it does not know", () => {
    expect(parseAgentList(JSON.stringify({ sessions: [{ sessionId: "s1" }] }))).toEqual([{ sessionId: "s1" }]);
    expect(parseAgentList(JSON.stringify({ agents: [{ session_id: "s2" }] }))).toEqual([{ sessionId: "s2" }]);
    for (const bad of ["", "not json", "42", "{}", '{"sessions":"no"}']) expect(parseAgentList(bad)).toBeNull();
  });
});

describe("readCustomTitle", () => {
  test("takes the last custom-title line", async () => {
    const file = `${tmpDir()}/t.jsonl`;
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", message: "hi" }),
        JSON.stringify({ type: "custom-title", customTitle: "First" }),
        JSON.stringify({ type: "assistant", message: "custom-title in text does not count" }),
        JSON.stringify({ type: "custom-title", customTitle: "Second", sessionId: SID }),
        JSON.stringify({ type: "user", message: "more" }),
        "",
      ].join("\n"),
    );
    expect(await readCustomTitle(file)).toBe("Second");
  });

  test("reads only the last 256 KB", async () => {
    const file = `${tmpDir()}/t.jsonl`;
    const filler = `${JSON.stringify({ type: "user", message: "x".repeat(1000) })}\n`.repeat(300); // about 300 KB
    writeFileSync(file, `${JSON.stringify({ type: "custom-title", customTitle: "Too far back" })}\n${filler}`);
    expect(await readCustomTitle(file)).toBeNull();
    writeFileSync(file, `${filler}${JSON.stringify({ type: "custom-title", customTitle: "Near the end" })}\n`);
    expect(await readCustomTitle(file)).toBe("Near the end");
  });

  test("a missing file, or one with no title, is null", async () => {
    expect(await readCustomTitle(`${tmpDir()}/missing.jsonl`)).toBeNull();
    const file = `${tmpDir()}/t.jsonl`;
    writeFileSync(file, '{"type":"user"}\n{ torn');
    expect(await readCustomTitle(file)).toBeNull();
  });
});

describe("NamePoller", () => {
  function kit() {
    const home = tmpDir();
    const paths = pathsFor(home);
    const sessions = new SessionStore(paths);
    const clock = new FakeClock();
    const runner = new FakeProcessRunner();
    // What `claude agents --json` lists, once a test sets it with `list`.
    let rows: unknown[] | null = null;
    runner.on((cmd) => (rows !== null && cmd[1] === "agents" ? { code: 0, stdout: JSON.stringify(rows), stderr: "" } : undefined));
    const names: [string, string | null][] = [];
    let latest = new Map<string, string>();
    // Made by the first record a test writes, so a kit that writes none has no folder at all.
    const desktopDir = join(home, "claude-code-sessions");
    const poller = new NamePoller({
      runner,
      clock,
      log: memoryLogger(),
      sessions,
      claudePath: () => "/opt/tools/claude",
      desktopSessionsDir: desktopDir,
      onNames: (seen) => {
        latest = new Map(seen);
        for (const [id, name] of seen) names.push([id, name]);
      },
    });
    // Every file write gets a later mtime than the one before, a second apart.
    let stamp = Date.UTC(2026, 10, 4, 12) / 1000;
    const touch = (file: string, at = ++stamp) => {
      utimesSync(file, at, at);
      return at;
    };
    return {
      paths,
      sessions,
      clock,
      runner,
      names,
      poller,
      desktopDir,
      touch,
      /** The names the last poll found. */
      latest: () => latest,
      /** Set the rows `claude agents --json` lists. */
      list: (next: unknown[]) => {
        rows = next;
      },
      /** Poll (with nothing listed, unless a test said otherwise) and return the names found. */
      poll: async () => {
        rows ??= [];
        await poller.poll();
        return latest;
      },
      /** A transcript whose last custom-title line is `title`. */
      transcript: (title: string) => {
        const file = join(tmpDir(), "t.jsonl");
        writeFileSync(file, `${JSON.stringify({ type: "user", message: "hi" })}\n${customTitle(title)}`);
        touch(file);
        return file;
      },
      /** `/rename`: one more custom-title line at the end of the transcript. */
      rename: (file: string, title: string) => {
        appendFileSync(file, customTitle(title));
        touch(file);
      },
      /**
       * The desktop app's record of one of its sessions, at <root>/<account>/<org>/local_<its own id>.json, with
       * the fields the helper reads among others it ignores.
       */
      desktopRecord: (cliSessionId: string, title: string, o: { file?: string; titleSource?: string } = {}) => {
        const dir = join(desktopDir, "acct-0001", "org-0001");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, o.file ?? `local_${cliSessionId}-own.json`);
        const record = {
          sessionId: `local_${cliSessionId}-own`,
          cliSessionId,
          cwd: "/work/app",
          title,
          titleSource: o.titleSource ?? "user",
          isArchived: false,
          model: "some-model",
          lastActivityAt: 1762300000000,
        };
        writeFileSync(file, JSON.stringify(record));
        touch(file);
        return file;
      },
    };
  }

  function customTitle(title: string) {
    return `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId: SID })}\n`;
  }

  /** A session that has ended, with its channel still there unless `channelId` is null. */
  function ended(
    sessionId: string,
    surface: "desktop" | "vs" | "cli",
    transcriptPath: string | null,
    o: { channelId?: string | null; name?: string | null } = {},
  ) {
    return {
      ...newSession({ sessionId, surface, cwd: "/work/app", transcriptPath, now: 0, name: o.name ?? null }),
      channelId: o.channelId === undefined ? `chan-${sessionId.slice(0, 4)}` : o.channelId,
      closedAt: 5,
    };
  }

  test("asks claude agents --json every 30 seconds with a 5-second limit", async () => {
    const k = kit();
    k.runner.answer(["/opt/tools/claude", "agents", "--json"], { stdout: "[]" });
    expect(POLL_INTERVAL_MS).toBe(30_000);
    expect(AGENTS_TIMEOUT_MS).toBe(5000);
    k.poller.start();
    await k.clock.advance(0);
    expect(k.runner.commands).toEqual(["/opt/tools/claude agents --json"]);
    expect(k.runner.runs[0]!.opts.timeoutMs).toBe(5000);
    await k.clock.advance(29_999);
    expect(k.runner.runs).toHaveLength(1);
    await k.clock.advance(1);
    expect(k.runner.runs).toHaveLength(2);
    k.poller.stop();
    await k.clock.advance(60_000);
    expect(k.runner.runs).toHaveLength(2);
  });

  test("takes names from the list, and from the transcript for sessions the list leaves out", async () => {
    const k = kit();
    const transcript = `${tmpDir()}/t.jsonl`;
    writeFileSync(transcript, `${JSON.stringify({ type: "custom-title", customTitle: "From the transcript" })}\n`);
    k.sessions.put(newSession({ sessionId: "listed", surface: "desktop", cwd: "/w", transcriptPath: null, now: 0 }));
    k.sessions.put(newSession({ sessionId: "unlisted", surface: "vs", cwd: "/w", transcriptPath: transcript, now: 0 }));
    k.sessions.put({
      ...newSession({ sessionId: "closed", surface: "cli", cwd: "/w", transcriptPath: transcript, now: 0 }),
      closedAt: 5,
    });
    k.runner.answer(["/opt/tools/claude"], {
      stdout: JSON.stringify([{ sessionId: "listed", kind: "interactive", name: "Listed name", status: "idle", pid: 1 }]),
    });
    await k.poller.poll();
    expect(k.names).toEqual([
      ["listed", "Listed name"],
      ["unlisted", "From the transcript"],
    ]);
    expect(k.poller.alive("listed")).toBe(true);
    expect(k.poller.alive("unlisted")).toBe(false);
  });

  test("when the list cannot be read, every open session falls back to its transcript", async () => {
    const k = kit();
    const transcript = `${tmpDir()}/t.jsonl`;
    writeFileSync(transcript, `${JSON.stringify({ type: "custom-title", customTitle: "Saved title" })}\n`);
    k.sessions.put(newSession({ sessionId: "s1", surface: "cli", cwd: "/w", transcriptPath: transcript, now: 0 }));
    k.runner.answer(["/opt/tools/claude"], { code: 143, timedOut: true });
    await k.poller.poll();
    expect(k.names).toEqual([["s1", "Saved title"]]);
    expect(k.poller.alive("s1")).toBeNull();
  });

  test("a session that has ended keeps getting its name while it has a channel; one whose channel was deleted is left alone", async () => {
    const k = kit();
    const transcript = k.transcript("Renamed after it ended");
    k.sessions.put(ended("aaaa0001", "cli", transcript));
    k.sessions.put(ended("bbbb0002", "vs", transcript, { channelId: null }));
    expect(await k.poll()).toEqual(new Map([["aaaa0001", "Renamed after it ended"]]));
  });

  test("an ended desktop session renamed in the desktop app's sidebar takes the new title", async () => {
    const k = kit();
    const transcript = k.transcript("Fix login bug");
    k.desktopRecord(SID, "Fix login bug");
    k.sessions.put(ended(SID, "desktop", transcript, { name: "Fix login bug" }));
    expect((await k.poll()).get(SID)).toBe("Fix login bug");

    k.desktopRecord(SID, "Fix the login page");
    expect((await k.poll()).get(SID)).toBe("Fix the login page");
    // The transcript's older title doesn't take it back.
    expect((await k.poll()).get(SID)).toBe("Fix the login page");
  });

  test("an ended desktop session renamed with /rename somewhere else takes that name, and keeps it", async () => {
    const k = kit();
    const transcript = k.transcript("Fix login bug");
    k.desktopRecord(SID, "Fix login bug");
    k.sessions.put(ended(SID, "desktop", transcript, { name: "Fix login bug" }));
    expect((await k.poll()).get(SID)).toBe("Fix login bug");

    // Resumed in a terminal, renamed and closed again between two polls: only the transcript knows.
    k.rename(transcript, "Login page");
    expect((await k.poll()).get(SID)).toBe("Login page");
    // The desktop app's record still has the old title, and is touched for something else.
    k.touch(k.desktopRecord(SID, "Fix login bug"));
    expect((await k.poll()).get(SID)).toBe("Login page");

    // A rename in the sidebar after that wins again.
    k.desktopRecord(SID, "Login page, take two");
    expect((await k.poll()).get(SID)).toBe("Login page, take two");
  });

  test("with nothing to compare against yet, the desktop record and the transcript go by which changed last", async () => {
    const sidebarLater = kit();
    const t1 = sidebarLater.transcript("Old title");
    sidebarLater.desktopRecord(SID, "Sidebar title");
    sidebarLater.sessions.put(ended(SID, "desktop", t1, { name: "Old title" }));
    expect((await sidebarLater.poll()).get(SID)).toBe("Sidebar title");

    const renameLater = kit();
    renameLater.desktopRecord(SID, "Old title");
    const t2 = renameLater.transcript("Renamed in a terminal");
    renameLater.sessions.put(ended(SID, "desktop", t2, { name: "Old title" }));
    expect((await renameLater.poll()).get(SID)).toBe("Renamed in a terminal");
  });

  test("while claude agents lists a desktop session, its row wins over the desktop record and the transcript", async () => {
    const k = kit();
    const transcript = k.transcript("Transcript title");
    k.desktopRecord(SID, "Sidebar title");
    k.sessions.put(newSession({ sessionId: SID, surface: "desktop", cwd: "/w", transcriptPath: transcript, now: 0 }));
    k.list([{ sessionId: SID, kind: "interactive", name: "Row name", status: "idle", pid: 1 }]);
    expect((await k.poll()).get(SID)).toBe("Row name");
    // Once it's no longer listed, the desktop record counts (it changed after the transcript).
    k.list([]);
    expect((await k.poll()).get(SID)).toBe("Sidebar title");
  });

  test("the desktop record is read only for desktop sessions, and an unnamed title doesn't count", async () => {
    const k = kit();
    const transcript = k.transcript("From the transcript");
    k.desktopRecord("aaaa0001", "Sidebar title");
    k.desktopRecord(SID, "New session");
    k.sessions.put(ended("aaaa0001", "cli", transcript));
    k.sessions.put(ended(SID, "desktop", transcript));
    expect(await k.poll()).toEqual(
      new Map([
        ["aaaa0001", "From the transcript"],
        [SID, "From the transcript"],
      ]),
    );
  });

  test("desktop records it can't read are skipped, as is a missing folder", async () => {
    const k = kit();
    const transcript = k.transcript("From the transcript");
    const ids = ["aaaa0001", "bbbb0002", "cccc0003", "dddd0004", "eeee0005", "ffff0006"];
    for (const id of ids) k.sessions.put(ended(id, "desktop", transcript));
    // No folder yet.
    expect([...(await k.poll()).values()]).toEqual(ids.map(() => "From the transcript"));

    const dir = join(k.desktopDir, "acct-0001", "org-0001");
    k.desktopRecord("ffff0006", "Sidebar title");
    writeFileSync(join(dir, "local_torn.json"), '{ "cliSessionId": "aaaa0001", "title": "Torn');
    writeFileSync(join(dir, "local_no-title.json"), JSON.stringify({ cliSessionId: "bbbb0002", titleSource: "user" }));
    writeFileSync(join(dir, "local_number.json"), JSON.stringify({ cliSessionId: "cccc0003", title: 42 }));
    writeFileSync(join(dir, "local_list.json"), JSON.stringify([{ cliSessionId: "dddd0004", title: "In a list" }]));
    mkdirSync(join(dir, "local_folder.json"));
    writeFileSync(join(dir, "deleted_eeee0005"), JSON.stringify({ cliSessionId: "eeee0005", title: "Deleted" }));
    writeFileSync(join(dir, "scheduled-tasks.json"), JSON.stringify({ cliSessionId: "eeee0005", title: "Other file" }));
    writeFileSync(join(k.desktopDir, "acct-0001", "local_shallow.json"), JSON.stringify({ cliSessionId: "eeee0005", title: "Too shallow" }));
    writeFileSync(join(k.desktopDir, "stray-file"), "not a folder");
    const names = await k.poll();
    expect(names.get("ffff0006")).toBe("Sidebar title");
    for (const id of ids.slice(0, 5)) expect(names.get(id)).toBe("From the transcript");
  });

  test("a transcript or desktop record whose mtime and size haven't changed isn't read again", async () => {
    const k = kit();
    const transcript = k.transcript("Title AAAA");
    const record = k.desktopRecord(SID, "Title CCCC");
    k.sessions.put(ended("aaaa0001", "cli", transcript));
    k.sessions.put(ended(SID, "desktop", null));
    expect(await k.poll()).toEqual(
      new Map([
        ["aaaa0001", "Title AAAA"],
        [SID, "Title CCCC"],
      ]),
    );

    // Same size, mtime put back: still the old titles.
    const transcriptAt = k.touch(transcript);
    const recordAt = k.touch(record);
    await k.poll();
    writeFileSync(transcript, `${JSON.stringify({ type: "user", message: "hi" })}\n${customTitle("Title BBBB")}`);
    k.touch(transcript, transcriptAt);
    writeFileSync(record, readFileSync(record, "utf8").replace("Title CCCC", "Title DDDD"));
    k.touch(record, recordAt);
    expect(await k.poll()).toEqual(
      new Map([
        ["aaaa0001", "Title AAAA"],
        [SID, "Title CCCC"],
      ]),
    );

    // A new mtime: read again.
    k.touch(transcript);
    k.touch(record);
    expect(await k.poll()).toEqual(
      new Map([
        ["aaaa0001", "Title BBBB"],
        [SID, "Title DDDD"],
      ]),
    );
  });

  test("the desktop records are scanned once per poll, and only when a desktop session needs a name", async () => {
    const scans = spyOn(DesktopRecords.prototype, "titles");
    try {
      const k = kit();
      const transcript = k.transcript("From the transcript");
      k.desktopRecord("aaaa0001", "First");
      k.desktopRecord("bbbb0002", "Second");
      k.sessions.put(ended("aaaa0001", "desktop", transcript));
      k.sessions.put(ended("bbbb0002", "desktop", transcript));
      k.sessions.put(ended("cccc0003", "cli", transcript));
      expect(await k.poll()).toEqual(
        new Map([
          ["aaaa0001", "First"],
          ["bbbb0002", "Second"],
          ["cccc0003", "From the transcript"],
        ]),
      );
      expect(scans).toHaveBeenCalledTimes(1);

      // Both desktop sessions listed by claude agents: their rows are enough.
      k.list([
        { sessionId: "aaaa0001", kind: "interactive", name: "First", status: "idle", pid: 1 },
        { sessionId: "bbbb0002", kind: "interactive", name: "Second", status: "idle", pid: 2 },
      ]);
      await k.poll();
      expect(scans).toHaveBeenCalledTimes(1);
    } finally {
      scans.mockRestore();
    }
  });
});
