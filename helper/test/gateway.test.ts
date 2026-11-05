import { afterEach, describe, expect, test } from "bun:test";
import { GATEWAY_URL, GatewayClient, type GatewayState, INTENTS } from "../src/discord/gateway.ts";
import { memoryLogger } from "../src/log.ts";
import { FakeClock } from "./fakes/fake-clock.ts";
import { FakeGateway, type Frame } from "./fakes/fake-gateway.ts";
import { waitFor } from "./helpers/wait.ts";

const TOKEN = "FAKE00000000000000000000.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";

let fake: FakeGateway | undefined;
let client: GatewayClient | undefined;
afterEach(() => {
  client?.stop();
  client = undefined;
  fake?.stop();
  fake = undefined;
});

async function setup(o: { random?: () => number } = {}) {
  const gateway = await FakeGateway.start();
  fake = gateway;
  const clock = new FakeClock();
  const log = memoryLogger();
  // Frames as the client sends them, recorded the moment `send` is called.
  const sent: Frame[] = [];
  class RecordingWebSocket extends WebSocket {
    override send(data: any): void {
      sent.push(JSON.parse(String(data)) as Frame);
      super.send(data);
    }
  }
  const events: { t: string; d: any }[] = [];
  const states: GatewayState[] = [];
  const c = new GatewayClient({
    url: gateway.url,
    token: () => TOKEN,
    clock,
    log,
    random: o.random ?? (() => 0.5),
    WebSocket: RecordingWebSocket as unknown as typeof WebSocket,
    onDispatch: (t, d) => events.push({ t, d }),
    onStateChange: (state) => states.push(state),
  });
  client = c;
  const heartbeats = () => sent.filter((f) => f.op === 1);
  return { fake: gateway, clock, log, sent, events, states, client: c, heartbeats };
}

