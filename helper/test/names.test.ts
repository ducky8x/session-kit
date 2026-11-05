import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { channelNameFor, isUnnamed, slugify, surfaceFor } from "../src/channels.ts";
import { memoryLogger } from "../src/log.ts";
import { AGENTS_TIMEOUT_MS, NamePoller, POLL_INTERVAL_MS, parseAgentList, readCustomTitle } from "../src/names.ts";
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
    const paths = pathsFor(tmpDir());
    const sessions = new SessionStore(paths);
    const clock = new FakeClock();
    const runner = new FakeProcessRunner();
    const names: [string, string | null][] = [];
    const poller = new NamePoller({
      runner,
      clock,
      log: memoryLogger(),
      sessions,
      claudePath: () => "/opt/tools/claude",
      onNames: (seen) => {
        for (const [id, name] of seen) names.push([id, name]);
      },
    });
    return { paths, sessions, clock, runner, names, poller };
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
});
