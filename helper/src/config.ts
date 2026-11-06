import { existsSync } from "node:fs";
import type { Paths } from "./paths.ts";
import { ensurePrivateDir, readJsonFile, writeFileAtomic } from "./state.ts";

/** `config.json`: what setup found and what the user turned on. Never the bot token (that is in the Keychain). */
export interface Config {
  /** The Discord feature is on. */
  enabled: boolean;
  /** The first-run offer was made, whatever the answer. */
  offered: boolean;
  guildId: string | null;
  /** The one Discord user whose messages count: the server's owner. */
  ownerId: string | null;
  applicationId: string | null;
  /** `#session-kit`, for notices and the all-sessions `status`. */
  controlChannelId: string | null;
  /** Category ids by key: `desktop`, `vs`, `cli`, `archive`, and overflow keys such as `desktop-2`. */
  categories: Record<string, string>;
  /** The `claude` CLI, for `claude agents --json` and waking sessions. */
  claudePath: string | null;
  helperVersion: string | null;
  /** Fields this version does not know are kept as they are. */
  [other: string]: unknown;
}

export function defaultConfig(): Config {
  return {
    enabled: false,
    offered: false,
    guildId: null,
    ownerId: null,
    applicationId: null,
    controlChannelId: null,
    categories: {},
    claudePath: null,
    helperVersion: null,
  };
}

/** No file means the feature was never offered. */
export function configExists(paths: Paths): boolean {
  return existsSync(paths.config);
}

function idOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Read `config.json`. Missing or unreadable, it is the defaults; a wrongly typed field takes its default. */
export function loadConfig(paths: Paths): Config {
  const raw = readJsonFile(paths.config);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultConfig();
  const r = raw as Record<string, unknown>;
  const categories: Record<string, string> = {};
  if (r.categories && typeof r.categories === "object" && !Array.isArray(r.categories)) {
    for (const [key, value] of Object.entries(r.categories as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") categories[key] = value;
    }
  }
  return {
    ...r,
    enabled: r.enabled === true,
    offered: r.offered === true,
    guildId: idOrNull(r.guildId),
    ownerId: idOrNull(r.ownerId),
    applicationId: idOrNull(r.applicationId),
    controlChannelId: idOrNull(r.controlChannelId),
    categories,
    claudePath: idOrNull(r.claudePath),
    helperVersion: idOrNull(r.helperVersion),
  };
}

/** How often the helper checks Discord for messages on battery power, unless `config.json` says otherwise. */
export const DEFAULT_BATTERY_POLL_MINUTES = 5;

/**
 * `batteryPollMinutes` from `config.json`: minutes between checks on battery power, at least 1. A value that
 * isn't a positive number is ignored and the default, 5, is used.
 */
export function batteryPollMinutes(config: Config): number {
  const value = config.batteryPollMinutes;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_BATTERY_POLL_MINUTES;
  return Math.max(1, value);
}

export function saveConfig(paths: Paths, config: Config): void {
  ensurePrivateDir(paths.dir);
  writeFileAtomic(paths.config, `${JSON.stringify(config, null, 2)}\n`);
}

/** Read, change and save `config.json`. Returns the saved config. */
export function updateConfig(paths: Paths, mutate: (config: Config) => void): Config {
  const config = loadConfig(paths);
  mutate(config);
  saveConfig(paths, config);
  return config;
}
