import { join } from "node:path";

/** Where the helper keeps its files. Everything is under `~/.claude/session-kit/`. */
export interface Paths {
  home: string;
  /** `~/.claude/session-kit/discord`, user-only (0700). */
  dir: string;
  config: string;
  sessions: string;
  outbox: string;
  log: string;
  /** The control socket (0600). */
  socket: string;
  /** Where the installed binary lives. */
  bin: string;
}

export function pathsFor(home: string): Paths {
  const kit = join(home, ".claude", "session-kit");
  const dir = join(kit, "discord");
  return {
    home,
    dir,
    config: join(dir, "config.json"),
    sessions: join(dir, "sessions.json"),
    outbox: join(dir, "outbox.jsonl"),
    log: join(dir, "helper.log"),
    socket: join(dir, "helper.sock"),
    bin: join(kit, "bin", "sk-discord"),
  };
}
