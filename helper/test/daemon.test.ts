import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { DAY_MS } from "../src/channels.ts";
import { HelperError } from "../src/client.ts";
import { Daemon, type DiscordMessage } from "../src/daemon.ts";
import { serveUntilStopped } from "../src/run-daemon.ts";
import { memoryLogger } from "../src/log.ts";
import { AlreadyRunning } from "../src/server.ts";
import { MemoryKeychain } from "./fakes/fake-keychain.ts";
import { FakeProcessRunner } from "./fakes/fake-process.ts";
import { GUILD_ID, OWNER_ID } from "./fakes/fake-rest.ts";
import { SID, daemonKit } from "./helpers/daemon-kit.ts";
import { waitFor } from "./helpers/wait.ts";

function ownerMessage(channelId: string, content = "hello", authorId = OWNER_ID): DiscordMessage {
  return { id: String(Math.random()).slice(2), channel_id: channelId, guild_id: GUILD_ID, author: { id: authorId, bot: false }, content };
}

describe("daemon start and status", () => {
  test("with Discord off it serves the socket but does not connect", async () => {
    const k = await daemonKit({ enabled: false });
    expect(statSync(k.paths.socket).mode & 0o777).toBe(0o600);
    expect(await k.call({ op: "status" })).toMatchObject({ ok: true, status: "off", fix: "/discord on" });
    expect(k.gateway.connections).toHaveLength(0);
    expect(k.keychain.reads).toBe(0);
    await expect(k.register(SID)).rejects.toMatchObject({ code: "off" });
  });

  test("connects with the token from the keychain and reports connected", async () => {
    const k = await daemonKit();
    await k.connected();
    expect(k.gateway.latest!.ops(2)[0]!.d.token).toBe(k.keychain.token);
    const status = await k.call({ op: "status" });
    expect(status).toMatchObject({ status: "connected", sessions: 0, outbox: 0 });
    expect(status.fix).toBeUndefined();
  });

  test("no token in the keychain is no-token, and register says so once per session", async () => {
    const k = await daemonKit({ token: null });
    expect(k.daemon.statusCode()).toBe("no-token");
    expect(k.gateway.connections).toHaveLength(0);
    const first = await k.register(SID);
    expect(first).toMatchObject({ registered: true, status: "no-token", notice: true, pending: true });
    expect((await k.register(SID, "cli", "resume")).notice).toBe(false);
    expect((await k.register("other-session")).notice).toBe(true);
  });

  test("close code 4004 is token-rejected and 4014 is intent-missing", async () => {
    const rejected = await daemonKit({ noStart: true });
    rejected.gateway.closeOnIdentify = 4004;
    await rejected.daemon.start();
    await waitFor(() => rejected.daemon.statusCode() === "token-rejected");
    expect(await rejected.call({ op: "status" })).toMatchObject({ fix: "sk-discord setup token" });

    const intents = await daemonKit({ noStart: true });
    intents.gateway.closeOnIdentify = 4014;
    await intents.daemon.start();
    await waitFor(() => intents.daemon.statusCode() === "intent-missing");
    expect((await intents.call({ op: "status" })).fix).toContain("Message Content Intent");
  });

  test("a server that was never set up is no-server", async () => {
    const k = await daemonKit({ noGuild: true });
    await waitFor(() => k.daemon.gateway.state === "connected");
    expect(k.daemon.statusCode()).toBe("no-server");
  });

  test("READY without the server, or GUILD_DELETE for it, is not-in-server; GUILD_CREATE brings it back", async () => {
    const k = await daemonKit({ noStart: true });
    k.gateway.readyGuilds = [];
    await k.daemon.start();
    await waitFor(() => k.daemon.statusCode() === "not-in-server");
    k.gateway.dispatch("GUILD_CREATE", { id: GUILD_ID, name: "Sessions" });
    await k.connected();
    k.gateway.dispatch("GUILD_DELETE", { id: GUILD_ID, unavailable: true });
    k.gateway.dispatch("GUILD_DELETE", { id: "123456789" });
    await Bun.sleep(20);
    expect(k.daemon.statusCode()).toBe("connected");
    k.gateway.dispatch("GUILD_DELETE", { id: GUILD_ID });
    await waitFor(() => k.daemon.statusCode() === "not-in-server");
    expect((await k.call({ op: "status" })).fix).toBe("sk-discord setup invite");
  });

  test("a second daemon finds the socket in use, says already running and exits 0", async () => {
    const k = await daemonKit();
    await k.connected();
    const log = memoryLogger();
    const second = new Daemon({
      paths: k.paths,
      env: {},
      clock: k.clock,
      log,
      runner: new FakeProcessRunner(),
      keychain: new MemoryKeychain(null),
    });
    await expect(second.start()).rejects.toBeInstanceOf(AlreadyRunning);
    expect(await serveUntilStopped(second, log, new AbortController().signal)).toBe(0);
    expect(log.lines).toContain("info already running");
    // The first one is untouched.
    expect((await k.call({ op: "status" })).status).toBe("connected");
  });

  test("serveUntilStopped runs until told to stop, then removes the socket", async () => {
    const k = await daemonKit({ noStart: true, enabled: false });
    const stop = new AbortController();
    const running = serveUntilStopped(k.daemon, memoryLogger(), stop.signal);
    await waitFor(() => existsSync(k.paths.socket));
    stop.abort();
    expect(await running).toBe(0);
    expect(existsSync(k.paths.socket)).toBe(false);
  });
});

