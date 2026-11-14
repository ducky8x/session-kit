import { describe, expect, test } from "bun:test";
import { type CallHelper, type HelperReply, type HelperRequest, HelperError } from "../src/client.ts";
import { defaultConfig, saveConfig } from "../src/config.ts";
import { LISTEN_GRACE_MS, LISTEN_RETRY_MS, listenCommand } from "../src/listen.ts";
import { pathsFor } from "../src/paths.ts";
import { FakeClock, settle } from "./fakes/fake-clock.ts";
import { tmpDir } from "./helpers/tmp.ts";

const SID = "aaaa1111-2222-3333-4444-555566667777";
const HOUR_MS = 3_600_000;

/** The helper as `listen` sees it through `call`: up or down, and holding at most one waiting `listen`. */
class FakeHelper {
  up = false;
  /** Every attempt fails with this instead, when set. */
  failWith: HelperError | null = null;
  readonly requests: HelperRequest[] = [];
  private waiting: { resolve(reply: HelperReply): void; reject(error: Error): void } | null = null;

  call: CallHelper = (_socketPath, request, opts = {}) => {
    this.requests.push(request);
    if (this.failWith) return Promise.reject(this.failWith);
    if (!this.up) return Promise.reject(new HelperError("not-running", "The Discord helper isn't running."));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      opts.signal?.addEventListener("abort", () => reject(new HelperError("aborted", "Stopped.")));
    });
  };

  get listening(): boolean {
    return this.waiting !== null;
  }

  /** Answer the waiting `listen` with this event. */
  send(event: Record<string, unknown>): void {
    const waiting = this.waiting;
    if (!waiting) throw new Error("nothing is listening");
    this.waiting = null;
    waiting.resolve({ ok: true, event });
  }

  /** The helper stops (or restarts): a waiting `listen` loses its connection with `code`. */
  stop(code = "closed"): void {
    this.up = false;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(new HelperError(code, "The Discord helper closed the connection without an answer."));
  }
}

function harness(o: { config?: "on" | "off" | "missing"; signal?: AbortSignal; graceMs?: number; retryMs?: number } = {}) {
  const paths = pathsFor(tmpDir());
  if ((o.config ?? "on") !== "missing") saveConfig(paths, { ...defaultConfig(), enabled: o.config !== "off" });
  const helper = new FakeHelper();
  const clock = new FakeClock();
  const out: string[] = [];
  const err: string[] = [];
  let code: number | undefined;
  const run = async (args: string[] = ["--session", SID]) => {
    const result = await listenCommand(args, {
      paths,
      out: (text) => void out.push(text),
      err: (text) => void err.push(text),
      call: helper.call,
      clock,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.graceMs === undefined ? {} : { graceMs: o.graceMs }),
      ...(o.retryMs === undefined ? {} : { retryMs: o.retryMs }),
    });
    code = result;
    return result;
  };
  return {
    paths,
    helper,
    clock,
    run,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    /** The exit code, or undefined while `listen` is still running. */
    code: () => code,
  };
}

const LISTEN = { op: "listen", sessionId: SID };
const TEXT = { type: "text", id: "m1", text: "are you there?", at: 1 };

