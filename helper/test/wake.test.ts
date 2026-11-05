import { describe, expect, test } from "bun:test";
import { REPLIES, couldNotWake } from "../src/inbound.ts";
import { memoryLogger } from "../src/log.ts";
import { parseAgentList } from "../src/names.ts";
import {
  Waker,
  buildResumeCommand,
  parseBackgroundedId,
  presenceOf,
  sessionStatus,
  wakePrompt,
} from "../src/wake.ts";
import { BIN, FakeCli } from "./fakes/fake-cli.ts";
import { FakeClock } from "./fakes/fake-clock.ts";
import { inboundKit } from "./helpers/inbound-kit.ts";
import { waitFor } from "./helpers/wait.ts";

const SID = "caa24365-1b2c-4d5e-8f90-123456789abc";

describe("the wake command and prompt", () => {
  test("resumes with exactly --bg --resume <id> and the prompt last", () => {
    expect(buildResumeCommand({ bin: BIN, sessionId: SID, prompt: "p" })).toEqual([BIN, "--bg", "--resume", SID, "p"]);
  });

  test("the prompt says how the session was woken and what to do first", () => {
    expect(wakePrompt("run the tests")).toBe(
      "You were woken by a Discord message in your channel: run the tests. Start the Discord listener again (session-kit:discord skill), then handle the message.",
    );
    expect(wakePrompt("--version").startsWith("-")).toBe(false);
  });

  test("reads the short id from the backgrounded line, and nothing else", () => {
    expect(parseBackgroundedId("woke session x\nbackgrounded · 0123abcd\n")).toBe("0123abcd");
    expect(parseBackgroundedId("started bg-1")).toBeNull();
  });
});

describe("what state a session is in", () => {
  const alive = () => true;
  const dead = () => false;
  const bg = (over: Record<string, unknown> = {}) => ({ id: "a1b2c3d4", sessionId: SID, kind: "background", state: "done", status: "idle", pid: 7, ...over });
  const status = (rows: unknown[], isAlive = alive) => sessionStatus(parseAgentList(JSON.stringify(rows))!, SID, isAlive);

  test("absent, interactive, idle, busy, blocked and stopped", () => {
    expect(status([])).toEqual({ kind: "absent" });
    expect(status([{ pid: 7, sessionId: SID, kind: "interactive", status: "busy" }])).toEqual({ kind: "interactive" });
    expect(status([bg({ id: undefined })])).toEqual({ kind: "interactive" });
    expect(status([bg()])).toEqual({ kind: "idle", shortId: "a1b2c3d4" });
    expect(status([bg({ state: "working", status: "busy" })])).toEqual({ kind: "busy", blocked: false, shortId: "a1b2c3d4" });
    expect(status([bg({ state: "blocked" })])).toEqual({ kind: "busy", blocked: true, shortId: "a1b2c3d4" });
    expect(status([bg({ state: "working", status: "waiting" })])).toEqual({ kind: "busy", blocked: true, shortId: "a1b2c3d4" });
    expect(status([bg({ pid: null, status: null })])).toEqual({ kind: "stopped", shortId: "a1b2c3d4" });
    expect(status([bg()], dead)).toEqual({ kind: "stopped", shortId: "a1b2c3d4" });
    expect(status([{ pid: 7, sessionId: SID.toUpperCase(), kind: "interactive" }])).toEqual({ kind: "interactive" });
  });

  test("presence in one word", () => {
    expect(presenceOf(null)).toBe("unknown");
    expect(presenceOf({ kind: "absent" })).toBe("closed");
    expect(presenceOf({ kind: "interactive" })).toBe("open");
    expect(presenceOf({ kind: "idle", shortId: "x" })).toBe("idle");
    expect(presenceOf({ kind: "busy", blocked: true })).toBe("busy");
  });
});

describe("Waker", () => {
  function waker(cli = new FakeCli(), clock = new FakeClock()) {
    const w = new Waker({ runner: cli, clock, log: memoryLogger(), claudePath: () => BIN, pidAlive: cli.pidAlive, env: { PATH: "/usr/bin" }, home: "/home/someone" });
    return { w, cli, clock };
  }

  test("reads the list with --json --all and a time limit, with the CLI's folder and the usual ones on PATH", async () => {
    const { w, cli } = waker();
    await w.lookup([SID]);
    expect(cli.runs[0]!.cmd).toEqual([BIN, "agents", "--json", "--all"]);
    expect(cli.runs[0]!.opts.timeoutMs).toBe(20_000);
    expect(cli.runs[0]!.opts.env!.PATH).toBe("/opt/tools:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/home/someone/.local/bin");
  });

  test("an idle background session is stopped first, then resumed under the same id", async () => {
    const { w, cli } = waker();
    const row = cli.addIdle(SID);
    const outcome = await w.wake({ sessionId: SID, cwd: "/work/demo" }, wakePrompt("hi"), "hi");
    expect(outcome.kind).toBe("started");
    expect(cli.stops).toEqual([row.id!]);
    expect(cli.wakes()).toHaveLength(1);
    expect(cli.copies()).toHaveLength(0);
  });

  test("an open session, or one working in the background, is never touched", async () => {
    for (const setup of [(c: FakeCli) => c.addInteractive(SID), (c: FakeCli) => c.addBackground({ sessionId: SID })]) {
      const { w, cli } = waker();
      setup(cli);
      const outcome = await w.wake({ sessionId: SID, cwd: "/w" }, "p", "");
      expect(["interactive", "busy"]).toContain(outcome.kind);
      expect(cli.launchLines()).toEqual([]);
      expect(cli.stops).toEqual([]);
    }
  });

  test("one that never shows up alive within 20 seconds is a failure", async () => {
    const { w, cli, clock } = waker();
    cli.addClosed(SID);
    cli.launchNeverStarts = true;
    const outcome = w.wake({ sessionId: SID, cwd: "/w" }, "p", "");
    for (let i = 0; i < 10; i++) {
      await waitFor(() => clock.pending === 1);
      await clock.advance(2000);
    }
    expect(await outcome).toEqual({ kind: "failed", reason: "it didn't show up as running within 20 seconds" });
    expect(cli.runs.filter((r) => r.cmd[1] === "agents").length).toBeGreaterThanOrEqual(10);
  });

  test("the cool-down is per session and lasts a minute", async () => {
    const { w, cli, clock } = waker();
    cli.addClosed(SID);
    expect((await w.wake({ sessionId: SID, cwd: "/w" }, "p", "")).kind).toBe("started");
    expect(w.busy(SID)).toBe("cooldown");
    expect(w.busy("other")).toBeNull();
    await clock.advance(60_000);
    expect(w.busy(SID)).toBeNull();
  });
});

