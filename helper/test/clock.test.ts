import { describe, expect, test } from "bun:test";
import { realClock } from "../src/clock.ts";
import { FakeClock } from "./fakes/fake-clock.ts";

describe("FakeClock", () => {
  test("runs timers in order as time advances", async () => {
    const clock = new FakeClock(1000);
    const seen: string[] = [];
    clock.setTimeout(() => seen.push("b"), 200);
    clock.setTimeout(() => seen.push("a"), 100);
    await clock.advance(150);
    expect(seen).toEqual(["a"]);
    await clock.advance(100);
    expect(seen).toEqual(["a", "b"]);
    expect(clock.now()).toBe(1250);
  });

  test("runs timers that other timers schedule", async () => {
    const clock = new FakeClock(0);
    const seen: number[] = [];
    clock.setTimeout(() => {
      seen.push(clock.now());
      clock.setTimeout(() => seen.push(clock.now()), 50);
    }, 100);
    await clock.advance(1000);
    expect(seen).toEqual([100, 150]);
  });

  test("clearTimeout stops a timer", async () => {
    const clock = new FakeClock(0);
    let ran = false;
    const handle = clock.setTimeout(() => (ran = true), 10);
    clock.clearTimeout(handle);
    await clock.advance(100);
    expect(ran).toBe(false);
    expect(clock.pending).toBe(0);
  });
});

describe("realClock", () => {
  test("reads the wall clock and runs a timer", async () => {
    const before = Date.now();
    expect(realClock.now()).toBeGreaterThanOrEqual(before);
    const fired = await new Promise<boolean>((resolve) => realClock.setTimeout(() => resolve(true), 1));
    expect(fired).toBe(true);
  });

  test("a cleared timer does not run", async () => {
    let ran = false;
    const handle = realClock.setTimeout(() => (ran = true), 5);
    realClock.clearTimeout(handle);
    await Bun.sleep(20);
    expect(ran).toBe(false);
  });
});
