import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { configExists, defaultConfig, loadConfig, saveConfig, updateConfig } from "../src/config.ts";
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
});