describe("waking from a Discord message", () => {
  test("a closed terminal session resumes with exactly --bg --resume <id> \"<prompt>\"", async () => {
    const k = await inboundKit();
    k.claude.addClosed(k.sessionId);
    await k.say("please rerun the deploy");
    expect(k.claude.launchLines()).toEqual([[BIN, "--bg", "--resume", k.sessionId, wakePrompt("please rerun the deploy")]]);
    expect(k.claude.wakes()[0]!.cwd).toBe("/work/session-kit");
    expect(k.replies()).toEqual([REPLIES.woke]);
    expect(k.daemon.sessions.get(k.sessionId)!.inbox).toEqual([]);
  });

  test("a second message within 60 seconds does not wake again; it waits in the inbox", async () => {
    const k = await inboundKit();
    k.claude.addClosed(k.sessionId);
    await k.say("first");
    // The woken session is gone again before it listened (it finished quickly).
    k.claude.row(k.sessionId)!.pid = null;
    await k.say("second");
    expect(k.claude.launchLines()).toHaveLength(1);
    expect(k.replies()).toEqual([REPLIES.woke, REPLIES.waking]);
    expect(k.daemon.sessions.get(k.sessionId)!.inbox.map((e) => e.text)).toEqual(["second"]);
    await k.clock.advance(60_000);
    await k.say("third");
    expect(k.claude.launchLines()).toHaveLength(2);
  });

  test("a copy started under a new id is stopped and the message kept", async () => {
    const k = await inboundKit();
    k.claude.addStopped(k.sessionId);
    // The session comes back to life between the check and the launch, so the CLI starts a copy.
    k.claude.beforeLaunch = () => {
      k.claude.row(k.sessionId)!.pid = 99_999;
    };
    await k.say("hello");
    expect(k.claude.copies()).toHaveLength(1);
    expect(k.claude.stops).toEqual([k.claude.copies()[0]!.row.id!]);
    expect(k.daemon.sessions.get(k.sessionId)!.inbox.map((e) => e.text)).toEqual(["hello"]);
    expect(k.replies()).toEqual([REPLIES.notListening]);
  });

  test("a launch failure says why and keeps the message", async () => {
    const k = await inboundKit();
    k.claude.addClosed(k.sessionId);
    k.claude.launchCode = 1;
    await k.say("hello");
    expect(k.replies()).toEqual([couldNotWake("exit 1")]);
    expect(k.daemon.sessions.get(k.sessionId)!.inbox.map((e) => e.text)).toEqual(["hello"]);
  });

  test("the user's text never reaches the log", async () => {
    const k = await inboundKit();
    k.claude.addClosed(k.sessionId);
    k.claude.launchCode = 1;
    k.claude.launchError = "error: could not run: the secret plan is in drawer two";
    await k.say("the secret plan is in drawer two");
    expect(k.log.lines.join("\n")).not.toContain("drawer two");
  });

  test("an idle background session is stopped, then woken", async () => {
    const k = await inboundKit();
    const row = k.claude.addIdle(k.sessionId);
    await k.say("next step please");
    expect(k.claude.stops).toEqual([row.id!]);
    expect(k.claude.wakes()).toHaveLength(1);
    expect(k.replies()).toEqual([REPLIES.woke]);
  });

  test("desktop and VS Code sessions are never woken", async () => {
    for (const entrypoint of ["claude-desktop", "claude-vscode"]) {
      const k = await inboundKit({ entrypoint });
      k.claude.addStopped(k.sessionId);
      k.daemon.channels.ended(k.sessionId);
      await k.say("wake up");
      expect(k.claude.launchLines()).toEqual([]);
      expect(k.claude.stops).toEqual([]);
    }
  });

  test("two closed sessions are woken one after the other", async () => {
    const k = await inboundKit();
    await k.register("bbbb2222", "cli");
    k.claude.addClosed(k.sessionId);
    k.claude.addClosed("bbbb2222");
    await k.say("to the first");
    await k.say("to the second", { channelId: k.daemon.sessions.get("bbbb2222")!.channelId! });
    expect(k.claude.wakes().map((w) => w.row.sessionId)).toEqual([k.sessionId, "bbbb2222"]);
  });
});
