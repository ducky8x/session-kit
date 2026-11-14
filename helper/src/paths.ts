import { join } from "node:path";

/** Where the helper keeps its files. Everything is under `~/.claude/session-kit/`. */
export interface Paths {
  home: string;
  /** `~/.claude/session-kit/discord`, user-only (0700). */
  dir: string;
  config: string;
  sessions: string;
  outbox: string;
  /** The newest message seen in each channel the helper reads (see `poller.ts`). */
  cursors: string;
  log: string;
  /** The control socket (0600). */
  socket: string;
  /** Where the installed binary lives. */
  bin: string;
  /** Held while `update` replaces the binary, so two updates never run at once. */
  updateLock: string;
  /** Written when an update fails (what and why), removed when one works. */
  updateState: string;
  /** The LaunchAgent that starts the helper at login. */
  launchAgent: string;
  /** Where the Claude desktop app keeps its own records of its sessions, with the titles its sidebar shows. */
  desktopSessions: string;
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
    cursors: join(dir, "cursors.json"),
    log: join(dir, "helper.log"),
    socket: join(dir, "helper.sock"),
    bin: join(kit, "bin", "sk-discord"),
    updateLock: join(kit, "bin", ".sk-discord-update.lock"),
    updateState: join(dir, "update.json"),
    launchAgent: join(home, "Library", "LaunchAgents", "io.github.ducky8x.session-kit.discord.plist"),
    desktopSessions: join(home, "Library", "Application Support", "Claude", "claude-code-sessions"),
  };
}
