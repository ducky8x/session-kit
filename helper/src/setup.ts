import { HelperError, NOT_RUNNING, type CallHelper } from "./client.ts";
import { type Config, configExists, loadConfig, updateConfig } from "./config.ts";
import { RestClient, RestError } from "./discord/rest.ts";
import { installLaunchAgent } from "./launchagent.ts";
import type { Clock } from "./clock.ts";
import { silentLogger } from "./log.ts";
import type { Paths } from "./paths.ts";
import type { ProcessRunner } from "./process.ts";
import { type Keychain, isPlausibleToken } from "./secrets.ts";
import { HELPER_DOWN, STATUS_PROBLEMS, type StatusCode } from "./status.ts";
import { installed, readUpdateFailure } from "./update.ts";

/** Manage Channels (16), View Channels (1024), Send Messages (2048), Read Message History (65536). */
export const INVITE_PERMISSIONS = 16 + 1024 + 2048 + 65536;

export const NOTIFICATION_REMINDER =
  "Keep Discord notifications on. Set this server to All Messages (server name > Notification Settings) so every post reaches you; the bot @mentions you only when a session is waiting on you.";

export const WELCOME = [
  "session-kit is connected. Every Claude Code session gets its own channel here, under Desktop, VS Code or CLI. A channel with no messages for a week moves to Archive, and after a month it's deleted.",
  NOTIFICATION_REMINDER,
  "Keep this server to yourself: anyone added to it can read every session's posts.",
  "Type `status` here to list the linked sessions.",
].join("\n\n");

const CATEGORIES: [key: string, name: string][] = [
  ["desktop", "Desktop"],
  ["vs", "VS Code"],
  ["cli", "CLI"],
  ["archive", "Archive"],
];
const CONTROL_CHANNEL = "session-kit";

/** `setup server` exits with this when there are several servers to choose from. */
export const CHOOSE_SERVER = 3;

export interface SetupDeps {
  paths: Paths;
  keychain: Keychain;
  runner: ProcessRunner;
  clock: Clock;
  call: CallHelper;
  out(text: string): void;
  err(text: string): void;
  /** Reads the token: hidden from the terminal, or stdin when it is piped. */
  readSecret(prompt: string): Promise<string>;
  /** Finds a command on PATH (to record where `claude` is). */
  which(command: string): string | null;
  restBaseUrl?: string;
  fetch?: typeof fetch;
  uid: number;
}

function rest(d: SetupDeps, token: string): RestClient {
  return new RestClient({
    token: () => token,
    clock: d.clock,
    log: silentLogger,
    maxRetries: 2,
    ...(d.restBaseUrl ? { baseUrl: d.restBaseUrl } : {}),
    ...(d.fetch ? { fetch: d.fetch } : {}),
  });
}

/** Change `config.json`, which also marks the feature as offered (setup only runs after the offer). */
function remember(d: SetupDeps, mutate: (c: Config) => void): void {
  updateConfig(d.paths, (c) => {
    c.offered = true;
    if (c.claudePath === null) c.claudePath = d.which("claude");
    mutate(c);
  });
}

/** Ask a running helper to read `config.json` and the token again. Quietly does nothing when it isn't running. */
async function reloadHelper(d: SetupDeps): Promise<void> {
  try {
    await d.call(d.paths.socket, { op: "reload" }, { timeoutMs: 5000 });
  } catch {
    // not running yet: it reads everything when it starts
  }
}

function flag(args: readonly string[], name: string): string | null {
  const at = args.indexOf(name);
  if (at >= 0) return args[at + 1] ?? null;
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

/** `setup token`: read the bot token without showing it, check it with Discord, and keep it in the Keychain. */
async function setupToken(d: SetupDeps): Promise<number> {
  let token: string;
  try {
    token = (await d.readSecret("Paste the bot token (it stays hidden), then press Return: ")).trim();
  } catch (error) {
    // Ctrl-C or Ctrl-D at the prompt, or stdin couldn't be read
    d.err(`${(error as Error).message} Nothing was saved.\n`);
    return 1;
  }
  if (!isPlausibleToken(token)) {
    // Never show any of what was read, or its length: it may be most of a real token.
    d.err(
      [
        "That doesn't look like a bot token (three parts separated by dots). Nothing was saved.",
        "If pasting at the hidden prompt keeps failing, copy the token from the portal's Bot page (Reset Token shows a new one) and run this in your terminal instead:",
        "  pbpaste | ~/.claude/session-kit/bin/sk-discord setup token",
        "Then clear the clipboard so the token doesn't stay on it:",
        "  pbcopy < /dev/null",
        "",
      ].join("\n"),
    );
    return 1;
  }
  try {
    await rest(d, token).request("GET", "/users/@me");
  } catch (error) {
    if (error instanceof RestError && error.status === 401) {
      d.err("Discord rejected that token. Copy a fresh one from the Bot page (Reset Token) and try again. Nothing was saved.\n");
      return 1;
    }
    d.out("Couldn't reach Discord to check the token; saving it anyway.\n");
  }
  try {
    await d.keychain.setToken(token);
  } catch (error) {
    d.err(`Couldn't save the token in the Keychain: ${(error as Error).message}\n`);
    return 1;
  }
  d.out("Saved the bot token in the Keychain.\n");
  await reloadHelper(d);
  return 0;
}

/** `setup invite --app-id <id>`: print the link that adds the bot to a server. */
function setupInvite(args: readonly string[], d: SetupDeps): number {
  const appId = flag(args, "--app-id");
  if (appId === null || !/^\d+$/.test(appId)) {
    d.err("usage: sk-discord setup invite --app-id <application id> (the number on the portal's General Information page)\n");
    return 1;
  }
  remember(d, (c) => {
    c.applicationId = appId;
  });
  d.out(
    `Open this link, pick your server and authorize the bot:\nhttps://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${INVITE_PERMISSIONS}\n`,
  );
  return 0;
}

interface Guild {
  id: string;
  name: string;
}

interface Channel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
}

