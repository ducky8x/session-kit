import type { Daemon } from "./daemon.ts";
import { Inbound } from "./inbound.ts";
import { ListenerHub, stopHookReason } from "./listeners.ts";
import { RequestError } from "./server.ts";
import { Waker } from "./wake.ts";

/** The parts that carry messages to sessions, built once per daemon. */
export interface SessionFeatures {
  hub: ListenerHub;
  waker: Waker;
  inbound: Inbound;
}

const built = new WeakMap<Daemon, SessionFeatures>();

/** The features installed on this daemon (for tests and other features). */
export function sessionFeatures(daemon: Daemon): SessionFeatures {
  const features = built.get(daemon);
  if (!features) throw new Error("the session features are not installed on this daemon");
  return features;
}

function sessionIdOf(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new RequestError("invalid", '"sessionId" must be text.');
  return value;
}

/**
 * Listening, routing messages to sessions, waking closed terminal sessions and the Stop hook's hand-over.
 * Adds the `listen` and `stop-hook` ops.
 */
export function installSessionFeatures(daemon: Daemon): SessionFeatures {
  const { deps } = daemon;
  const hub = new ListenerHub(deps.clock);
  const waker = new Waker({
    runner: deps.runner,
    clock: deps.clock,
    log: deps.log,
    claudePath: () => daemon.currentConfig().claudePath,
    env: deps.env,
    home: deps.paths.home,
    ...(deps.pidAlive ? { pidAlive: deps.pidAlive } : {}),
    ...(deps.which ? { which: deps.which } : {}),
  });
  const inbound = new Inbound(daemon, hub, waker);
  const features: SessionFeatures = { hub, waker, inbound };
  built.set(daemon, features);

  daemon.onInbound(inbound.handle);
  daemon.onConfigChange((config, before) => {
    if (before.enabled && !config.enabled) hub.disableAll();
  });
  daemon.onUnlinked((sessionId) => {
    hub.offer(sessionId, { type: "unlinked" });
  });

  daemon.handlers
    .add("listen", (req, ctx) => {
      const sessionId = sessionIdOf(req.sessionId);
      if (!daemon.currentConfig().enabled) return { event: { type: "disabled" } };
      const entry = daemon.sessions.get(sessionId);
      if (!entry || (entry.channelId === null && !entry.wantsChannel)) return { event: { type: "unlinked" } };
      const waiting = daemon.sessions.shiftInbox(sessionId);
      if (waiting) return { event: { ...waiting, queued: true } };
      return new Promise((resolve) => {
        const detach = hub.attach(sessionId, (event) => {
          if (ctx.closed) return false;
          resolve({ event });
          return true;
        });
        ctx.onClose(detach);
      });
    })
    .add("stop-hook", (req) => {
      const sessionId = sessionIdOf(req.sessionId);
      if (!daemon.currentConfig().enabled || hub.isListening(sessionId)) return {};
      const reason = stopHookReason(daemon.sessions.takeInbox(sessionId));
      return reason === null ? {} : { decision: "block", reason };
    });
  return features;
}