describe("sk-discord listen", () => {
  test("waits for one event, prints it as one JSON line and exits 0", async () => {
    const h = harness();
    h.helper.up = true;
    const running = h.run();
    await settle();
    expect(h.helper.listening).toBe(true);
    h.helper.send(TEXT);
    expect(await running).toBe(0);
    expect(h.stdout()).toBe(`${JSON.stringify(TEXT)}\n`);
    expect(h.stderr()).toBe("");
    expect(h.helper.requests).toEqual([LISTEN]);
  });

  test("the grace period is 3 minutes and it tries every 2 seconds", () => {
    expect(LISTEN_GRACE_MS).toBe(180_000);
    expect(LISTEN_RETRY_MS).toBe(2_000);
  });

  test("with the helper down at the start, it keeps trying and prints the event once the helper is back", async () => {
    const h = harness();
    const running = h.run();
    await settle();
    await h.clock.advance(30_000);
    expect(h.code()).toBeUndefined();
    expect(h.stdout()).toBe("");
    expect(h.helper.requests.length).toBeGreaterThan(10);

    h.helper.up = true;
    await h.clock.advance(LISTEN_RETRY_MS);
    expect(h.helper.listening).toBe(true);
    h.helper.send({ ...TEXT, queued: true });
    expect(await running).toBe(0);
    expect(h.stdout()).toBe(`${JSON.stringify({ ...TEXT, queued: true })}\n`);
    expect(h.stderr()).toBe("");
    expect(h.helper.requests.every((r) => JSON.stringify(r) === JSON.stringify(LISTEN))).toBe(true);
  });

  test("with the helper down for the whole grace period, it prints helper-down and exits 2", async () => {
    const h = harness();
    const running = h.run();
    await settle();
    await h.clock.advance(LISTEN_GRACE_MS - 1);
    expect(h.code()).toBeUndefined();
    expect(h.stdout()).toBe("");

    await h.clock.advance(1);
    expect(await running).toBe(2);
    expect(h.stdout()).toBe('{"type":"helper-down"}\n');
    expect(h.stderr()).toBe("");
    // A try at the start, one every 2 seconds, and a last one when the time is up.
    expect(h.helper.requests).toHaveLength(LISTEN_GRACE_MS / LISTEN_RETRY_MS + 1);
    expect(h.clock.pending).toBe(0);
  });

  test("takes a shorter grace period and retry interval", async () => {
    const h = harness({ graceMs: 1_000, retryMs: 100 });
    const running = h.run();
    await settle();
    await h.clock.advance(999);
    expect(h.code()).toBeUndefined();
    await h.clock.advance(1);
    expect(await running).toBe(2);
    expect(h.stdout()).toBe('{"type":"helper-down"}\n');
    expect(h.helper.requests).toHaveLength(11);
  });

  test("every way of not reaching the helper counts as down", async () => {
    for (const code of ["not-running", "closed", "connection", "protocol"]) {
      const h = harness();
      h.helper.failWith = new HelperError(code, "gone");
      const running = h.run();
      await settle();
      await h.clock.advance(LISTEN_GRACE_MS - 1);
      expect(h.code()).toBeUndefined();
      await h.clock.advance(1);
      expect(await running).toBe(2);
      expect(h.stdout()).toBe('{"type":"helper-down"}\n');
    }
  });

  test("when the connection drops while it waits, it reconnects and prints the next event", async () => {
    const h = harness();
    h.helper.up = true;
    const running = h.run();
    await settle();
    await h.clock.advance(HOUR_MS);
    expect(h.helper.listening).toBe(true);

    // The helper restarts: down for about 10 seconds.
    h.helper.stop("closed");
    await settle();
    await h.clock.advance(10_000);
    expect(h.code()).toBeUndefined();
    expect(h.stdout()).toBe("");
    h.helper.up = true;
    await h.clock.advance(LISTEN_RETRY_MS);
    expect(h.helper.listening).toBe(true);

    h.helper.send(TEXT);
    expect(await running).toBe(0);
    expect(h.stdout()).toBe(`${JSON.stringify(TEXT)}\n`);
    expect(h.helper.requests.every((r) => JSON.stringify(r) === JSON.stringify(LISTEN))).toBe(true);
  });

  test("a drop after a long wait gets the whole grace period, even after an earlier outage", async () => {
    const h = harness();
    const running = h.run();
    await settle();
    await h.clock.advance(60_000);
    h.helper.up = true;
    await h.clock.advance(LISTEN_RETRY_MS);
    expect(h.helper.listening).toBe(true);
    await h.clock.advance(HOUR_MS);

    h.helper.stop("closed");
    await settle();
    await h.clock.advance(LISTEN_GRACE_MS - 1);
    expect(h.code()).toBeUndefined();
    await h.clock.advance(1);
    expect(await running).toBe(2);
    expect(h.stdout()).toBe('{"type":"helper-down"}\n');
  });

  test("a helper that keeps dropping the connection soon after it starts still counts as down", async () => {
    const h = harness();
    const running = h.run();
    await settle();
    const start = h.clock.now();
    while (h.code() === undefined && h.clock.now() - start < 2 * LISTEN_GRACE_MS) {
      await h.clock.advance(10_000);
      h.helper.up = true;
      await h.clock.advance(LISTEN_RETRY_MS);
      await h.clock.advance(5_000);
      h.helper.stop("closed");
      await settle();
    }
    expect(await running).toBe(2);
    expect(h.stdout()).toBe('{"type":"helper-down"}\n');
    expect(h.clock.now() - start).toBeLessThan(LISTEN_GRACE_MS + 20_000);
  });

  test("stopping it during a wait between tries ends it at once, without helper-down", async () => {
    const stop = new AbortController();
    const h = harness({ signal: stop.signal });
    const running = h.run();
    await settle();
    await h.clock.advance(LISTEN_RETRY_MS / 2);
    expect(h.clock.pending).toBe(1);
    stop.abort();
    expect(await running).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toBe("Stopped.\n");
    expect(h.clock.pending).toBe(0);
    expect(h.helper.requests).toHaveLength(1);
  });

  test("stopping it while it waits for an event ends it the same way", async () => {
    const stop = new AbortController();
    const h = harness({ signal: stop.signal });
    h.helper.up = true;
    const running = h.run();
    await settle();
    stop.abort();
    expect(await running).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toBe("Stopped.\n");
    expect(h.clock.pending).toBe(0);
  });

  test("an error that isn't the helper going away exits 1 at once", async () => {
    const h = harness();
    h.helper.failWith = new HelperError("internal", "Something went wrong inside the Discord helper.");
    expect(await h.run()).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toBe("Something went wrong inside the Discord helper.\n");
    expect(h.helper.requests).toHaveLength(1);
    expect(h.clock.pending).toBe(0);
  });

  test("an error that isn't the helper going away, after a few tries, still exits 1 at once", async () => {
    const h = harness();
    const running = h.run();
    await settle();
    await h.clock.advance(3 * LISTEN_RETRY_MS);
    h.helper.failWith = new HelperError("invalid", '"sessionId" must be text.');
    await h.clock.advance(LISTEN_RETRY_MS);
    expect(await running).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toBe('"sessionId" must be text.\n');
    expect(h.clock.pending).toBe(0);
  });

  test("with Discord off, or never set up, it prints disabled without calling the helper", async () => {
    for (const config of ["off", "missing"] as const) {
      const h = harness({ config });
      expect(await h.run()).toBe(0);
      expect(h.stdout()).toBe('{"type":"disabled"}\n');
      expect(h.helper.requests).toEqual([]);
    }
  });

  test("needs --session and takes nothing else", async () => {
    const h = harness();
    expect(await h.run([])).toBe(1);
    expect(h.stderr()).toContain("--session <id> is required.");
    expect(await h.run(["--session", SID, "--loud"])).toBe(1);
    expect(h.stderr()).toContain("Unknown argument --loud.");
    expect(h.helper.requests).toEqual([]);
  });
});
