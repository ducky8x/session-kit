import { IOREG } from "../../src/presence.ts";
import type { FakeClock } from "./fake-clock.ts";
import type { FakeProcessRunner } from "./fake-process.ts";

/** What `ioreg -c IOHIDSystem` prints, cut down to the lines around `HIDIdleTime`, for an idle time in ms. */
export function ioregOutput(idleMs: number): string {
  const nanoseconds = BigInt(Math.max(0, Math.round(idleMs))) * 1_000_000n;
  return [
    "+-o IOHIDSystem  <class IOHIDSystem, id 0x100000a3c, registered, matched, active, busy 0 (0 ms), retain 26>",
    "    {",
    '      "IOClass" = "IOHIDSystem"',
    `      "HIDIdleTime" = ${nanoseconds}`,
    '      "IOProviderClass" = "IOResources"',
    "    }",
    "",
  ].join("\n");
}

/**
 * Answers `ioreg -c IOHIDSystem` on a fake runner from the fake clock. The user last touched the keyboard or
 * mouse at `lastInputAt`, which starts at "now": they're at the computer.
 */
export function fakeIdle(runner: FakeProcessRunner, clock: FakeClock) {
  const state = { lastInputAt: clock.now(), result: "ok" as "ok" | "failed" | "unreadable" };
  runner.prepend((cmd) => {
    if (cmd[0] !== IOREG[0]) return undefined;
    if (state.result === "failed") return { code: 1, stdout: "", stderr: "ioreg: failed" };
    if (state.result === "unreadable") return { code: 0, stdout: "+-o IOHIDSystem\n", stderr: "" };
    return { code: 0, stdout: ioregOutput(clock.now() - state.lastInputAt), stderr: "" };
  });
  return {
    state,
    /** The user uses the keyboard or mouse now. */
    touch: () => {
      state.lastInputAt = clock.now();
    },
    /** The user last used them this long ago. */
    idleFor: (ms: number) => {
      state.lastInputAt = clock.now() - ms;
    },
    /** How many times ioreg was asked. */
    reads: () => runner.runs.filter((r) => r.cmd[0] === IOREG[0]).length,
  };
}

export type FakeIdle = ReturnType<typeof fakeIdle>;
