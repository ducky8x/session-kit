import { afterEach } from "bun:test";
import { ChannelManager, DEFAULT_TIMING, type Timing } from "../../src/channels.ts";
import { defaultConfig, loadConfig, saveConfig } from "../../src/config.ts";
import { RestClient } from "../../src/discord/rest.ts";
import { memoryLogger } from "../../src/log.ts";
import { pathsFor } from "../../src/paths.ts";
import { SessionStore } from "../../src/state.ts";
import { FakeClock } from "../fakes/fake-clock.ts";
import { FakeDiscordRest, GUILD_ID, OWNER_ID } from "../fakes/fake-rest.ts";
import { tmpDir } from "./tmp.ts";

export const TOKEN = "FAKE00000000000000000000.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";
export const SID = "caa24365-1b2c-4d5e-8f90-123456789abc";

const started: FakeDiscordRest[] = [];
afterEach(() => {
  for (const fake of started.splice(0)) fake.stop();
});

/** A configured server (four categories and #session-kit) on a fake REST API, and a channel manager for it. */
export async function channelKit(o: { online?: boolean; timing?: Partial<Timing> } = {}) {
  const fake = await FakeDiscordRest.start();
  started.push(fake);
  const desktop = fake.addCategory("Desktop");
  const vs = fake.addCategory("VS Code");
  const cli = fake.addCategory("CLI");
  const archive = fake.addCategory("Archive");
  const control = fake.addChannel({ name: "session-kit" });
  const home = tmpDir();
  const paths = pathsFor(home);
  saveConfig(paths, {
    ...defaultConfig(),
    enabled: true,
    offered: true,
    guildId: GUILD_ID,
    ownerId: OWNER_ID,
    controlChannelId: control.id,
    categories: { desktop: desktop.id, vs: vs.id, cli: cli.id, archive: archive.id },
  });
  const clock = new FakeClock();
  const log = memoryLogger();
  const rest = new RestClient({ baseUrl: fake.baseUrl, token: () => TOKEN, clock, log });
  const sessions = new SessionStore(paths);
  const state = { online: o.online ?? true };
  const channels = new ChannelManager({
    rest,
    sessions,
    paths,
    clock,
    log,
    isOnline: () => state.online,
    timing: { ...DEFAULT_TIMING, ...o.timing },
  });
  return {
    fake,
    paths,
    clock,
    log,
    rest,
    sessions,
    channels,
    state,
    categories: { desktop, vs, cli, archive },
    control,
    config: () => loadConfig(paths),
    /** Requests that changed something (everything but GETs). */
    writes: () => fake.requests.filter((r) => r.method !== "GET"),
  };
}

export type ChannelKit = Awaited<ReturnType<typeof channelKit>>;
