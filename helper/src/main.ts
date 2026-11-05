#!/usr/bin/env bun
import { homedir } from "node:os";
import { type CallHelper, HelperError, NOT_RUNNING, callHelper } from "./client.ts";
import { runDaemon } from "./run-daemon.ts";
import { notificationHook } from "./hooks/notification.ts";
import { stopHook } from "./hooks/stop.ts";
import { listenCommand } from "./listen.ts";
import { sessionEndHook } from "./hooks/session-end.ts";
import { type HookDeps, sessionStartHook } from "./hooks/session-start.ts";
import { pathsFor } from "./paths.ts";
import { sendCommand } from "./send.ts";
import { HELPER_DOWN } from "./status.ts";
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
};

/** How long `status` waits for the helper. */
const STATUS_TIMEOUT_MS = 2000;

async function statusCommand(args: string[], deps: CliDeps): Promise<number> {
  let reply: Record<string, any>;
  try {
    reply = await (deps.call ?? callHelper)(pathsFor(deps.home).socket, { op: "status" }, { timeoutMs: STATUS_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof HelperError && error.code === NOT_RUNNING) {
      deps.err(`${HELPER_DOWN}\n`);
      return 2;
    }
    deps.err(`${(error as Error).message}\n`);
    return 1;
  }
  if (args.includes("--json")) {
    const { ok: _ok, ...fields } = reply;
    deps.out(`${JSON.stringify(fields)}\n`);
    return 0;
  }
  const lines = [`${reply.status}`];
  if (reply.fix) lines.push(`Problem: ${reply.problem}`, `Fix: ${reply.fix}`);
  lines.push(`Sessions: ${reply.sessions} (${reply.linked} with a channel, ${reply.archived} archived)`);
  if (reply.outbox > 0) lines.push(`Posts waiting: ${reply.outbox}`);
  deps.out(`${lines.join("\n")}\n`);
  return 0;
}

export const USAGE = `sk-discord: the Discord helper for session-kit

  sk-discord send --session <id> [--ping] [--done] "<text>"
                                        post in the session's channel ("-" reads stdin)
  sk-discord listen --session <id>      wait for one event for the session and print it as JSON
  sk-discord status [--json]            show what the helper is doing
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
  status: statusCommand,
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
  };
  process.exit(await runCli(process.argv.slice(2), deps));
}
