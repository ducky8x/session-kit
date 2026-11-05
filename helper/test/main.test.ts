import { describe, expect, test } from "bun:test";
import plugin from "../../.claude-plugin/plugin.json" with { type: "json" };
import { type CliDeps, runCli } from "../src/main.ts";
import { VERSION } from "../src/version.ts";
import { tmpDir } from "./helpers/tmp.ts";

function harness(overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    home: tmpDir(),
    env: {},
    cwd: "/work/demo",
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    readStdin: async () => "",
    ...overrides,
  };
  return { deps, out, err, stdout: () => out.join(""), stderr: () => err.join("") };
}

describe("version", () => {
  test("is the plugin's version", () => {
    expect(VERSION).toBe(plugin.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("--version prints it and nothing else", async () => {
    const h = harness();
    expect(await runCli(["--version"], h.deps)).toBe(0);
    expect(h.stdout()).toBe(`${VERSION}\n`);
    expect(h.stderr()).toBe("");
  });
});

describe("command dispatch", () => {
  test("no command prints the usage to stderr and fails", async () => {
    const h = harness();
    expect(await runCli([], h.deps)).toBe(1);
    expect(h.stderr()).toContain("sk-discord");
    expect(h.stdout()).toBe("");
  });

  test("help prints the usage to stdout", async () => {
    for (const word of ["help", "--help", "-h"]) {
      const h = harness();
      expect(await runCli([word], h.deps)).toBe(0);
      expect(h.stdout()).toContain("sk-discord --version");
    }
  });

  test("an unknown command fails with a pointer to help", async () => {
    const h = harness();
    expect(await runCli(["frobnicate"], h.deps)).toBe(1);
    expect(h.stderr()).toContain('Unknown command "frobnicate"');
  });
});
