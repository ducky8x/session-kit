import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.ts";
import { LAUNCH_AGENT_LABEL, launchAgentPlist } from "../src/launchagent.ts";
import { type CliDeps, runCli } from "../src/main.ts";
import { pathsFor } from "../src/paths.ts";
import { INVITE_PERMISSIONS, NOTIFICATION_REMINDER } from "../src/setup.ts";
import { MemoryKeychain } from "./fakes/fake-keychain.ts";
import { FakeProcessRunner } from "./fakes/fake-process.ts";
import { FakeDiscordRest, GUILD_ID, OWNER_ID } from "./fakes/fake-rest.ts";
import { tmpDir } from "./helpers/tmp.ts";

const TOKEN = "FAKE00000000000000000000.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";

const fakes: FakeDiscordRest[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

async function harness(o: { token?: string | null; stdin?: string; withRest?: boolean } = {}) {
  const home = tmpDir();
  const paths = pathsFor(home);
  const keychain = new MemoryKeychain(o.token === undefined ? TOKEN : o.token);
  const runner = new FakeProcessRunner();
  const rest = await FakeDiscordRest.start();
  fakes.push(rest);
  let stdin = o.stdin ?? "";
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    home,
    env: { PATH: "/usr/bin:/bin" },
    cwd: "/",
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    readStdin: async () => stdin,
    keychain,
    runner,
    restBaseUrl: rest.baseUrl,
    uid: 501,
    which: (command) => (command === "claude" ? "/opt/tools/claude" : null),
  };
  const run = async (argv: string[], input?: string) => {
    if (input !== undefined) stdin = input;
    out.length = 0;
    err.length = 0;
    const code = await runCli(argv, deps);
    return { code, out: out.join(""), err: err.join("") };
  };
  return { home, paths, keychain, runner, rest, run };
}

describe("setup token", () => {
  test("stores what is on stdin in the Keychain and never prints it", async () => {
    const h = await harness({ token: null });
    const r = await h.run(["setup", "token"], `${TOKEN}\n`);
    expect(r.code).toBe(0);
    expect(h.keychain.token).toBe(TOKEN);
    expect(`${r.out}${r.err}`).not.toContain(TOKEN);
    expect(r.out).toContain("Saved the bot token in the Keychain.");
  });

  test("refuses something that is not a token, and saves nothing", async () => {
    const h = await harness({ token: null });
    const r = await h.run(["setup", "token"], "not a token\n");
    expect(r.code).toBe(1);
    expect(h.keychain.token).toBeNull();
    expect(r.err).not.toContain("not a token");
  });

  test("a token Discord rejects is not saved", async () => {
    const h = await harness({ token: null });
    h.rest.failNext({ path: "/users/@me", status: 401, body: { message: "401: Unauthorized", code: 0 } });
    const r = await h.run(["setup", "token"], TOKEN);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Discord rejected");
    expect(h.keychain.token).toBeNull();
  });
});

describe("setup invite", () => {
  test("prints the link with permissions=68624 and remembers the application", async () => {
    const h = await harness();
    const r = await h.run(["setup", "invite", "--app-id", "123"]);
    expect(r.code).toBe(0);
    expect(INVITE_PERMISSIONS).toBe(68624);
    expect(r.out).toContain("https://discord.com/oauth2/authorize?client_id=123&scope=bot&permissions=68624");
    expect(loadConfig(h.paths)).toMatchObject({ applicationId: "123", offered: true });
  });

  test("needs a numeric application id", async () => {
    const h = await harness();
    expect((await h.run(["setup", "invite"])).code).toBe(1);
    expect((await h.run(["setup", "invite", "--app-id", "abc"])).code).toBe(1);
  });
});

