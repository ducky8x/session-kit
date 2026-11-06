import type { Clock, TimerHandle } from "./clock.ts";
import type { Logger } from "./log.ts";
import type { ProcessRunner, RunResult } from "./process.ts";

export type PowerSource = "ac" | "battery";

/** How often the power source is read. */
export const POWER_CHECK_MS = 60_000;
/** The command that says where the Mac draws its power from. */
export const PMSET = ["/usr/bin/pmset", "-g", "ps"] as const;
const PMSET_TIMEOUT_MS = 5000;

/**
 * The power source from `pmset -g ps`: battery only when it says `Now drawing from 'Battery Power'`. Anything
 * else (AC, a UPS, a Mac with no battery, output this code doesn't know, a pmset that failed) counts as AC,
 * so the helper keeps its live connection.
 */
export function parsePowerSource(result: RunResult): PowerSource {
  if (result.code !== 0) return "ac";
  return /Now drawing from 'Battery Power'/.test(result.stdout) ? "battery" : "ac";
}

export interface PowerDeps {
  runner: ProcessRunner;
  clock: Clock;
  log: Logger;
  /** The source changed. The first reading after `start` sets the source without calling this. */
  onChange(source: PowerSource): void;
}

/** Reads the power source when started and then once a minute, and reports when it changes. */
export class PowerMonitor {
  private current: PowerSource = "ac";
  private timer: TimerHandle | null = null;
  private started: Promise<void> | null = null;
  private generation = 0;
  private known = false;

  constructor(private readonly d: PowerDeps) {}

  /** AC until the first reading says otherwise. */
  get source(): PowerSource {
    return this.current;
  }

  get onBattery(): boolean {
    return this.current === "battery";
  }

  /** Read the source now and then every minute. Resolves once the first reading is in. Safe to call while running. */
  start(): Promise<void> {
    if (this.started) return this.started;
    this.known = false;
    const generation = this.generation;
    const tick = () => {
      this.timer = this.d.clock.setTimeout(() => {
        this.timer = null;
        if (generation !== this.generation) return;
        tick();
        void this.check();
      }, POWER_CHECK_MS);
    };
    this.started = this.check().then(() => undefined);
    tick();
    return this.started;
  }

  stop(): void {
    this.generation++;
    this.started = null;
    if (this.timer !== null) this.d.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Read the source once. A change is logged, and reported unless it is the first reading. */
  async check(): Promise<PowerSource> {
    const generation = this.generation;
    const source = parsePowerSource(await this.d.runner.run(PMSET, { timeoutMs: PMSET_TIMEOUT_MS }));
    if (generation !== this.generation) return this.current;
    const first = !this.known;
    this.known = true;
    if (first || source !== this.current) {
      this.d.log.info(source === "battery" ? "on battery power" : "on AC power");
    }
    if (source === this.current) return source;
    this.current = source;
    if (!first) this.d.onChange(source);
    return source;
  }
}
