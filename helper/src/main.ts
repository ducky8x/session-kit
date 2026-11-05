#!/usr/bin/env bun
import { homedir } from "node:os";
import { type CallHelper, callHelper } from "./client.ts";
import { runDaemon } from "./run-daemon.ts";
import { notificationHook } from "./hooks/notification.ts";
import { postAskHook, preAskHook, promptHook } from "./hooks/ask.ts";
import { stopHook } from "./hooks/stop.ts";
import { listenCommand } from "./listen.ts";
import { sessionEndHook } from "./hooks/session-end.ts";
import { type HookDeps, sessionStartHook } from "./hooks/session-start.ts";
import { realClock, type Clock } from "./clock.ts";
import { pathsFor } from "./paths.ts";
import { type ProcessRunner, realProcessRunner } from "./process.ts";
import { type Keychain, SecurityKeychain } from "./secrets.ts";
import { sendCommand } from "./send.ts";
import { type SetupDeps, offCommand, onCommand, setupCommand, statusCommand } from "./setup.ts";
import { readSecret } from "./tty.ts";
import { updateCommand } from "./update.ts";
import { VERSION } from "./version.ts";

/** What every command gets from the outside world. Tests pass fakes; `main` passes the real things. */
export interface CliDeps {
  /** The user's home folder. Everything the helper keeps is under `~/.claude/session-kit/`. */
  home: string;
  env: Record<string, string | undefined>;
  /** The folder the command was run from. */
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
  /** `process.platform` unless a test says otherwise. */
  platform?: string;
  /** How commands reach the helper. Defaults to the real control socket. */
  call?: CallHelper;
  /** Tests shorten the hooks' socket waits. */
  socketTimeoutMs?: number;
  /** `sk-discord daemon`. Defaults to the real daemon; tests never start it this way. */
  runDaemon?: () => Promise<number>;
  /** The rest default to the real things, which tests must never reach (see `real`). */
  runner?: ProcessRunner;
  keychain?: Keychain;
  clock?: Clock;
  /** Reads the bot token for `setup token`. Without it, stdin is read. */
  readSecret?: (prompt: string) => Promise<string>;
  which?: (command: string) => string | null;
  restBaseUrl?: string;
  releaseBaseUrl?: string;
  fetch?: typeof fetch;
  /** `process.arch` and the user id, for `update` and `launchctl`. */
  arch?: string;
  uid?: number;
}

type Command = (args: string[], deps: CliDeps) => Promise<number>;

function hookDeps(deps: CliDeps): HookDeps {
  return {
    paths: pathsFor(deps.home),
    env: deps.env,
    platform: deps.platform ?? process.platform,
    readStdin: deps.readStdin,
    out: deps.out,
    call: deps.call ?? callHelper,
    ...(deps.socketTimeoutMs === undefined ? {} : { timeoutMs: deps.socketTimeoutMs }),
  };
}

type Hook = (deps: HookDeps) => Promise<number>;

/**
 * Hook events, by name. The bash wrapper runs `sk-discord hook <event>` with the hook's JSON on stdin and
 * shows what it prints only when it exits 0.
 */
export const HOOKS: Record<string, Hook> = {
  "session-start": sessionStartHook,
  "session-end": sessionEndHook,
  notification: notificationHook,
  stop: stopHook,
  "pre-ask": preAskHook,
  "post-ask": postAskHook,
  prompt: promptHook,
};

/** Only the real binary may reach the Keychain, launchctl or other programs; a test that gets here is a bug. */
function real<T>(what: string, make: () => T): T {
  if (process.env.NODE_ENV === "test") throw new Error(`a test reached the real ${what}; pass a fake in CliDeps`);
  return make();
}