describe("daemon sessions", () => {
  test("register over the socket makes the channel and answers with it", async () => {
    const k = await daemonKit();
    await k.connected();
    const reply = await k.register(SID, "claude-desktop");
    expect(reply).toMatchObject({
      ok: true,
      registered: true,
      channelName: "session-kit-caa2-desktop",
      category: "Desktop",
      pending: false,
      status: "connected",
      notice: false,
    });
    expect(k.rest.channelNamed("session-kit-caa2-desktop")?.parent_id).toBe(k.categories.desktop.id);
  });

  test("a session that is not interactive is not registered", async () => {
    const k = await daemonKit();
    await k.connected();
    expect(await k.register(SID, "sdk-cli")).toMatchObject({ registered: false });
    expect(k.daemon.sessions.ids()).toEqual([]);
  });

  test("ended records the time and touches nothing on Discord", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    const before = k.rest.requests.length;
    expect(await k.call({ op: "ended", sessionId: SID, reason: "prompt_input_exit" })).toEqual({ ok: true });
    expect(k.daemon.sessions.get(SID)!.closedAt).toBe(k.clock.now());
    expect(k.rest.requests.length).toBe(before);
  });

  test("a session registered while offline gets its channel when the gateway connects", async () => {
    const k = await daemonKit({ noStart: true });
    k.gateway.autoHello = false;
    await k.daemon.start();
    expect(await k.register(SID)).toMatchObject({ pending: true, status: "connecting" });
    await waitFor(() => k.gateway.connections.length === 1);
    k.gateway.hello();
    await waitFor(() => k.rest.channelNamed("session-kit-caa2-cli") !== undefined);
  });

  test("CHANNEL_DELETE for a session's channel unlinks the session", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    k.rest.channels.delete(channelId);
    k.gateway.dispatch("CHANNEL_DELETE", { id: channelId, guild_id: GUILD_ID, type: 0 });
    await waitFor(() => k.daemon.sessions.get(SID)!.channelId === null);
  });

  test("a restart reloads sessions and the outbox, and unlinks sessions whose channel went away", async () => {
    const first = await daemonKit();
    await first.connected();
    await first.register(SID);
    await first.register("bbbb0000");
    const gone = first.daemon.sessions.get("bbbb0000")!.channelId!;
    await first.daemon.stop();
    first.rest.channels.delete(gone);

    const second = await daemonKit({ home: first.home, noStart: true });
    // The new fake server has no channels: bring back the one that survived.
    const kept = first.daemon.sessions.get(SID)!.channelId!;
    second.rest.addChannel({ id: kept, name: "session-kit-caa2-cli", parent_id: second.categories.cli.id });
    second.setConfig((c) => {
      c.categories = {
        desktop: second.categories.desktop.id,
        vs: second.categories.vs.id,
        cli: second.categories.cli.id,
        archive: second.categories.archive.id,
      };
    });
    await second.daemon.start();
    await second.connected();
    await second.daemon.settle();
    expect(second.daemon.sessions.get(SID)!.channelId).toBe(kept);
    expect(second.daemon.sessions.get("bbbb0000")!.channelId).toBeNull();
  });

  test("names from claude agents --json rename the channel", async () => {
    const k = await daemonKit();
    k.runner.prepend((cmd) =>
      cmd[1] === "agents"
        ? { code: 0, stdout: JSON.stringify([{ sessionId: SID, kind: "interactive", name: "Fix login bug", status: "idle", pid: 9 }]), stderr: "" }
        : undefined,
    );
    await k.connected();
    await k.register(SID);
    await k.clock.advance(0); // the first poll
    await k.daemon.settle();
    await waitFor(() => k.rest.channelNamed("fix-login-bug-cli") !== undefined);
    expect(k.daemon.sessions.get(SID)!.name).toBe("Fix login bug");
  });
});

