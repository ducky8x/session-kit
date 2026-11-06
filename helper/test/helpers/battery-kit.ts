import { MINUTE_MS } from "../../src/channels.ts";
import { sessionFeatures } from "../../src/features.ts";
import { FakeCli } from "../fakes/fake-cli.ts";
import { OWNER_ID } from "../fakes/fake-rest.ts";
import { type DaemonKitOptions, SID, daemonKit } from "./daemon-kit.ts";
import { waitFor } from "./wait.ts";

export const AC_OUTPUT = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n";
export const BATTERY_OUTPUT =
  "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t80%; discharging; 4:10 remaining present: true\n";
/** Someone in the server who isn't the owner. */
export const STRANGER = "555555555555555555";

/**
 * A daemon on fakes whose `pmset -g ps` says what `power.output` holds: battery power unless `power` says AC.
 * The fake `claude` CLI lists the session `SID` as open in a terminal, so messages for it wait in its inbox
 * rather than wake it. `seen` collects the owner's messages as the inbound handlers get them, with their session.
 */
export async function batteryKit(o: DaemonKitOptions & { power?: "ac" | "battery"; start?: boolean } = {}) {
  const claude = new FakeCli();
  claude.addInteractive(SID);
  const k = await daemonKit({ runner: claude, pidAlive: claude.pidAlive, ...o, noStart: true });
  const power = { output: o.power === "ac" ? AC_OUTPUT : BATTERY_OUTPUT };
  k.runner.prepend((cmd) => (cmd[0] === "/usr/bin/pmset" ? { code: 0, stdout: power.output, stderr: "" } : undefined));
  const seen: [string | undefined, string | null][] = [];
  k.daemon.onInbound((message, session) => {
    if (message.author?.id === OWNER_ID) seen.push([message.content, session?.sessionId ?? null]);
  });
  const settleAll = async () => {
    await k.daemon.settle();
    await sessionFeatures(k.daemon).inbound.settle();
    await k.daemon.settle();
  };
  if (o.start !== false) {
    await k.daemon.start();
    await settleAll();
  }
  return {
    ...k,
    claude,
    power,
    seen,
    settleAll,
    /** Every read of a channel's messages (one channel's, when given). */
    reads: (channelId?: string) =>
      k.rest.requestsMatching("GET", channelId === undefined ? /^\/channels\/\d+\/messages$/ : `/channels/${channelId}/messages`),
    /** Let time pass (a check's worth by default) and wait for what it started. */
    tick: async (ms = 5 * MINUTE_MS) => {
      await k.clock.advance(ms);
      await settleAll();
    },
    /** The next power reading says AC; wait for the gateway. */
    toAc: async () => {
      power.output = AC_OUTPUT;
      await k.clock.advance(MINUTE_MS);
      await waitFor(() => k.daemon.gateway.state === "connected");
      await settleAll();
    },
    /** The next power reading says battery. */
    toBattery: async () => {
      power.output = BATTERY_OUTPUT;
      await k.clock.advance(MINUTE_MS);
      await settleAll();
    },
  };
}

export type BatteryKit = Awaited<ReturnType<typeof batteryKit>>;
