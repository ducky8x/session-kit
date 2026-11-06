import { afterEach, describe, expect, test } from "bun:test";
import { backoffMs } from "../src/backoff.ts";
import { RestClient, RestError, USER_AGENT, routeKey } from "../src/discord/rest.ts";
import { memoryLogger } from "../src/log.ts";
import { FakeClock } from "./fakes/fake-clock.ts";
import { FakeDiscordRest } from "./fakes/fake-rest.ts";
import { waitFor } from "./helpers/wait.ts";

const TOKEN = "FAKE00000000000000000000.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";

let fake: FakeDiscordRest;
afterEach(() => fake?.stop());

async function setup(opts: { maxRetries?: number; fetch?: typeof fetch } = {}) {
  fake = await FakeDiscordRest.start();
  const clock = new FakeClock();
  const log = memoryLogger();
  const rest = new RestClient({
    baseUrl: fake.baseUrl,
    token: () => TOKEN,
    clock,
    log,
    ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const channel = fake.addChannel({ name: "general" });
  return { clock, log, rest, channel };
}

describe("routeKey", () => {
  test("keeps the channel or guild id and replaces other ids", () => {
    expect(routeKey("POST", "/channels/123456789/messages")).toBe("POST /channels/123456789/messages");
    expect(routeKey("PATCH", "/channels/123456789/messages/987654321")).toBe("PATCH /channels/123456789/messages/:id");
    expect(routeKey("GET", "/guilds/555555/channels")).toBe("GET /guilds/555555/channels");
    expect(routeKey("GET", "/applications/123456789")).toBe("GET /applications/:id");
  });
});

describe("backoffMs", () => {
  test("1, 2, 4 ... up to 60 seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });
});

describe("RestClient", () => {
  test("sends the bot token, a Discord user agent and JSON, and returns the parsed answer", async () => {
    const { rest, channel } = await setup();
    const message = await rest.request<{ id: string; content: string }>("POST", `/channels/${channel.id}/messages`, {
      body: { content: "hello" },
    });
    expect(message.content).toBe("hello");
    const req = fake.requests[0]!;
    expect(req.authorization).toBe(`Bot ${TOKEN}`);
    expect(req.userAgent).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^DiscordBot \(https:\/\/github\.com\/ducky8x\/session-kit, \d+\.\d+\.\d+/);
    expect(req.body).toEqual({ content: "hello" });
  });

  test("a 429 with retry_after 1.5 retries the same call 1.5 s later on the clock", async () => {
    const { rest, clock, channel } = await setup();
    const path = `/channels/${channel.id}/messages`;
    fake.failNext({ method: "POST", path, status: 429, body: { message: "You are being rate limited.", retry_after: 1.5, global: false } });
    const sent = rest.request("POST", path, { body: { content: "once" } });
    await waitFor(() => fake.requests.length === 1 && clock.pending === 1);
    await clock.advance(1499);
    expect(fake.requests).toHaveLength(1);
    await clock.advance(1);
    await sent;
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.body).toEqual({ content: "once" });
    expect(fake.posted(channel.id).map((m) => m.content)).toEqual(["once"]);
  });

  test("bucket headers pause that route until the reset, and leave other routes alone", async () => {
    const { rest, clock, channel } = await setup();
    const other = fake.addChannel({ name: "other" });
    const path = `/channels/${channel.id}/messages`;
    fake.addHeaders({ path, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "2.000" } });
    await rest.request("POST", path, { body: { content: "first" } });
    const second = rest.request("POST", path, { body: { content: "second" } });
    await rest.request("POST", `/channels/${other.id}/messages`, { body: { content: "elsewhere" } });
    expect(fake.posted().map((m) => m.content)).toEqual(["first", "elsewhere"]);
    await clock.advance(1999);
    expect(fake.posted()).toHaveLength(2);
    await clock.advance(1);
    await second;
    expect(fake.posted().map((m) => m.content)).toEqual(["first", "elsewhere", "second"]);
  });

  test("a 403 is not retried: it throws, and the log has the route and code but not the body", async () => {
    const { rest, log, channel } = await setup();
    const path = `/channels/${channel.id}/messages`;
    fake.failNext({ path, status: 403, body: { message: "Missing Access to the words private plans", code: 50001 } });
    const error = await rest.request("POST", path, { body: { content: "private plans" } }).catch((e) => e);
    expect(error).toBeInstanceOf(RestError);
    expect(error).toMatchObject({ kind: "client", status: 403, code: 50001 });
    expect(fake.requests).toHaveLength(1);
    expect(log.lines.join("\n")).toContain(`POST /channels/${channel.id}/messages`);
    expect(log.lines.join("\n")).toContain("403");
    expect(log.lines.join("\n")).not.toContain("private plans");
    expect(log.lines.join("\n")).not.toContain("Missing Access");
  });

  test("a 5xx is retried with backoff", async () => {
    const { rest, clock, channel } = await setup();
    const path = `/channels/${channel.id}/messages`;
    fake.failNext({ path, status: 502, times: 2 });
    const sent = rest.request("POST", path, { body: { content: "eventually" } });
    await waitFor(() => fake.requests.length === 1 && clock.pending === 1);
    await clock.advance(1000);
    await waitFor(() => fake.requests.length === 2 && clock.pending === 1);
    await clock.advance(1999);
    expect(fake.requests).toHaveLength(2);
    await clock.advance(1);
    await sent;
    expect(fake.posted(channel.id)).toHaveLength(1);
  });

  test("network errors are retried, then reported as a network failure", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw new TypeError("fetch failed: connection refused");
    }) as unknown as typeof fetch;
    const { rest, clock, log } = await setup({ maxRetries: 2, fetch: failing });
    const sent = rest.request("GET", "/gateway/bot").catch((e) => e);
    await waitFor(() => calls === 1 && clock.pending === 1);
    await clock.advance(1000);
    await waitFor(() => calls === 2 && clock.pending === 1);
    await clock.advance(2000);
    const error = await sent;
    expect(calls).toBe(3);
    expect(error).toMatchObject({ kind: "network" });
    expect(log.lines.some((l) => l.includes("GET /gateway/bot"))).toBe(true);
  });

  test("a global 429 pauses every route", async () => {
    const { rest, clock, channel } = await setup();
    const other = fake.addChannel({ name: "other" });
    fake.failNext({ path: `/channels/${channel.id}/messages`, status: 429, body: { retry_after: 3, global: true } });
    const first = rest.request("POST", `/channels/${channel.id}/messages`, { body: { content: "a" } });
    await waitFor(() => fake.requests.length === 1 && clock.pending === 1);
    const second = rest.request("POST", `/channels/${other.id}/messages`, { body: { content: "b" } });
    await clock.advance(2999);
    expect(fake.requests).toHaveLength(1);
    await clock.advance(1);
    await Promise.all([first, second]);
    expect(fake.posted()).toHaveLength(2);
  });

  test("a caller can take a 429 back instead of a retry", async () => {
    const { rest, channel } = await setup();
    fake.failNext({ path: `/channels/${channel.id}`, status: 429, body: { retry_after: 120.5 } });
    const error = await rest
      .request("PATCH", `/channels/${channel.id}`, { body: { name: "renamed" }, retry429: false })
      .catch((e) => e);
    expect(error).toMatchObject({ kind: "rate-limited", retryAfterMs: 120_500 });
    expect(fake.requests).toHaveLength(1);
  });

  test("without a token nothing is sent", async () => {
    fake = await FakeDiscordRest.start();
    const rest = new RestClient({ baseUrl: fake.baseUrl, token: () => null, clock: new FakeClock(), log: memoryLogger() });
    await expect(rest.request("GET", "/gateway/bot")).rejects.toMatchObject({ kind: "no-token" });
    expect(fake.requests).toHaveLength(0);
  });

  test("a 204 answer comes back as undefined", async () => {
    const { rest, channel } = await setup();
    fake.failNext({ path: `/channels/${channel.id}`, method: "DELETE", status: 204 });
    expect(await rest.request("DELETE", `/channels/${channel.id}`)).toBeUndefined();
  });
});

describe("the fake API's message list", () => {
  test("lists newest first, the newest by default and the oldest after an id, and keeps the query", async () => {
    const { rest, channel } = await setup();
    const ids = Array.from({ length: 5 }, (_, i) => fake.addMessage({ channelId: channel.id, content: `m${i}` }).id);
    const newest = await rest.request<{ id: string }[]>("GET", `/channels/${channel.id}/messages?limit=2`);
    expect(newest.map((m) => m.id)).toEqual([ids[4]!, ids[3]!]);
    const after = await rest.request<{ id: string }[]>("GET", `/channels/${channel.id}/messages?after=${ids[0]}&limit=2`);
    expect(after.map((m) => m.id)).toEqual([ids[2]!, ids[1]!]);
    expect(fake.requestsMatching("GET", `/channels/${channel.id}/messages`).map((r) => r.query)).toEqual([
      "?limit=2",
      `?after=${ids[0]}&limit=2`,
    ]);
    await expect(rest.request("GET", "/channels/123456789/messages?limit=1")).rejects.toMatchObject({ code: 10003 });
  });
});