describe("daemon inbound seam", () => {
  test("every message in the server reaches the handlers in order, with its session", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    const seen: [string | undefined, string | null][] = [];
    k.daemon.onInbound((message, session) => void seen.push([message.content, session?.sessionId ?? null]));
    k.gateway.dispatch("MESSAGE_CREATE", ownerMessage(channelId, "first"));
    k.gateway.dispatch("MESSAGE_CREATE", ownerMessage(k.control.id, "in the control channel"));
    k.gateway.dispatch("MESSAGE_CREATE", { ...ownerMessage(channelId, "other server"), guild_id: "555555555555" });
    k.gateway.dispatch("MESSAGE_CREATE", ownerMessage(channelId, "second"));
    await waitFor(() => seen.length === 3);
    await k.daemon.settle();
    expect(seen).toEqual([
      ["first", SID],
      ["in the control channel", null],
      ["second", SID],
    ]);
  });

  test("an owner message in an archived channel moves it back before the handlers see it", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    k.daemon.sessions.update(SID, (e) => {
      e.lastMessageAt -= 8 * DAY_MS;
    });
    await k.daemon.channels.sweep();
    expect(k.rest.channels.get(channelId)!.parent_id).toBe(k.categories.archive.id);
    let parentWhenDelivered: string | null = null;
    k.daemon.onInbound(() => {
      parentWhenDelivered = k.rest.channels.get(channelId)!.parent_id;
    });
    k.gateway.dispatch("MESSAGE_CREATE", ownerMessage(channelId, "are you there?"));
    await waitFor(() => parentWhenDelivered !== null);
    expect(parentWhenDelivered!).toBe(k.categories.cli.id);
    expect(k.daemon.sessions.get(SID)!.archived).toBe(false);
  });

  test("a post updates the channel's last message time", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    await k.clock.advance(5000);
    k.daemon.post(SID, "progress");
    await k.daemon.settle();
    expect(k.daemon.sessions.get(SID)!.lastMessageAt).toBe(k.clock.now());
  });

  test("a tagged post reports its message id once it is out", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    const posted: { tag: string | null; messageId: string }[] = [];
    k.daemon.onPosted((e) => posted.push({ tag: e.tag, messageId: e.messageId }));
    k.daemon.post(SID, "question 1", { tag: "q-1", ping: true });
    await waitFor(() => posted.length === 1);
    expect(posted[0]!.tag).toBe("q-1");
    expect(k.rest.posted().find((m) => m.id === posted[0]!.messageId)?.content).toBe(`<@${OWNER_ID}> question 1`);
  });

  test("post to control goes to #session-kit", async () => {
    const k = await daemonKit();
    await k.connected();
    k.daemon.post("control", "hello from the helper");
    await waitFor(() => k.rest.posted(k.control.id).length === 1);
  });
});