describe("GatewayClient", () => {
  test("the default URL is gateway v10 with JSON, and the intents are 33281", () => {
    expect(GATEWAY_URL).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    expect(INTENTS).toBe(1 + 512 + 32768);
  });

  test("identifies with the token and the intents, then reports connected", async () => {
    const kit = await setup();
    kit.client.start();
    await waitFor(() => kit.client.state === "connected");
    const identify = kit.fake.latest!.ops(2)[0]!;
    expect(identify.d).toMatchObject({ token: TOKEN, intents: 33281 });
    expect(identify.d.properties).toMatchObject({ os: expect.any(String), browser: "sk-discord", device: "sk-discord" });
    expect(kit.states).toEqual(["connecting", "connected"]);
    expect(kit.events.map((e) => e.t)).toEqual(["READY"]);
    expect(kit.client.sessionId).toBe("fake-session-1");
  });

  test("the first heartbeat goes out at interval × random(), then one every interval, carrying the last seq", async () => {
    const kit = await setup({ random: () => 0.25 });
    kit.client.start();
    await waitFor(() => kit.client.state === "connected");
    // 41250 × 0.25 = 10312.5 ms
    await kit.clock.advance(10_312);
    expect(kit.heartbeats()).toHaveLength(0);
    await kit.clock.advance(1);
    expect(kit.heartbeats()).toEqual([{ op: 1, d: 1 }]);
    await waitFor(() => kit.fake.latest!.ops(1).length === 1);
    kit.fake.dispatch("GUILD_CREATE", { id: "1" });
    await waitFor(() => kit.events.length === 2);
    await kit.clock.advance(41_249);
    expect(kit.heartbeats()).toHaveLength(1);
    await kit.clock.advance(1);
    expect(kit.heartbeats()).toEqual([
      { op: 1, d: 1 },
      { op: 1, d: 2 },
    ]);
  });

  test("answers a heartbeat request at once", async () => {
    const kit = await setup();
    kit.client.start();
    await waitFor(() => kit.client.state === "connected");
    kit.fake.sendOp(1);
    await waitFor(() => kit.heartbeats().length === 1);
  });

  test("a dropped socket reconnects to resume_gateway_url and resumes with the last seq", async () => {
    const kit = await setup();
    kit.client.start();
    await waitFor(() => kit.client.state === "connected");
    kit.fake.dispatch("GUILD_CREATE", { id: "1" });
    kit.fake.dispatch("MESSAGE_CREATE", { id: "2" });
    await waitFor(() => kit.events.length === 3);
    kit.fake.dropLatest();
    await waitFor(() => kit.client.state === "connecting");
    expect(kit.fake.connections).toHaveLength(1);
    await kit.clock.advance(1000);
    await waitFor(() => kit.client.state === "connected");
    const second = kit.fake.connections[1]!;
    expect(second.path).toBe("/resume");
    expect(second.ops(2)).toHaveLength(0);
    expect(second.ops(6)[0]!.d).toEqual({ token: TOKEN, session_id: "fake-session-1", seq: 3 });
    expect(kit.events.map((e) => e.t)).toEqual(["READY", "GUILD_CREATE", "MESSAGE_CREATE", "RESUMED"]);
  });

  test("no heartbeat ACK before the next beat closes the socket and resumes", async () => {
    const kit = await setup({ random: () => 0 });
    kit.fake.ackHeartbeats = false;
    kit.client.start();
    await waitFor(() => kit.client.state === "connected");
    await kit.clock.advance(0);
    expect(kit.heartbeats()).toHaveLength(1);
    await kit.clock.advance(41_250);
    await waitFor(() => kit.fake.connections.length === 2 && kit.client.state === "connected");
    // Count heartbeats per connection. With jitter 0 the resumed connection's first heartbeat falls due at
    // once, so the advance above also sends it when that connection's HELLO arrives while the advance is
    // still running timers. Once the server has seen the old connection close, it has every frame sent on it.
    const [first, second] = kit.fake.connections;
    await waitFor(() => first!.closed);
    expect(first!.closeCode).toBe(4000);
    expect(first!.ops(1)).toHaveLength(1);
    expect(second!.ops(6)).toHaveLength(1);
  });

  test("op 7 RECONNECT reconnects at once and resumes", async () => {
    const kit = await setup();
    kit.client.start();
    await waitFor(() => kit.client.state === "connected");
    kit.fake.sendOp(7);
    await waitFor(() => kit.fake.connections.length === 2 && kit.client.state === "connected");
    expect(kit.fake.connections[1]!.path).toBe("/resume");
    expect(kit.fake.connections[1]!.ops(6)[0]!.d.seq).toBe(1);
  });

  test("op 9 INVALID_SESSION with d = false waits 1 to 5 seconds, then identifies again", async () => {
    const kit = await setup({ random: () => 0.5 });
    kit.client.start();
    await waitFor(() => kit.client.state === "connected");
    kit.fake.sendOp(9, false);
    await waitFor(() => kit.client.sessionId === null);
    // 1000 + 0.5 × 4000 = 3000 ms
    await kit.clock.advance(2999);
    expect(kit.fake.latest!.ops(2)).toHaveLength(1);
    await kit.clock.advance(1);
    await waitFor(() => kit.fake.latest!.ops(2).length === 2);
    await waitFor(() => kit.client.sessionId === "fake-session-2");
  });

  test("a refused resume falls back to a fresh identify", async () => {
    const kit = await setup({ random: () => 0 });
    kit.client.start();
    await waitFor(() => kit.client.state === "connected");
    kit.fake.refuseResume = true;
    kit.fake.sendOp(7);
    await waitFor(() => kit.fake.connections.length === 2 && kit.client.sessionId === null);
    await kit.clock.advance(1000);
    await waitFor(() => kit.client.sessionId === "fake-session-2" && kit.client.state === "connected");
  });

  test("close code 4004 stops reconnecting and reports a rejected token", async () => {
    const kit = await setup();
    kit.fake.closeOnIdentify = 4004;
    kit.client.start();
    await waitFor(() => kit.client.state === "token-rejected");
    await kit.clock.advance(10 * 60_000);
    expect(kit.fake.connections).toHaveLength(1);
    expect(kit.states.at(-1)).toBe("token-rejected");
  });

  test("close code 4014 stops reconnecting and reports the missing intent", async () => {
    const kit = await setup();
    kit.fake.closeOnIdentify = 4014;
    kit.client.start();
    await waitFor(() => kit.client.state === "intent-missing");
    await kit.clock.advance(10 * 60_000);
    expect(kit.fake.connections).toHaveLength(1);
  });

  test("failed attempts back off 1, 2, 4 seconds, and a good connection resets it", async () => {
    const kit = await setup();
    kit.fake.closeOnOpen = 1011;
    kit.client.start();
    await waitFor(() => kit.fake.connections.length === 1 && kit.clock.pending === 1);
    await kit.clock.advance(1000);
    await waitFor(() => kit.fake.connections.length === 2 && kit.clock.pending === 1);
    await kit.clock.advance(1999);
    expect(kit.fake.connections).toHaveLength(2);
    await kit.clock.advance(1);
    await waitFor(() => kit.fake.connections.length === 3 && kit.clock.pending === 1);
    await kit.clock.advance(3999);
    expect(kit.fake.connections).toHaveLength(3);
    kit.fake.closeOnOpen = null;
    await kit.clock.advance(1);
    await waitFor(() => kit.client.state === "connected");
    // Healthy again: the next drop waits 1 second, not 8.
    kit.fake.dropLatest();
    await waitFor(() => kit.client.state === "connecting" && kit.clock.nextDue !== null);
    const waitMs = kit.clock.nextDue! - kit.clock.now();
    expect(waitMs).toBeLessThanOrEqual(1000);
  });

  test("stop closes the connection and nothing reconnects", async () => {
    const kit = await setup();
    kit.client.start();
    await waitFor(() => kit.client.state === "connected");
    kit.client.stop();
    await waitFor(() => kit.fake.latest!.closed);
    await kit.clock.advance(5 * 60_000);
    expect(kit.fake.connections).toHaveLength(1);
    expect(kit.client.state).toBe("stopped");
  });

  test("start again after a rejected token connects afresh", async () => {
    const kit = await setup();
    kit.fake.closeOnIdentify = 4004;
    kit.client.start();
    await waitFor(() => kit.client.state === "token-rejected");
    kit.fake.closeOnIdentify = null;
    kit.client.start();
    await waitFor(() => kit.client.state === "connected");
  });
});
