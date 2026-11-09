import type { Clock } from "./clock.ts";
import type { Logger } from "./log.ts";
import type { ProcessRunner, RunResult } from "./process.ts";

/** The command whose output says how long ago the keyboard or mouse was last used. */
export const IOREG = ["/usr/sbin/ioreg", "-c", "IOHIDSystem"] as const;
const IOREG_TIMEOUT_MS = 5000;

/**
 * Seconds since the last keyboard or mouse input: the first `HIDIdleTime` in `ioreg -c IOHIDSystem`, which is
 * in nanoseconds. Null when ioreg failed or printed no value this code can read.
 */
export function parseIdleSeconds(result: RunResult): number | null {
  if (result.code !== 0) return null;
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(result.stdout);
  if (!match) return null;
  const nanoseconds = Number(match[1]);
  return Number.isFinite(nanoseconds) ? nanoseconds / 1e9 : null;
}

/** One reading of how long the user has gone without touching the keyboard or mouse. */
export interface IdleReading {
  /** When it was read (just before ioreg ran). */
  at: number;
  /** Milliseconds since the last input, or null when it couldn't be read. */
  idleMs: number | null;
}

/** Idle at least `awayMs`. An unknown idle time counts as away, so a failing ioreg never holds a post for good. */
export function isAway(reading: IdleReading, awayMs: number): boolean {
  return reading.idleMs === null || reading.idleMs >= awayMs;
}

/** When the keyboard or mouse was last used, or null when unknown. */
export function lastInputAt(reading: IdleReading): number | null {
  return reading.idleMs === null ? null : reading.at - reading.idleMs;
}

export interface PresenceDeps {
  runner: ProcessRunner;
  clock: Clock;
  log: Logger;
}

/** Reads the idle time with ioreg. A failure is logged once, until a reading works again. */
export class Presence {
  private failing = false;

  constructor(private readonly d: PresenceDeps) {}

  async read(): Promise<IdleReading> {
    // The time before ioreg runs: a slow ioreg then makes the last input look older, never newer.
    const at = this.d.clock.now();
    const seconds = parseIdleSeconds(await this.d.runner.run(IOREG, { timeoutMs: IOREG_TIMEOUT_MS }));
    if (seconds === null) {
      if (!this.failing) this.d.log.warn("could not read the idle time with ioreg; posts go out as if the user were away");
      this.failing = true;
      return { at, idleMs: null };
    }
    if (this.failing) this.d.log.info("the idle time can be read again");
    this.failing = false;
    return { at, idleMs: seconds * 1000 };
  }
}