describe("setup server", () => {
  test("with one server it picks it, names the owner and makes the categories and #session-kit", async () => {
    const h = await harness();
    const r = await h.run(["setup", "server"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Server: Sessions (${GUILD_ID})`);
    expect(r.out).toContain(`Owner: Owner (@owner, id ${OWNER_ID})`);
    const categories = [...h.rest.channels.values()].filter((c) => c.type === 4).map((c) => c.name);
    expect(categories).toEqual(["Desktop", "VS Code", "CLI", "Archive"]);
    const control = h.rest.channelNamed("session-kit")!;
    expect(control.type).toBe(0);
    const config = loadConfig(h.paths);
    expect(config).toMatchObject({
      guildId: GUILD_ID,
      ownerId: OWNER_ID,
      controlChannelId: control.id,
      offered: true,
      claudePath: "/opt/tools/claude",
    });
    expect(Object.keys(config.categories).sort()).toEqual(["archive", "cli", "desktop", "vs"]);
    const welcome = h.rest.posted(control.id);
    expect(welcome).toHaveLength(1);
    expect(welcome[0]!.content).toContain(NOTIFICATION_REMINDER);
    expect(NOTIFICATION_REMINDER).toBe(
      "Keep Discord notifications on. Set this server to All Messages (server name > Notification Settings) so every post reaches you; the bot @mentions you only when a session is waiting on you.",
    );
    expect(welcome[0]!.content).toContain("Keep this server to yourself");
    expect(welcome[0]!.allowed_mentions).toEqual({ parse: [] });
  });

  test("a second run reuses what is there and posts no second welcome", async () => {
    const h = await harness();
    await h.run(["setup", "server"]);
    const before = h.rest.channels.size;
    const r = await h.run(["setup", "server"]);
    expect(r.code).toBe(0);
    expect(h.rest.channels.size).toBe(before);
    expect(h.rest.posted()).toHaveLength(1);
  });

  test("with several servers it lists them and asks for --guild, changing nothing", async () => {
    const h = await harness();
    h.rest.guilds.push({ id: "100000000000000099", name: "Other", owner_id: OWNER_ID });
    const r = await h.run(["setup", "server"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain(`${GUILD_ID}  Sessions`);
    expect(r.out).toContain("100000000000000099  Other");
    expect(r.out).toContain("sk-discord setup server --guild <id>");
    expect(h.rest.requestsMatching("POST", /channels$/)).toHaveLength(0);
    expect((await h.run(["setup", "server", "--guild", GUILD_ID])).code).toBe(0);
    expect(loadConfig(h.paths).guildId).toBe(GUILD_ID);
  });

  test("no token, or a bot in no server, says what to do first", async () => {
    const none = await harness({ token: null });
    const r = await none.run(["setup", "server"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sk-discord setup token");
    const lonely = await harness();
    lonely.rest.guilds = [];
    const r2 = await lonely.run(["setup", "server"]);
    expect(r2.code).toBe(1);
    expect(r2.err).toContain("sk-discord setup invite");
  });
});

describe("setup launch-agent", () => {
  test("writes the plist and loads it through launchctl, never the real one", async () => {
    const h = await harness();
    const r = await h.run(["setup", "launch-agent"]);
    expect(r.code).toBe(0);
    const file = `${h.home}/Library/LaunchAgents/io.github.ducky8x.session-kit.discord.plist`;
    expect(existsSync(file)).toBe(true);
    const plist = readFileSync(file, "utf8");
    expect(plist).toBe(launchAgentPlist(h.paths));
    expect(LAUNCH_AGENT_LABEL).toBe("io.github.ducky8x.session-kit.discord");
    expect(plist).toContain("<string>io.github.ducky8x.session-kit.discord</string>");
    expect(plist).toContain(`<string>${h.paths.bin}</string>\n    <string>daemon</string>`);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toContain(`<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${h.home}/.local/bin</string>`);
    expect(plist.match(new RegExp(`<string>${h.paths.log}</string>`, "g"))).toHaveLength(2);
    expect(h.runner.commands).toEqual([
      "/bin/launchctl bootout gui/501/io.github.ducky8x.session-kit.discord",
      `/bin/launchctl bootstrap gui/501 ${file}`,
    ]);
  });

  test("a failed bootstrap says so", async () => {
    const h = await harness();
    h.runner.answer(["/bin/launchctl", "bootstrap"], { code: 5, stderr: "Bootstrap failed: 5: Input/output error" });
    const r = await h.run(["setup", "launch-agent"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Bootstrap failed");
  });
});

describe("on and off", () => {
  test("on turns Discord on and marks it offered; off turns it off", async () => {
    const h = await harness();
    saveConfig(h.paths, { ...defaultConfig() });
    const on = await h.run(["on"]);
    expect(on.code).toBe(0);
    expect(on.out).toContain("Discord is on.");
    expect(loadConfig(h.paths)).toMatchObject({ enabled: true, offered: true });
    const off = await h.run(["off"]);
    expect(off.code).toBe(0);
    expect(off.out).toContain("Discord is off.");
    expect(loadConfig(h.paths)).toMatchObject({ enabled: false, offered: true });
  });
});
