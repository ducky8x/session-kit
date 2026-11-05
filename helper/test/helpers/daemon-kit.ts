import { afterEach } from "bun:test";
import { type HelperRequest, callHelper } from "../../src/client.ts";
import { type Config, defaultConfig, saveConfig, updateConfig } from "../../src/config.ts";
import { Daemon } from "../../src/daemon.ts";
import { EXTENSIONS } from "../../src/extensions.ts";
import { memoryLogger } from "../../src/log.ts";
import { type CliDeps, runCli } from "../../src/main.ts";
import { pathsFor } from "../../src/paths.ts";
import { FakeClock } from "../fakes/fake-clock.ts";
import { FakeGateway } from "../fakes/fake-gateway.ts";
import { MemoryKeychain } from "../fakes/fake-keychain.ts";
import { FakeProcessRunner } from "../fakes/fake-process.ts";
import { FakeDiscordRest, GUILD_ID, OWNER_ID } from "../fakes/fake-rest.ts";
import { TOKEN } from "./channel-kit.ts";
import { tmpDir } from "./tmp.ts";
import { waitFor } from "./wait.ts";

export { SID, TOKEN } from "./channel-kit.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export interface DaemonKitOptions {
  enabled?: boolean;
  /** null: no token in the keychain. */
  token?: string | null;
  /** The process runner (a FakeCli for wake tests). Defaults to one that answers `claude agents --json` with []. */
  runner?: FakeProcessRunner;
  /** Is this process id alive? (The fake CLI's `pidAlive`.) */
  pidAlive?: (pid: number) => boolean;
  /** Leave the server out of config.json (setup not finished). */
  noGuild?: boolean;
  /** Don't start the daemon yet. */
  noStart?: boolean;
  home?: string;
}

/**
 * A daemon on fakes: a loopback REST API and gateway, a fake clock, a keychain in memory, a process runner
 * that answers `claude agents --json`, and a temp HOME. Commands run through the real control socket.
 */
export async function daemonKit(o: DaemonKitOptions = {}) {
  const rest = await FakeDiscordRest.start();
  const gateway = await FakeGateway.start();
  // Tests move the clock by hours; a heartbeat every 41 seconds would race the real socket's ACKs.
  gateway.heartbeatInterval = 7 * 24 * 3_600_000;
  cleanups.push(() => rest.stop(), () => gateway.stop());
  const categories = {
    desktop: rest.addCategory("Desktop"),
    vs: rest.addCategory("VS Code"),
    cli: rest.addCategory("CLI"),
    archive: rest.addCategory("Archive"),
  };
  const control = rest.addChannel({ name: "session-kit" });
  const home = o.home ?? tmpDir();
  const paths = pathsFor(home);
  const config: Config = {
    ...defaultConfig(),
    enabled: o.enabled ?? true,
    offered: true,
    guildId: o.noGuild ? null : GUILD_ID,
    ownerId: OWNER_ID,
    controlChannelId: control.id,
    categories: {
      desktop: categories.desktop.id,
      vs: categories.vs.id,
      cli: categories.cli.id,
      archive: categories.archive.id,
    },
    claudePath: "/opt/tools/claude",
  };
  saveConfig(paths, config);
  const keychain = new MemoryKeychain(o.token === undefined ? TOKEN : o.token);
  const runner = o.runner ?? new FakeProcessRunner().answer(["/opt/tools/claude", "agents", "--json"], { stdout: "[]" });
  const clock = new FakeClock();
  const log = memoryLogger();
  const daemon = new Daemon({
    paths,
    env: {},
    clock,
    log,
    runner,
    keychain,
    restBaseUrl: rest.baseUrl,
    gatewayUrl: gateway.url,
    random: () => 0.5,
    pidAlive: o.pidAlive ?? (() => false),
    which: () => null,
    extensions: EXTENSIONS,
  });
  cleanups.push(() => daemon.stop());
  if (!o.noStart) await daemon.start();

  const cli = async (argv: string[], c: { stdin?: string; entrypoint?: string; cwd?: string } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      home,
      env: { CLAUDE_CODE_ENTRYPOINT: c.entrypoint ?? "cli" },
      cwd: c.cwd ?? "/work/session-kit",
      out: (t) => void out.push(t),
      err: (t) => void err.push(t),
      readStdin: async () => c.stdin ?? "",
      keychain,
      runner,
      clock,
      which: () => null,
      uid: 501,
      restBaseUrl: rest.baseUrl,
    };
    const code = await runCli(argv, deps);
    return { code, out: out.join(""), err: err.join("") };
  };

  return {
    rest,
    gateway,
    categories,
    control,
    home,
    paths,
    keychain,
    runner,
    clock,
    log,
    daemon,
    cli,
    call: (request: HelperRequest) => callHelper(paths.socket, request, { timeoutMs: 3000 }),
    connected: () => waitFor(() => daemon.statusCode() === "connected"),
    setConfig: (mutate: (c: Config) => void) => updateConfig(paths, mutate),
    register: (sessionId: string, entrypoint = "cli", source = "startup") =>
      callHelper(
        paths.socket,
        { op: "register", sessionId, source, cwd: "/work/session-kit", transcriptPath: null, entrypoint },
        { timeoutMs: 3000 },
      ),
  };
}

export type DaemonKit = Awaited<ReturnType<typeof daemonKit>>;