function setupDeps(deps: CliDeps): SetupDeps {
  const runner = deps.runner ?? real("process runner", () => realProcessRunner);
  return {
    paths: pathsFor(deps.home),
    keychain: deps.keychain ?? real("Keychain", () => new SecurityKeychain(runner)),
    runner,
    clock: deps.clock ?? realClock,
    call: deps.call ?? callHelper,
    out: deps.out,
    err: deps.err,
    readSecret: deps.readSecret ?? (async () => deps.readStdin()),
    which: deps.which ?? ((command) => Bun.which(command)),
    uid: deps.uid ?? process.getuid?.() ?? 0,
    ...(deps.restBaseUrl ? { restBaseUrl: deps.restBaseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
}

export const USAGE = `sk-discord: the Discord helper for session-kit

  sk-discord send --session <id> [--ping] [--done] "<text>"
                                        post in the session's channel ("-" reads stdin)
  sk-discord listen --session <id>      wait for one event for the session and print it as JSON
  sk-discord status [--json]            show what the helper is doing, and the fix when something is wrong
  sk-discord on | off                   turn Discord on or off (the setup is kept)
  sk-discord setup token                save the bot token in the Keychain (run it in your own terminal)
  sk-discord setup invite --app-id <id> print the link that adds the bot to your server
  sk-discord setup server [--guild <id>]
                                        pick the server and make its categories and #session-kit
  sk-discord setup launch-agent         install the LaunchAgent that runs the helper
  sk-discord update --version <v>       install that release of the helper and restart it
  sk-discord daemon                     run the helper (the LaunchAgent starts it)
  sk-discord hook <event>               run a session hook (JSON on stdin)
  sk-discord --version                  print the helper's version
  sk-discord help                       print this help`;

/** The commands, by their first word. */
export const COMMANDS: Record<string, Command> = {
  send: (args, deps) =>
    sendCommand(args, {
      paths: pathsFor(deps.home),
      env: deps.env,
      cwd: deps.cwd,
      readStdin: deps.readStdin,
      err: deps.err,
      call: deps.call ?? callHelper,
    }),
  status: (args, deps) => statusCommand(args, setupDeps(deps)),
  setup: (args, deps) => setupCommand(args, setupDeps(deps)),
  on: (_args, deps) => onCommand(setupDeps(deps)),
  off: (_args, deps) => offCommand(setupDeps(deps)),
  update: (args, deps) =>
    updateCommand(args, {
      paths: pathsFor(deps.home),
      runner: deps.runner ?? real("process runner", () => realProcessRunner),
      fetch: deps.fetch ?? fetch,
      arch: deps.arch ?? process.arch,
      uid: deps.uid ?? process.getuid?.() ?? 0,
      now: () => (deps.clock ?? realClock).now(),
      out: deps.out,
      err: deps.err,
      ...(deps.releaseBaseUrl ? { releaseBaseUrl: deps.releaseBaseUrl } : {}),
    }),
  listen: (args, deps) =>
    listenCommand(args, { paths: pathsFor(deps.home), out: deps.out, err: deps.err, call: deps.call ?? callHelper }),
  daemon: (_args, deps) => (deps.runDaemon ? deps.runDaemon() : runDaemon({ home: deps.home, env: deps.env })),
  hook: async (args, deps) => {
    const hook = HOOKS[args[0] ?? ""];
    // An event this version does not handle yet is not an error: the wrapper may be newer than the binary.
    return hook ? hook(hookDeps(deps)) : 0;
  },
};

/** Run one `sk-discord` command and return its exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      deps.err(`${USAGE}\n`);
      return 1;
    case "help":
    case "--help":
    case "-h":
      deps.out(`${USAGE}\n`);
      return 0;
    case "--version":
    case "version":
      deps.out(`${VERSION}\n`);
      return 0;
  }
  const run = COMMANDS[command];
  if (!run) {
    deps.err(`Unknown command "${command}". Run "sk-discord help" for the list.\n`);
    return 1;
  }
  return run(rest, deps);
}

if (import.meta.main) {
  const deps: CliDeps = {
    home: homedir(),
    env: process.env,
    cwd: process.cwd(),
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    readStdin: () => Bun.stdin.text(),
    readSecret,
  };
  process.exit(await runCli(process.argv.slice(2), deps));
}
