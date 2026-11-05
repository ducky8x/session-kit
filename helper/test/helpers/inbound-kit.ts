import { type ListenerEvent } from "../../src/events.ts";
import { sessionFeatures } from "../../src/features.ts";
import { FakeCli } from "../fakes/fake-cli.ts";
import { GUILD_ID, OWNER_ID } from "../fakes/fake-rest.ts";
import { SID, type DaemonKitOptions, daemonKit } from "./daemon-kit.ts";
import { waitFor } from "./wait.ts";

let nextMessage = 1;

/**
 * A connected daemon with one registered session and a fake `claude` CLI, plus helpers to type in the
 * session's channel as the owner and to listen.
 */
export async function inboundKit(o: { entrypoint?: string; sessionId?: string } & DaemonKitOptions = {}) {
  const claude = new FakeCli();
  const k = await daemonKit({ ...o, runner: claude, pidAlive: claude.pidAlive });
  const features = sessionFeatures(k.daemon);
  let handled = 0;
  k.daemon.onInbound(() => {
    handled++;
  });
  await k.connected();
  const sessionId = o.sessionId ?? SID;
  await k.register(sessionId, o.entrypoint ?? "cli");
  const channelId = () => k.daemon.sessions.get(sessionId)!.channelId!;

  /** Everything the daemon started is done. */
  const settle = async () => {
    await k.daemon.settle();
    await features.inbound.settle();
    await k.daemon.settle();
  };

  /** A message in a channel (the session's by default), as the owner unless `author` says otherwise. */
  const say = async (
    content: string,
    m: { channelId?: string; author?: { id: string; bot?: boolean }; guildId?: string; attachments?: unknown[]; type?: number } = {},
  ) => {
    const before = handled;
    const id = String(800000000000000000n + BigInt(nextMessage++));
    k.gateway.dispatch("MESSAGE_CREATE", {
      id,
      channel_id: m.channelId ?? channelId(),
      guild_id: m.guildId ?? GUILD_ID,
      author: m.author ?? { id: OWNER_ID, bot: false },
      content,
      type: m.type ?? 0,
      attachments: m.attachments ?? [],
    });
    if ((m.guildId ?? GUILD_ID) === GUILD_ID) await waitFor(() => handled > before);
    await settle();
    return id;
  };

  /** Start a listener; resolves with its one event. */
  const listen = (id = sessionId) =>
    k.call({ op: "listen", sessionId: id }).then((reply) => reply.event as ListenerEvent);

  /** Wait until a listener for the session is attached. */
  const attached = (id = sessionId) => waitFor(() => features.hub.isListening(id));

  /** What the bot posted in the session's channel. */
  const replies = () => k.rest.posted(channelId()).map((m) => m.content);

  /** `sk-discord send` from the session. */
  const cli_send = (text: string) => k.cli(["send", "--session", sessionId, text], { entrypoint: o.entrypoint ?? "cli" });

  return { ...k, claude, features, sessionId, channelId, say, listen, attached, replies, settle, cli_send };
}

export type InboundKit = Awaited<ReturnType<typeof inboundKit>>;
