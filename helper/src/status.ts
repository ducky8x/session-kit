/**
 * The helper's state as `status` reports it. Every code but `connected` and `connecting` comes with a fix.
 */
export type StatusCode =
  | "connected"
  | "connecting"
  | "off"
  | "no-token"
  | "token-rejected"
  | "intent-missing"
  | "no-server"
  | "not-in-server";

export interface StatusProblem {
  /** What is wrong, in a few words. */
  problem: string;
  /** What fixes it. */
  fix: string;
}

export const STATUS_PROBLEMS: Partial<Record<StatusCode, StatusProblem>> = {
  off: { problem: "Discord is off", fix: "/discord on" },
  "no-token": { problem: "there is no bot token in the Keychain", fix: "sk-discord setup token" },
  "token-rejected": { problem: "Discord rejected the bot token", fix: "sk-discord setup token" },
  "intent-missing": {
    problem: "the bot isn't allowed to read messages",
    fix: "turn on Message Content Intent for the bot in the developer portal",
  },
  "no-server": { problem: "no Discord server is set up", fix: "sk-discord setup server" },
  "not-in-server": { problem: "the bot isn't in the server", fix: "sk-discord setup invite" },
};

/** Codes that mean setup has to run (or be finished) before Discord can work. */
export const SETUP_NEEDED: ReadonlySet<StatusCode> = new Set([
  "no-token",
  "token-rejected",
  "intent-missing",
  "no-server",
  "not-in-server",
]);

/** What `send` and the hooks print when nothing answers on the socket. */
export const HELPER_DOWN =
  "The Discord helper isn't running (launchctl kickstart -k gui/$UID/io.github.ducky8x.session-kit.discord)";
