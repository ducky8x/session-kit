import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { RestClient } from "../src/discord/rest.ts";
import { FileLogger, LOG_MAX_BYTES } from "../src/log.ts";
import { Outbox } from "../src/outbound.ts";
import { FakeClock } from "./fakes/fake-clock.ts";
import { FakeDiscordRest } from "./fakes/fake-rest.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { waitFor } from "./helpers/wait.ts";

const TOKEN = "FAKE00000000000000000000.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";

describe("FileLogger", () => {
  test("writes timestamped lines to a user-only file", () => {
    const file = `${tmpDir()}/helper.log`;
    const log = new FileLogger(file, { clock: new FakeClock(Date.UTC(2026, 10, 4, 12, 0, 0)) });
    log.info("started");
    log.warn("careful");
    log.error("broken");
    expect(readFileSync(file, "utf8")).toBe(
      "2026-11-04T12:00:00.000Z info started\n2026-11-04T12:00:00.000Z warn careful\n2026-11-04T12:00:00.000Z error broken\n",
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("rotates at 1 MB and keeps one old file", () => {
    const dir = tmpDir();
    const file = `${dir}/helper.log`;
    const log = new FileLogger(file);
    expect(LOG_MAX_BYTES).toBe(1024 * 1024);
    const line = "x".repeat(500);
    for (let i = 0; i < 5200; i++) log.info(`${i} ${line}`); // about 2.7 MB in all
    expect(statSync(file).size).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect(statSync(`${file}.1`).size).toBeGreaterThan(LOG_MAX_BYTES - 2000);
    expect(existsSync(`${file}.2`)).toBe(false);
    // The newest line is in the current file, and the old file holds the lines just before it.
    expect(readFileSync(file, "utf8").includes(`info 5199 ${line}`)).toBe(true);
    expect(readFileSync(`${file}.1`, "utf8").includes(`info 5199 ${line}`)).toBe(false);
  });

  test("never writes the token: neither one it was told about nor anything shaped like one", () => {
    const file = `${tmpDir()}/helper.log`;
    const log = new FileLogger(file);
    log.addSecret("s3cret-value-that-is-long");
    log.error(`connect failed: Authorization: Bot ${TOKEN}`);
    log.warn("the keychain said s3cret-value-that-is-long");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("s3cret-value-that-is-long");
    expect(text).toContain("[redacted]");
  });

  test("keeps each entry on one short line", () => {
    const file = `${tmpDir()}/helper.log`;
    const log = new FileLogger(file);
    log.error(`first\nsecond ${"y".repeat(5000)}`);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThan(700);
  });

  test("a log folder that cannot be written does not throw", () => {
    const log = new FileLogger("/nonexistent-dir/for/sure/helper.log");
    expect(() => log.info("nobody hears this")).not.toThrow();
  });
});

describe("what reaches the log from posting", () => {
  test("refused, failing and dropped posts log routes and codes, never the text or the token", async () => {
    const fake = await FakeDiscordRest.start();
    try {
      const dir = tmpDir();
      const clock = new FakeClock();
      const log = new FileLogger(`${dir}/helper.log`, { clock });
      log.addSecret(TOKEN);
      const rest = new RestClient({ baseUrl: fake.baseUrl, token: () => TOKEN, clock, log, maxRetries: 0 });
      const channel = fake.addChannel({ name: "work-cli" });
      const outbox = new Outbox({
        file: `${dir}/outbox.jsonl`,
        clock,
        log,
        rest,
        controlChannelId: () => null,
        resolveChannel: async () => channel.id,
        onUnknownChannel: () => {},
      });
      const words = "the launch codes are in the second drawer";
      fake.failNext({ path: /messages$/, status: 403, body: { code: 50001, message: `Missing Access: ${words}` } });
      fake.failNext({ path: /messages$/, status: 500, body: { message: words } });
      outbox.enqueue([
        { target: "s1", content: words, allowedMentions: { parse: [] } },
        { target: "s1", content: `${words} again`, allowedMentions: { parse: [] } },
      ]);
      outbox.setOnline(true);
      await waitFor(() => clock.pending === 1);
      await clock.advance(60_000);
      await outbox.idle();
      expect(fake.posted(channel.id).map((m) => m.content)).toEqual([`${words} again`]);
      const text = readFileSync(`${dir}/helper.log`, "utf8");
      expect(text).toContain("403");
      expect(text).toContain("500");
      expect(text).not.toContain("launch codes");
      expect(text).not.toContain(TOKEN);
    } finally {
      fake.stop();
    }
  });
});
