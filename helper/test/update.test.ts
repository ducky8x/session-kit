import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../src/config.ts";
import { type CliDeps, runCli } from "../src/main.ts";
import { type Paths, pathsFor } from "../src/paths.ts";
import { readUpdateFailure } from "../src/update.ts";
import { VERSION } from "../src/version.ts";
import { FakeProcessRunner } from "./fakes/fake-process.ts";
import { tmpDir } from "./helpers/tmp.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function sha256(data: string): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** A loopback stand-in for the GitHub release downloads. */
function releaseServer(files: Record<string, string | number>) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const body = files[path];
      if (body === undefined) return new Response("Not Found", { status: 404 });
      if (typeof body === "number") return new Response("", { status: body });
      return new Response(body);
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}/ducky8x/session-kit/releases/download`, requests };
}

function setup(o: { files: Record<string, string | number> }) {
  const home = tmpDir();
  const paths = pathsFor(home);
  mkdirSync(dirname(paths.bin), { recursive: true });
  writeFileSync(paths.bin, "old binary", { mode: 0o755 });
  const release = releaseServer(o.files);
  const runner = new FakeProcessRunner();
  runner.on((cmd) => (cmd[0]?.endsWith("sk-discord.new") && cmd[1] === "--version" ? { code: 0, stdout: "0.3.0\n", stderr: "" } : undefined));
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    home,
    env: {},
    cwd: "/",
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    readStdin: async () => "",
    runner,
    releaseBaseUrl: release.base,
    arch: "arm64",
    uid: 501,
  };
  const run = async (argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await runCli(argv, deps);
    return { code, out: out.join(""), err: err.join("") };
  };
  return { home, paths, runner, release, run };
}

const GOOD = "new binary for 0.3.0";

function goodFiles(checksum = sha256(GOOD)): Record<string, string> {
  return {
    "/ducky8x/session-kit/releases/download/v0.3.0/sk-discord-darwin-arm64": GOOD,
    "/ducky8x/session-kit/releases/download/v0.3.0/checksums.txt": `${sha256("x64 build")}  sk-discord-darwin-x64\n${checksum}  sk-discord-darwin-arm64\n`,
  };
}

function binary(paths: Paths): string {
  return readFileSync(paths.bin, "utf8");
}

describe("sk-discord update", () => {
  test("a good download replaces the binary and restarts the helper", async () => {
    const h = setup({ files: goodFiles() });
    const r = await h.run(["update", "--version", "0.3.0"]);
    expect(r.code).toBe(0);
    expect(binary(h.paths)).toBe(GOOD);
    expect(statSync(h.paths.bin).mode & 0o777).toBe(0o755);
    expect(existsSync(`${h.paths.bin}.new`)).toBe(false);
    expect(h.runner.commands).toEqual([
      `${h.paths.bin}.new --version`,
      "/bin/launchctl kickstart -k gui/501/io.github.ducky8x.session-kit.discord",
    ]);
    expect(loadConfig(h.paths).helperVersion).toBe("0.3.0");
    expect(readUpdateFailure(h.paths)).toBeNull();
    expect(r.out).toContain("Updated the Discord helper to 0.3.0.");
  });

  test("a bad checksum keeps the old binary and records update-failed", async () => {
    const h = setup({ files: goodFiles(sha256("something else")) });
    const r = await h.run(["update", "--version", "0.3.0"]);
    expect(r.code).toBe(1);
    expect(binary(h.paths)).toBe("old binary");
    expect(existsSync(`${h.paths.bin}.new`)).toBe(false);
    expect(readUpdateFailure(h.paths)).toMatchObject({ version: "0.3.0", reason: expect.stringContaining("checksum") });
    expect(h.runner.commands).toEqual([]);
  });

  test("a failed download keeps the old binary and records update-failed", async () => {
    const h = setup({ files: {} });
    const r = await h.run(["update", "--version", "0.3.0"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("404");
    expect(binary(h.paths)).toBe("old binary");
    expect(readUpdateFailure(h.paths)?.version).toBe("0.3.0");
  });

  test("a new binary that does not run is not installed", async () => {
    const h = setup({ files: goodFiles() });
    h.runner.prepend((cmd) => (cmd[1] === "--version" ? { code: 1, stdout: "", stderr: "killed" } : undefined));
    const r = await h.run(["update", "--version", "0.3.0"]);
    expect(r.code).toBe(1);
    expect(binary(h.paths)).toBe("old binary");
  });

  test("a second update while one runs waits its turn by not starting at all", async () => {
    const h = setup({ files: goodFiles() });
    writeFileSync(h.paths.updateLock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const r = await h.run(["update", "--version", "0.3.0"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already running");
    expect(h.release.requests).toEqual([]);
    expect(binary(h.paths)).toBe("old binary");
  });

  test("a lock left by a process that is gone is taken over", async () => {
    const h = setup({ files: goodFiles() });
    writeFileSync(h.paths.updateLock, JSON.stringify({ pid: 999_999_999, at: Date.now() }));
    expect((await h.run(["update", "--version", "0.3.0"])).code).toBe(0);
    expect(binary(h.paths)).toBe(GOOD);
    expect(existsSync(h.paths.updateLock)).toBe(false);
  });

  test("the version it already is needs no download", async () => {
    const h = setup({ files: goodFiles() });
    const r = await h.run(["update", "--version", VERSION]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`already at ${VERSION}`);
    expect(h.release.requests).toEqual([]);
  });

  test("needs a version", async () => {
    const h = setup({ files: {} });
    expect((await h.run(["update"])).code).toBe(1);
    expect((await h.run(["update", "--version", "../../etc"])).code).toBe(1);
  });
});
