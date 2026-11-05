#!/usr/bin/env bun
import { homedir } from "node:os";
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
}

type Command = (args: string[], deps: CliDeps) => Promise<number>;

export const USAGE = `sk-discord: the Discord helper for session-kit

  sk-discord --version                  print the helper's version
  sk-discord help                       print this help`;

/** The commands, by their first word. */
const COMMANDS: Record<string, Command> = {};

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
