import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import {
  DEFAULT_BATTERY_POLL_MINUTES,
  batteryPollMinutes,
  configExists,
  defaultConfig,
  loadConfig,
  saveConfig,
  updateConfig,
} from "../src/config.ts";
import { pathsFor } from "../src/paths.ts";
import { tmpDir } from "./helpers/tmp.ts";

describe("config.json", () => {
  test("no file means never offered and off", () => {
    const paths = pathsFor(tmpDir());
    expect(configExists(paths)).toBe(false);
    expect(loadConfig(paths)).toEqual(defaultConfig());
    expect(defaultConfig()).toMatchObject({ enabled: false, offered: false, guildId: null, categories: {} });
  });

  test("saves to a user-only folder and file, and reads back", () => {
    const paths = pathsFor(tmpDir());
    saveConfig(paths, { ...defaultConfig(), enabled: true, offered: true, guildId: "1", ownerId: "2" });
    expect(configExists(paths)).toBe(true);
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(loadConfig(paths)).toMatchObject({ enabled: true, offered: true, guildId: "1", ownerId: "2" });
  });

  test("fields the file leaves out take their defaults, and unknown fields are kept", () => {
    const paths = pathsFor(tmpDir());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ offered: true, enabled: false, futureField: 7 }));
    const config = loadConfig(paths);
    expect(config).toMatchObject({ offered: true, enabled: false, categories: {}, claudePath: null });
    updateConfig(paths, (c) => {
      c.enabled = true;
    });
    const raw = JSON.parse(readFileSync(paths.config, "utf8"));
    expect(raw).toMatchObject({ offered: true, enabled: true, futureField: 7 });
  });

  test("a file that is not JSON is set aside, not trusted", () => {
    const paths = pathsFor(tmpDir());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.config, "{ not json");
    expect(loadConfig(paths)).toEqual(defaultConfig());
    expect(existsSync(`${paths.config}.bad`)).toBe(true);
  });

  test("wrongly typed fields fall back to their defaults", () => {
    const paths = pathsFor(tmpDir());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ enabled: "yes", guildId: 5, categories: { desktop: "9", cli: 3 } }));
    expect(loadConfig(paths)).toMatchObject({ enabled: false, guildId: null, categories: { desktop: "9" } });
  });

  test("batteryPollMinutes: 5 by default, at least 1, and anything that isn't a positive number is ignored", () => {
    expect(DEFAULT_BATTERY_POLL_MINUTES).toBe(5);
    const minutes = (value: unknown) => batteryPollMinutes({ ...defaultConfig(), batteryPollMinutes: value });
    expect(batteryPollMinutes(defaultConfig())).toBe(5);
    expect(minutes(10)).toBe(10);
    expect(minutes(1)).toBe(1);
    expect(minutes(2.5)).toBe(2.5);
    expect(minutes(0.25)).toBe(1);
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, "10", null, true, [5], { minutes: 5 }]) {
      expect(minutes(bad)).toBe(5);
    }
  });

  test("batteryPollMinutes is read from config.json and kept as written", () => {
    const paths = pathsFor(tmpDir());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ enabled: true, batteryPollMinutes: 15 }));
    expect(batteryPollMinutes(loadConfig(paths))).toBe(15);
    writeFileSync(paths.config, JSON.stringify({ enabled: true, batteryPollMinutes: "often" }));
    expect(batteryPollMinutes(loadConfig(paths))).toBe(5);
    updateConfig(paths, (c) => {
      c.enabled = false;
    });
    expect(JSON.parse(readFileSync(paths.config, "utf8")).batteryPollMinutes).toBe("often");
  });
});
