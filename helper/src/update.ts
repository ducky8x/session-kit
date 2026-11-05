import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { updateConfig } from "./config.ts";
import { restartHelper } from "./launchagent.ts";
import type { Paths } from "./paths.ts";
import type { ProcessRunner } from "./process.ts";
import { readJsonFile, writeFileAtomic } from "./state.ts";
import { VERSION } from "./version.ts";
import { defaultPidAlive } from "./wake.ts";

export const RELEASES = "https://github.com/ducky8x/session-kit/releases/download";
/** A lock older than this is left over from an update that died. */
const LOCK_STALE_MS = 10 * 60_000;

export interface UpdateFailure {
  version: string;
  reason: string;
  at: number;
}

/** The last failed update, or null when the last one worked (or none failed). */
export function readUpdateFailure(paths: Paths): UpdateFailure | null {
  const raw = readJsonFile(paths.updateState) as Partial<UpdateFailure> | null;
  if (!raw || typeof raw.version !== "string" || typeof raw.reason !== "string") return null;
  return { version: raw.version, reason: raw.reason, at: typeof raw.at === "number" ? raw.at : 0 };
}

export function writeUpdateFailure(paths: Paths, failure: UpdateFailure): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(paths.updateState, `${JSON.stringify(failure)}\n`);
}

function clearUpdateFailure(paths: Paths): void {
  if (existsSync(paths.updateState)) unlinkSync(paths.updateState);
}

/** The release asset for this Mac. */
export function assetName(arch: string): string {
  return `sk-discord-darwin-${arch === "arm64" ? "arm64" : "x64"}`;
}

/** The SHA-256 for `file` in a `shasum -a 256` listing, or null. */
export function checksumFor(listing: string, file: string): string | null {
  for (const line of listing.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m && m[2] === file) return m[1]!.toLowerCase();
  }
  return null;
}

export interface UpdateDeps {
  paths: Paths;
  runner: ProcessRunner;
  fetch: typeof fetch;
  releaseBaseUrl?: string;
  arch: string;
  uid: number;
  now(): number;
  pidAlive?: (pid: number) => boolean;
  out(text: string): void;
  err(text: string): void;
}

/** Take the update lock. False when another update holds it. */
function takeLock(d: UpdateDeps): boolean {
  const lock = d.paths.updateLock;
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: d.now() }));
      closeSync(fd);
      return true;
    } catch {
      const held = readJsonFile(lock) as { pid?: unknown; at?: unknown } | null;
      const pid = typeof held?.pid === "number" ? held.pid : null;
      const at = typeof held?.at === "number" ? held.at : 0;
      const alive = pid !== null && (d.pidAlive ?? defaultPidAlive)(pid);
      if (alive && d.now() - at < LOCK_STALE_MS) return false;
      try {
        unlinkSync(lock); // left by an update that died
      } catch {
        // someone else just took it over
      }
    }
  }
  return false;
}

async function download(d: UpdateDeps, url: string): Promise<Uint8Array> {
  const res = await d.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url.split("/").pop()}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * `sk-discord update --version <v>`: download the release's binary for this Mac and `checksums.txt`, check the
 * SHA-256, make sure the new binary runs, swap it in (`sk-discord.new`, then a rename) and restart the helper.
 * A failure keeps the old binary and is reported by `status` as `update-failed`. One update at a time.
 */
export async function updateCommand(args: readonly string[], d: UpdateDeps): Promise<number> {
  const at = args.indexOf("--version");
  const version = at >= 0 ? args[at + 1] : args.find((a) => a.startsWith("--version="))?.slice("--version=".length);
  if (!version || !/^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(version)) {
    d.err("usage: sk-discord update --version <version>\n");
    return 1;
  }
  if (version === VERSION && existsSync(d.paths.bin)) {
    clearUpdateFailure(d.paths);
    d.out(`The Discord helper is already at ${version}.\n`);
    return 0;
  }
  if (!takeLock(d)) {
    d.out("An update of the Discord helper is already running.\n");
    return 0;
  }
  const next = `${d.paths.bin}.new`;
  try {
    const base = `${d.releaseBaseUrl ?? RELEASES}/v${version}`;
    const asset = assetName(d.arch);
    const [binary, listing] = await Promise.all([download(d, `${base}/${asset}`), download(d, `${base}/checksums.txt`)]);
    const wanted = checksumFor(new TextDecoder().decode(listing), asset);
    if (wanted === null) throw new Error(`checksums.txt has no entry for ${asset}`);
    const actual = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
    if (actual !== wanted) throw new Error(`checksum mismatch for ${asset}`);
    writeFileSync(next, binary, { mode: 0o755 });
    chmodSync(next, 0o755);
    const check = await d.runner.run([next, "--version"], { timeoutMs: 20_000 });
    if (check.code !== 0 || check.stdout.trim() !== version) {
      throw new Error(`the new binary did not run (exit ${check.code})`);
    }
    renameSync(next, d.paths.bin);
    clearUpdateFailure(d.paths);
    updateConfig(d.paths, (c) => {
      c.helperVersion = version;
    });
    d.out(`Updated the Discord helper to ${version}.\n`);
    const restart = await restartHelper(d.runner, d.uid);
    if (restart !== null) d.out(`The helper was not restarted (${restart}); it starts with the new version next time.\n`);
    return 0;
  } catch (error) {
    const reason = (error as Error).message;
    if (existsSync(next)) unlinkSync(next);
    writeUpdateFailure(d.paths, { version, reason, at: d.now() });
    d.err(`The update to ${version} failed: ${reason}. The old helper is still in place.\n`);
    return 1;
  } finally {
    try {
      unlinkSync(d.paths.updateLock);
    } catch {
      // already gone
    }
  }
}

/** Is the installed binary there? */
export function installed(paths: Paths): boolean {
  return existsSync(paths.bin) && statSync(paths.bin).size > 0;
}