describe("extensions", () => {
  test("an extension adds a socket op when the daemon is built", async () => {
    const k = await daemonKit({ noStart: true });
    const daemon = new Daemon({
      paths: k.paths,
      env: {},
      clock: k.clock,
      log: memoryLogger(),
      runner: new FakeProcessRunner(),
      keychain: new MemoryKeychain(null),
      extensions: [(d) => d.handlers.add("hello", () => ({ from: "extension" }))],
    });
    await daemon.start();
    try {
      expect(await k.call({ op: "hello" })).toEqual({ ok: true, from: "extension" });
    } finally {
      await daemon.stop();
    }
  });
});

describe("reload", () => {
  test("turning Discord on connects; turning it off disconnects but keeps the socket", async () => {
    const k = await daemonKit({ enabled: false });
    k.setConfig((c) => {
      c.enabled = true;
    });
    expect((await k.call({ op: "reload" })).status).toMatch(/connect/);
    await k.connected();
    k.setConfig((c) => {
      c.enabled = false;
    });
    expect(await k.call({ op: "reload" })).toMatchObject({ status: "off" });
    await waitFor(() => k.gateway.latest!.closed);
    expect((await k.call({ op: "status" })).status).toBe("off");
  });

  test("a new token after a rejected one reconnects", async () => {
    const k = await daemonKit({ noStart: true });
    k.gateway.closeOnIdentify = 4004;
    await k.daemon.start();
    await waitFor(() => k.daemon.statusCode() === "token-rejected");
    k.gateway.closeOnIdentify = null;
    k.keychain.token = "Bnew0000000000000000000000.Gxyzzy.abcdefghijklmnopqrstuvwxyz0000000000";
    await k.call({ op: "reload" });
    await k.connected();
  });

  test("an unknown op is refused with its name", async () => {
    const k = await daemonKit();
    const error = await k.call({ op: "frobnicate", sessionId: SID }).catch((e) => e);
    expect(error).toBeInstanceOf(HelperError);
    expect(error).toMatchObject({ code: "unknown-op" });
  });
});

describe("sk-discord status", () => {
  test("prints the state, the problem and the fix", async () => {
    const k = await daemonKit({ token: null });
    const r = await k.cli(["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "no-token",
        "Problem: there is no bot token in the Keychain",
        "Fix: sk-discord setup token",
        "Sessions: 0 (0 with a channel, 0 archived)",
        "",
      ].join("\n"),
    );
  });

  test("--json prints the fields as one JSON object", async () => {
    const k = await daemonKit();
    await k.connected();
    const r = await k.cli(["status", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ status: "connected", sessions: 0, outbox: 0, version: expect.any(String) });
  });

  test("with the helper down it says how to start it and exits 2", async () => {
    const k = await daemonKit({ noStart: true });
    const r = await k.cli(["status"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("launchctl kickstart -k gui/$UID/io.github.ducky8x.session-kit.discord");
  });
});

describe("sk-discord daemon", () => {
  test("runs the daemon it is given and returns its exit code", async () => {
    const { runCli } = await import("../src/main.ts");
    let ran = false;
    const code = await runCli(["daemon"], {
      home: "/nonexistent",
      env: {},
      cwd: "/",
      out: () => {},
      err: () => {},
      readStdin: async () => "",
      runDaemon: async () => {
        ran = true;
        return 0;
      },
    });
    expect(ran).toBe(true);
    expect(code).toBe(0);
  });
});
