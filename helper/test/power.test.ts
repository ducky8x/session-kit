import { describe, expect, test } from "bun:test";
import { memoryLogger } from "../src/log.ts";
import { PMSET, POWER_CHECK_MS, PowerMonitor, type PowerSource, parsePowerSource } from "../src/power.ts";
import { FakeClock } from "./fakes/fake-clock.ts";
import { FakeProcessRunner } from "./fakes/fake-process.ts";

const AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n";
const BATTERY = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t87%; discharging; 5:12 remaining present: true\n";

describe("parsePowerSource", () => {
  test("AC Power is AC and Battery Power is battery", () => {
    expect(parsePowerSource({ code: 0, stdout: AC, stderr: "" })).toBe("ac");
    expect(parsePowerSource({ code: 0, stdout: BATTERY, stderr: "" })).toBe("battery");
  });

  test("anything else counts as AC: a UPS, a Mac without a battery, unknown output", () => {
    expect(parsePowerSource({ code: 0, stdout: "Now drawing from 'UPS Power'\n", stderr: "" })).toBe("ac");
    expect(parsePowerSource({ code: 0, stdout: "Now drawing from 'AC Power'\n", stderr: "" })).toBe("ac");
    expect(parsePowerSource({ code: 0, stdout: "something new\n", stderr: "" })).toBe("ac");
    expect(parsePowerSource({ code: 0, stdout: "", stderr: "" })).toBe("ac");
  });

  test("a failed pmset counts as AC, whatever it printed", () => {
    expect(parsePowerSource({ code: 1, stdout: BATTERY, stderr: "pmset: error" })).toBe("ac");
    expect(parsePowerSource({ code: 127, stdout: "", stderr: "not found" })).toBe("ac");
    expect(parsePowerSource({ code: 143, stdout: "", stderr: "", timedOut: true })).toBe("ac");
  });
});

describe("PowerMonitor", () => {
  function kit(first = AC) {
    const power = { output: first, code: 0 };
    const runner = new FakeProcessRunner().on((cmd) =>
      cmd[0] === PMSET[0] ? { code: power.code, stdout: power.output, stderr: "" } : undefined,
    );
    const clock = new FakeClock();
    const log = memoryLogger();
    const changes: PowerSource[] = [];
    const monitor = new PowerMonitor({ runner, clock, log, onChange: (source) => void changes.push(source) });
    return { power, runner, clock, log, changes, monitor };
  }

  test("reads pmset -g ps when started and then every minute", async () => {
    const k = kit();
    expect(POWER_CHECK_MS).toBe(60_000);
    await k.monitor.start();
    expect(k.runner.commands).toEqual(["/usr/bin/pmset -g ps"]);
    expect(k.runner.runs[0]!.opts.timeoutMs).toBeGreaterThan(0);
    await k.clock.advance(59_999);
    expect(k.runner.runs).toHaveLength(1);
    await k.clock.advance(1);
    expect(k.runner.runs).toHaveLength(2);
    k.monitor.stop();
    await k.clock.advance(10 * 60_000);
    expect(k.runner.runs).toHaveLength(2);
  });

  test("the first reading sets the source without reporting a change", async () => {
    const k = kit(BATTERY);
    expect(k.monitor.source).toBe("ac");
    await k.monitor.start();
    expect(k.monitor.source).toBe("battery");
    expect(k.monitor.onBattery).toBe(true);
    expect(k.changes).toEqual([]);
    expect(k.log.lines).toEqual(["info on battery power"]);
  });

  test("reports changes only, and logs each switch in one line", async () => {
    const k = kit();
    await k.monitor.start();
    await k.clock.advance(60_000);
    expect(k.changes).toEqual([]);
    k.power.output = BATTERY;
    await k.clock.advance(60_000);
    await k.clock.advance(60_000);
    expect(k.changes).toEqual(["battery"]);
    k.power.output = AC;
    await k.clock.advance(60_000);
    expect(k.changes).toEqual(["battery", "ac"]);
    expect(k.log.lines).toEqual(["info on AC power", "info on battery power", "info on AC power"]);
  });

  test("a pmset that fails while on battery counts as a switch to AC", async () => {
    const k = kit(BATTERY);
    await k.monitor.start();
    k.power.code = 1;
    await k.clock.advance(60_000);
    expect(k.changes).toEqual(["ac"]);
  });

  test("a reading that comes back after stop reports nothing", async () => {
    const k = kit();
    await k.monitor.start();
    k.power.output = BATTERY;
    const check = k.monitor.check();
    k.monitor.stop();
    await check;
    expect(k.changes).toEqual([]);
  });

  test("start while running does not read again or start a second timer", async () => {
    const k = kit();
    await k.monitor.start();
    await k.monitor.start();
    expect(k.runner.runs).toHaveLength(1);
    await k.clock.advance(60_000);
    expect(k.runner.runs).toHaveLength(2);
  });
});
