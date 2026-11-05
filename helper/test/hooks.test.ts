import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig, saveConfig } from "../src/config.ts";
import { type CliDeps, runCli } from "../src/main.ts";
import { pathsFor } from "../src/paths.ts";
import { HELPER_DOWN } from "../src/status.ts";
import { LISTENER_HINT, NO_CHANNEL_YET, NOT_OFFERED } from "../src/hooks/session-start.ts";
import { StubHelper } from "./fakes/stub-helper.ts";
import { tmpDir } from "./helpers/tmp.ts";

const SID = "caa24365-1b2c-4d5e-8f90-123456789abc";

const stubs: StubHelper[] = [];
afterEach(() => {
  for (const stub of stubs.splice(0)) stub.stop();
});

function harness(o: { enabled?: boolean | null; entrypoint?: string; platform?: string; stdin?: string } = {}) {
  const home = tmpDir();
  const paths = pathsFor(home);
  if (o.enabled !== null) saveConfig(paths, { ...defaultConfig(), offered: true, enabled: o.enabled ?? true });
  const out: string[] = [];
  const deps: CliDeps = {
    home,
    env: { CLAUDE_CODE_ENTRYPOINT: o.entrypoint ?? "claude-desktop" },
    cwd: "/work/session-kit",
    platform: o.platform ?? "darwin",
    socketTimeoutMs: 200,
    out: (text) => void out.push(text),
    err: (text) => void out.push(`ERR:${text}`),
    readStdin: async () =>
      o.stdin ??
      JSON.stringify({ session_id: SID, cwd: "/work/session-kit", source: "startup", transcript_path: "/t/caa2.jsonl" }),
  };
  const stub = (answer?: (r: Record<string, unknown>) => Record<string, unknown> | null) => {
    const s = StubHelper.start(paths.socket, answer);
    stubs.push(s);
    return s;
  };
  return { deps, paths, out, text: () => out.join(""), stub };
}

function input(source: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: SID, cwd: "/work/session-kit", transcript_path: "/t/caa2.jsonl", ...(source === null ? {} : { source }), ...extra });
}

