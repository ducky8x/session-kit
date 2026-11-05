import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import TEMPLATE from "../packaging/launchagent.plist.template" with { type: "text" };
import type { Paths } from "./paths.ts";
import type { ProcessRunner } from "./process.ts";

export const LAUNCH_AGENT_LABEL = "io.github.ducky8x.session-kit.discord";
export const LAUNCHCTL = "/bin/launchctl";

function xml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** launchd does not expand `~` or `$HOME`, so the plist names the home folder in full. */
export function launchAgentPlist(paths: Paths): string {
  const path = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", join(paths.home, ".local", "bin")].join(":");
  return TEMPLATE.replaceAll("{{LABEL}}", LAUNCH_AGENT_LABEL)
    .replaceAll("{{BINARY}}", xml(paths.bin))
    .replaceAll("{{LOG}}", xml(paths.log))
    .replaceAll("{{PATH}}", xml(path));
}

/** `gui/<uid>/<label>`: the helper's service, for `bootout` and `kickstart`. */
export function serviceTarget(uid: number): string {
  return `gui/${uid}/${LAUNCH_AGENT_LABEL}`;
}

/**
 * Write the LaunchAgent and load it: `launchctl bootout` (in case an older one is loaded), then
 * `launchctl bootstrap gui/<uid> <plist>`, which starts the helper now (RunAtLoad). Returns an error message,
 * or null when it worked.
 */
export async function installLaunchAgent(paths: Paths, runner: ProcessRunner, uid: number): Promise<string | null> {
  mkdirSync(dirname(paths.launchAgent), { recursive: true });
  writeFileSync(paths.launchAgent, launchAgentPlist(paths), { mode: 0o644 });
  await runner.run([LAUNCHCTL, "bootout", serviceTarget(uid)], { timeoutMs: 20_000 });
  const loaded = await runner.run([LAUNCHCTL, "bootstrap", `gui/${uid}`, paths.launchAgent], { timeoutMs: 20_000 });
  if (loaded.code !== 0) return (loaded.stderr || loaded.stdout).trim() || `launchctl bootstrap failed (exit ${loaded.code})`;
  return null;
}

/** `launchctl kickstart -k`: restart the helper (after an update). Returns an error message, or null. */
export async function restartHelper(runner: ProcessRunner, uid: number): Promise<string | null> {
  const r = await runner.run([LAUNCHCTL, "kickstart", "-k", serviceTarget(uid)], { timeoutMs: 20_000 });
  return r.code === 0 ? null : (r.stderr || r.stdout).trim() || `launchctl kickstart failed (exit ${r.code})`;
}