/**
 * `setup server [--guild <id>]`: pick the server (the only one, or the one given), name its owner for the
 * user to confirm, make the four categories and `#session-kit` (reusing any that exist) and post a welcome.
 * Never prompts: with several servers it lists them and exits 3.
 */
async function setupServer(args: readonly string[], d: SetupDeps): Promise<number> {
  const token = await d.keychain.getToken().catch(() => null);
  if (token === null) {
    d.err("There is no bot token yet. Run sk-discord setup token in your own terminal first.\n");
    return 1;
  }
  const api = rest(d, token);
  try {
    const guilds = (await api.request<Guild[]>("GET", "/users/@me/guilds")) ?? [];
    const wanted = flag(args, "--guild");
    if (guilds.length === 0) {
      d.err("The bot isn't in any server yet. Run sk-discord setup invite --app-id <id> and open the link it prints.\n");
      return 1;
    }
    let guild: Guild | undefined;
    if (wanted !== null) {
      guild = guilds.find((g) => g.id === wanted);
      if (!guild) {
        d.err(`The bot isn't in a server with id ${wanted}.\n`);
        return 1;
      }
    } else if (guilds.length === 1) {
      guild = guilds[0];
    } else {
      d.out(`The bot is in ${guilds.length} servers:\n`);
      for (const g of guilds) d.out(`${g.id}  ${g.name}\n`);
      d.out("Pick one and run: sk-discord setup server --guild <id>\n");
      return CHOOSE_SERVER;
    }
    const g = guild!;
    const details = await api.request<{ owner_id?: string; name?: string }>("GET", `/guilds/${g.id}`);
    const ownerId = details?.owner_id;
    if (typeof ownerId !== "string") {
      d.err("Discord didn't say who owns the server.\n");
      return 1;
    }
    const owner = await api.request<{ username?: string; global_name?: string | null }>("GET", `/users/${ownerId}`);
    const username = owner?.username ?? "unknown";
    const display = owner?.global_name || username;

    const channels = (await api.request<Channel[]>("GET", `/guilds/${g.id}/channels`)) ?? [];
    const config = loadConfig(d.paths);
    const categories: Record<string, string> = {};
    let made = 0;
    for (const [key, name] of CATEGORIES) {
      const known = config.categories[key];
      const existing =
        channels.find((c) => c.id === known && c.type === 4) ?? channels.find((c) => c.type === 4 && c.name === name);
      if (existing) {
        categories[key] = existing.id;
        continue;
      }
      const created = await api.request<Channel>("POST", `/guilds/${g.id}/channels`, { body: { name, type: 4 } });
      categories[key] = created.id;
      made++;
    }
    let control =
      channels.find((c) => c.id === config.controlChannelId && c.type === 0) ??
      channels.find((c) => c.type === 0 && c.name === CONTROL_CHANNEL);
    const fresh = !control;
    if (!control) {
      control = await api.request<Channel>("POST", `/guilds/${g.id}/channels`, {
        body: { name: CONTROL_CHANNEL, type: 0, topic: "session-kit: notices, and `status` for every linked session" },
      });
      made++;
    }
    remember(d, (c) => {
      c.guildId = g.id;
      c.ownerId = ownerId;
      c.controlChannelId = control!.id;
      c.categories = { ...c.categories, ...categories };
    });
    if (fresh) {
      await api.request("POST", `/channels/${control.id}/messages`, { body: { content: WELCOME, allowed_mentions: { parse: [] } } });
    }
    d.out(`Server: ${g.name} (${g.id})\n`);
    d.out(`Owner: ${display} (@${username}, id ${ownerId}). Only this account's messages reach sessions; confirm it is yours.\n`);
    d.out(
      made === 0
        ? "Desktop, VS Code, CLI, Archive and #session-kit were already there.\n"
        : "Made the categories Desktop, VS Code, CLI and Archive and the #session-kit channel (reusing any that existed), and posted a welcome.\n",
    );
    await reloadHelper(d);
    return 0;
  } catch (error) {
    if (error instanceof RestError && error.status === 403) {
      d.err("Discord refused: the bot may be missing Manage Channels. Add it again with the link from sk-discord setup invite.\n");
    } else if (error instanceof RestError && error.status === 401) {
      d.err("Discord rejected the bot token. Run sk-discord setup token with a fresh one.\n");
    } else {
      d.err(`Setting up the server failed: ${(error as Error).message}\n`);
    }
    return 1;
  }
}