describe("hook session-start", () => {
  test("registers the session and prints its channel and the listener lines", async () => {
    const h = harness();
    const stub = h.stub(() => ({
      ok: true,
      registered: true,
      channelName: "session-kit-caa2-desktop",
      category: "Desktop",
      pending: false,
      status: "connected",
    }));
    expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
    expect(stub.requests).toEqual([
      {
        op: "register",
        sessionId: SID,
        source: "startup",
        cwd: "/work/session-kit",
        transcriptPath: "/t/caa2.jsonl",
        entrypoint: "claude-desktop",
        claudePid: null,
      },
    ]);
    expect(h.text()).toBe(
      [
        "Discord: #session-kit-caa2-desktop (Desktop)",
        `Discord listener: ~/.claude/session-kit/bin/sk-discord listen --session ${SID}`,
        LISTENER_HINT,
        "",
      ].join("\n"),
    );
    expect(LISTENER_HINT).toBe("Start it as a background command now, and again after every event (session-kit:discord skill).");
  });

  test("passes on the Claude Code process the session runs in, so a new session id from it keeps the chat", async () => {
    for (const [value, sent] of [
      ["4242", 4242],
      ["not a number", null],
      ["-3", null],
    ] as const) {
      const h = harness();
      h.deps.env.CLAUDE_PID = value;
      const stub = h.stub(() => ({ ok: true, registered: true, channelName: "x-desktop", category: "Desktop", pending: false, linked: true }));
      expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
      expect(stub.requests[0]!.claudePid).toBe(sent);
    }
  });

  test("a session with no channel yet hears when it gets one, and still gets the listener", async () => {
    const h = harness();
    h.stub(() => ({
      ok: true,
      registered: true,
      channelName: "session-kit-caa2-desktop",
      category: "Desktop",
      pending: true,
      linked: false,
      status: "connected",
    }));
    expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
    expect(h.text()).toBe(
      [NO_CHANNEL_YET, `Discord listener: ~/.claude/session-kit/bin/sk-discord listen --session ${SID}`, LISTENER_HINT, ""].join("\n"),
    );
    expect(NO_CHANNEL_YET).toBe("Discord: no channel yet. This session gets one at its first prompt or post.");
  });

  test("a channel still being made says so", async () => {
    const h = harness();
    h.stub(() => ({ ok: true, registered: true, channelName: "session-kit-caa2-desktop", category: "Desktop", pending: true, status: "connecting" }));
    expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
    expect(h.out[0]).toBe("Discord: #session-kit-caa2-desktop (being created)\n");
  });

  test("with no config.json on macOS a new session hears that Discord was never offered", async () => {
    for (const source of ["startup", "clear", null]) {
      const h = harness({ enabled: null, stdin: input(source) });
      const stub = h.stub();
      expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
      expect(h.text()).toBe(`${NOT_OFFERED}\n`);
      expect(stub.requests).toHaveLength(0);
    }
    expect(NOT_OFFERED).toBe(
      'Discord: not offered yet. Add the question "Set up Discord now?" to the startup questions (session-kit:start skill).',
    );
  });

  test("never offered, but a resume, a fork or another system prints nothing", async () => {
    for (const [source, platform] of [
      ["resume", "darwin"],
      ["fork", "darwin"],
      ["startup", "linux"],
    ] as const) {
      const h = harness({ enabled: null, stdin: input(source), platform });
      expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
      expect(h.text()).toBe("");
    }
  });

  test("compact prints nothing and asks nothing", async () => {
    const h = harness({ stdin: input("compact") });
    const stub = h.stub();
    expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
    expect(h.text()).toBe("");
    expect(stub.requests).toHaveLength(0);
  });

  test("Discord off, or a session that isn't interactive, prints nothing and asks nothing", async () => {
    for (const o of [{ enabled: false }, { entrypoint: "sdk-cli" }, { entrypoint: "" }]) {
      const h = harness(o);
      const stub = h.stub();
      expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
      expect(h.text()).toBe("");
      expect(stub.requests).toHaveLength(0);
    }
  });

  test("with the helper not running it says how to start it", async () => {
    const h = harness();
    expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
    expect(h.text()).toBe(`${HELPER_DOWN}\n`);
  });

  test("a helper that does not answer in time fails the hook quietly", async () => {
    const h = harness();
    h.stub(() => null);
    const started = performance.now();
    expect(await runCli(["hook", "session-start"], h.deps)).not.toBe(0);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(h.text()).toBe("");
  });

  test("an error from the helper, or input that is not hook JSON, fails quietly", async () => {
    const h = harness();
    h.stub(() => ({ ok: false, error: "off", message: "Discord is off" }));
    expect(await runCli(["hook", "session-start"], h.deps)).not.toBe(0);
    expect(h.text()).toBe("");
    const bad = harness({ stdin: "not json" });
    expect(await runCli(["hook", "session-start"], bad.deps)).not.toBe(0);
    expect(bad.text()).toBe("");
  });

  test("when setup is unfinished it says what to fix, once per session", async () => {
    const h = harness();
    let notice = true;
    h.stub(() => {
      const reply = { ok: true, registered: true, channelName: "x-desktop", category: "Desktop", pending: true, status: "no-token", notice };
      notice = false;
      return reply;
    });
    expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
    expect(h.text()).toBe(
      "Discord is on but not set up: there is no bot token in the Keychain (fix: sk-discord setup token). Run the Discord setup (session-kit:discord skill) before anything else.\n",
    );
    h.out.length = 0;
    expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
    expect(h.text()).toBe("");
  });

  test("a session the helper does not register prints nothing", async () => {
    const h = harness();
    h.stub(() => ({ ok: true, registered: false }));
    expect(await runCli(["hook", "session-start"], h.deps)).toBe(0);
    expect(h.text()).toBe("");
  });
});

