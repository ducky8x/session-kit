import { describe, expect, test } from "bun:test";
import { memoryLogger } from "../src/log.ts";
import { IOREG, Presence, isAway, lastInputAt, parseIdleSeconds } from "../src/presence.ts";
import { FakeClock } from "./fakes/fake-clock.ts";
import { fakeIdle, ioregOutput } from "./fakes/fake-idle.ts";
import { FakeProcessRunner } from "./fakes/fake-process.ts";

const MINUTE = 60_000;

describe("parseIdleSeconds", () => {
  test("reads the first HIDIdleTime, in nanoseconds, as seconds", () => {
    expect(parseIdleSeconds({ code: 0, stdout: ioregOutput(90_000), stderr: "" })).toBe(90);
    expect(parseIdleSeconds({ code: 0, stdout: ioregOutput(0), stderr: "" })).toBe(0);
    const two = `${ioregOutput(1500)}${ioregOutput(7 * MINUTE)}`;
    expect(parseIdleSeconds({ code: 0, stdout: two, stderr: "" })).toBe(1.5);
  });

  test("output with no HIDIdleTime is unknown", () => {
    expect(parseIdleSeconds({ code: 0, stdout: "", stderr: "" })).toBeNull();
    expect(parseIdleSeconds({ code: 0, stdout: '"HIDIdleTimeDelta" = 12\n"HIDIdleTime" = soon\n', stderr: "" })).toBeNull();
  });

  test("a failed or stopped ioreg is unknown, whatever it printed", () => {
    expect(parseIdleSeconds({ code: 1, stdout: ioregOutput(90_000), stderr: "ioreg: error" })).toBeNull();
    expect(parseIdleSeconds({ code: 127, stdout: "", stderr: "not found" })).toBeNull();
    expect(parseIdleSeconds({ code: 143, stdout: "", stderr: "", timedOut: true })).toBeNull();
  });
});

describe("away or not", () => {
  test("away takes at least the given idle time", () => {
    expect(isAway({ at: 0, idleMs: 5 * MINUTE }, 5 * MINUTE)).toBe(true);
    expect(isAway({ at: 0, idleMs: 5 * MINUTE - 1 }, 5 * MINUTE)).toBe(false);
  });

  test("an unknown idle time counts as away", () => {
    expect(isAway({ at: 0, idleMs: null }, 5 * MINUTE)).toBe(true);
    expect(lastInputAt({ at: 10 * MINUTE, idleMs: null })).toBeNull();
  });

  test("the last input is the reading's time less the idle time", () => {
    expect(lastInputAt({ at: 10 * MINUTE, idleMs: 3 * MINUTE })).toBe(7 * MINUTE);
  });
});

describe("Presence", () => {
  function kit() {
    const runner = new FakeProcessRunner();
    const clock = new FakeClock();
    const log = memoryLogger();
    const idle = fakeIdle(runner, clock);
    return { runner, clock, log, idle, presence: new Presence({ runner, clock, log }) };
  }

  test("runs ioreg -c IOHIDSystem with a 5-second limit", async () => {
    const k = kit();
    k.idle.idleFor(2 * MINUTE);
    expect(await k.presence.read()).toEqual({ at: k.clock.now(), idleMs: 2 * MINUTE });
    expect(k.runner.commands).toEqual([IOREG.join(" ")]);
    expect(k.runner.runs[0]!.opts.timeoutMs).toBe(5000);
  });

  test("a failed or unreadable ioreg reads as unknown, logged once until it works again", async () => {
    const k = kit();
    k.idle.state.result = "failed";
    expect((await k.presence.read()).idleMs).toBeNull();
    k.idle.state.result = "unreadable";
    expect((await k.presence.read()).idleMs).toBeNull();
    expect(k.log.lines.filter((l) => l.startsWith("warn"))).toHaveLength(1);
    k.idle.state.result = "ok";
    expect((await k.presence.read()).idleMs).toBe(0);
    expect(k.log.lines.at(-1)).toBe("info the idle time can be read again");
  });
});