async function setupLaunchAgent(d: SetupDeps): Promise<number> {
  remember(d, () => {});
  const problem = await installLaunchAgent(d.paths, d.runner, d.uid);
  if (problem !== null) {
    d.err(`Couldn't load the LaunchAgent: ${problem}\n`);
    return 1;
  }
  d.out("Installed the LaunchAgent; the helper starts now and at every login.\n");
  return 0;
}

export const SETUP_USAGE = `usage:
  sk-discord setup token                     save the bot token in the Keychain (hidden input; run it in your own terminal)
  sk-discord setup invite --app-id <id>      print the link that adds the bot to your server
  sk-discord setup server [--guild <id>]     pick the server, name its owner, make the categories and #session-kit
  sk-discord setup launch-agent              install the LaunchAgent that runs the helper`;

export async function setupCommand(args: readonly string[], d: SetupDeps): Promise<number> {
  const [step, ...rest] = args;
  switch (step) {
    case "token":
      return setupToken(d);
    case "invite":
      return setupInvite(rest, d);
    case "server":
      return setupServer(rest, d);
    case "launch-agent":
      return setupLaunchAgent(d);
    default:
      d.err(`${SETUP_USAGE}\n`);
      return 1;
  }
}

/** `on`: turn the feature on (keeping the setup) and tell a running helper. */
export async function onCommand(d: SetupDeps): Promise<number> {
  remember(d, (c) => {
    c.enabled = true;
  });
  await reloadHelper(d);
  d.out("Discord is on.\n");
  return 0;
}

/** `off`: turn it off. The helper keeps running (for `status` and `on`); channels stay and age out. */
export async function offCommand(d: SetupDeps): Promise<number> {
  remember(d, (c) => {
    c.enabled = false;
  });
  await reloadHelper(d);
  d.out("Discord is off. No new channels or posts; existing channels stay and age out. /discord on turns it back on.\n");
  return 0;
}

/**
 * What `status` can tell with the helper not running: the binary is missing, there is no token, Discord is off,
 * no server is set up, or the last update failed. Null: everything it can see is fine, so the helper itself
 * is the problem.
 */
export async function offlineStatus(d: SetupDeps): Promise<StatusCode | null> {
  if (!installed(d.paths)) return "not-installed";
  const token = await d.keychain.getToken().catch(() => null);
  if (token === null) return "no-token";
  if (!configExists(d.paths) || !loadConfig(d.paths).enabled) return "off";
  if (loadConfig(d.paths).guildId === null) return "no-server";
  if (readUpdateFailure(d.paths) !== null) return "update-failed";
  return null;
}

/** `status [--json]`. */
export async function statusCommand(args: readonly string[], d: SetupDeps): Promise<number> {
  const json = args.includes("--json");
  let reply: Record<string, any>;
  try {
    reply = await d.call(d.paths.socket, { op: "status" }, { timeoutMs: 2000 });
  } catch (error) {
    if (!(error instanceof HelperError && error.code === NOT_RUNNING)) {
      d.err(`${(error as Error).message}\n`);
      return 1;
    }
    const code = await offlineStatus(d);
    if (code === null) {
      if (json) d.out(`${JSON.stringify({ status: "not-running", fix: HELPER_DOWN })}\n`);
      d.err(`${HELPER_DOWN}\n`);
      return 2;
    }
    const problem = STATUS_PROBLEMS[code]!;
    reply = { status: code, problem: problem.problem, fix: problem.fix, running: false };
  }
  const { ok: _ok, ...fields } = reply;
  if (json) {
    d.out(`${JSON.stringify(fields)}\n`);
    return 0;
  }
  const lines = [`${fields.status}`];
  if (fields.fix) lines.push(`Problem: ${fields.problem}`, `Fix: ${fields.fix}`);
  if (fields.running === false) lines.push("The helper isn't running yet.");
  else lines.push(`Sessions: ${fields.sessions} (${fields.linked} with a channel, ${fields.archived} archived)`);
  if (fields.outbox > 0) lines.push(`Posts waiting: ${fields.outbox}`);
  d.out(`${lines.join("\n")}\n`);
  return 0;
}