describe("hook session-end", () => {
  test("tells the helper the session ended, and prints nothing", async () => {
    const h = harness({ stdin: JSON.stringify({ session_id: SID, reason: "prompt_input_exit" }) });
    const stub = h.stub();
    expect(await runCli(["hook", "session-end"], h.deps)).toBe(0);
    expect(stub.requests).toEqual([{ op: "ended", sessionId: SID, reason: "prompt_input_exit" }]);
    expect(h.text()).toBe("");
  });

  test("with the helper down, slow, or Discord off, it exits 0 at once and silently", async () => {
    const down = harness({ stdin: JSON.stringify({ session_id: SID, reason: "other" }) });
    expect(await runCli(["hook", "session-end"], down.deps)).toBe(0);
    expect(down.text()).toBe("");

    const slow = harness({ stdin: JSON.stringify({ session_id: SID, reason: "other" }) });
    slow.stub(() => null);
    const started = performance.now();
    expect(await runCli(["hook", "session-end"], slow.deps)).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);

    const off = harness({ enabled: false, stdin: JSON.stringify({ session_id: SID, reason: "other" }) });
    const stub = off.stub();
    expect(await runCli(["hook", "session-end"], off.deps)).toBe(0);
    expect(stub.requests).toHaveLength(0);
  });

  test("the session-end wait is at most half a second", async () => {
    const { ENDED_TIMEOUT_MS } = await import("../src/hooks/session-end.ts");
    expect(ENDED_TIMEOUT_MS).toBeLessThanOrEqual(500);
  });
});

describe("hook stop", () => {
  const stopInput = JSON.stringify({ session_id: SID, hook_event_name: "Stop", stop_hook_active: false });

  test("prints the helper's block decision as JSON", async () => {
    const h = harness({ stdin: stopInput });
    const stub = h.stub(() => ({ ok: true, decision: "block", reason: "Discord message(s) for this session:\n1. hi" }));
    expect(await runCli(["hook", "stop"], h.deps)).toBe(0);
    expect(stub.requests).toEqual([{ op: "stop-hook", sessionId: SID }]);
    expect(JSON.parse(h.text())).toEqual({ decision: "block", reason: "Discord message(s) for this session:\n1. hi" });
  });

  test("prints nothing when nothing waits, when Discord is off, or when the helper is down", async () => {
    const quiet = harness({ stdin: stopInput });
    quiet.stub(() => ({ ok: true }));
    expect(await runCli(["hook", "stop"], quiet.deps)).toBe(0);
    expect(quiet.text()).toBe("");

    const off = harness({ enabled: false, stdin: stopInput });
    const stub = off.stub();
    expect(await runCli(["hook", "stop"], off.deps)).toBe(0);
    expect(stub.requests).toHaveLength(0);

    const down = harness({ stdin: stopInput });
    expect(await runCli(["hook", "stop"], down.deps)).not.toBe(0);
    expect(down.text()).toBe("");
  });
});

describe("timing", () => {
  test("the helper answers register well inside the hook's 2-second wait", async () => {
    const { DEFAULT_TIMING } = await import("../src/channels.ts");
    const { REGISTER_TIMEOUT_MS } = await import("../src/hooks/session-start.ts");
    expect(REGISTER_TIMEOUT_MS).toBe(2000);
    expect(DEFAULT_TIMING.registerWaitMs).toBeLessThanOrEqual(REGISTER_TIMEOUT_MS - 500);
  });
});

describe("hook dispatch", () => {
  test("every event hooks.json and hooks/discord.sh run has a handler", async () => {
    const { readFileSync } = await import("node:fs");
    const { HOOKS } = await import("../src/main.ts");
    const wrapper = readFileSync(new URL("../../hooks/discord.sh", import.meta.url), "utf8");
    const accepted = /\n\s*((?:[a-z-]+ \| )+[a-z-]+)\) ;;/.exec(wrapper)?.[1]?.split(" | ") ?? [];
    expect(accepted.sort()).toEqual(Object.keys(HOOKS).sort());
    expect(Object.keys(HOOKS).sort()).toEqual(["notification", "post-ask", "pre-ask", "prompt", "session-end", "session-start", "stop"]);
    const config = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const wired = Object.values(config.hooks)
      .flat()
      .flatMap((group) => group.hooks)
      .flatMap((h) => /\/hooks\/discord\.sh" ([a-z-]+)$/.exec(h.command)?.[1] ?? []);
    expect(wired.length).toBeGreaterThan(0);
    for (const event of wired) expect(Object.keys(HOOKS)).toContain(event);
  });

  test("an event this version does not know exits 0 with nothing printed", async () => {
    const h = harness();
    expect(await runCli(["hook", "some-future-event"], h.deps)).toBe(0);
    expect(h.text()).toBe("");
  });
});
