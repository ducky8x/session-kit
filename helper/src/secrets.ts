import type { ProcessRunner } from "./process.ts";

/** Where the bot token lives. It is never written to a file or a log. */
export interface Keychain {
  /** The stored token, or null when there is none. Throws when the keychain cannot be read. */
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
}

export const SECURITY_TOOL = "/usr/bin/security";
export const KEYCHAIN_SERVICE = "session-kit-discord";
export const KEYCHAIN_ACCOUNT = "bot-token";
/** How long one call to the `security` tool may take before it counts as failed. */
export const KEYCHAIN_TIMEOUT_MS = 20_000;
/** `security find-generic-password` exits with this when the item does not exist. */
const NOT_FOUND = 44;

/** A Discord bot token: three base64url parts joined by dots. Anything else is refused before it is stored. */
export function isPlausibleToken(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/** The macOS login keychain, through `/usr/bin/security`. */
export class SecurityKeychain implements Keychain {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly timeoutMs = KEYCHAIN_TIMEOUT_MS,
  ) {}

  async getToken(): Promise<string | null> {
    const r = await this.runner.run(
      [SECURITY_TOOL, "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { timeoutMs: this.timeoutMs },
    );
    if (r.timedOut) throw new Error("Keychain read timed out");
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`Keychain read failed (exit ${r.code}): ${firstLine(r.stderr)}`);
    const token = r.stdout.trim();
    return token === "" ? null : token;
  }

  /**
   * Store (or replace) the token. It goes to `security -i` on stdin, so it never shows up in the process list.
   * Only plausible tokens are accepted, which also keeps the quoted command safe.
   */
  async setToken(token: string): Promise<void> {
    if (!isPlausibleToken(token)) throw new Error("That does not look like a Discord bot token.");
    const r = await this.runner.run([SECURITY_TOOL, "-i"], {
      stdin: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w "${token}"\n`,
      timeoutMs: this.timeoutMs,
    });
    if (r.timedOut) throw new Error("Keychain write timed out");
    if (r.code !== 0) throw new Error(`Keychain write failed (exit ${r.code}): ${firstLine(r.stderr)}`);
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.slice(0, 200) ?? "";
}
