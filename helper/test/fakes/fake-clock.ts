import type { Clock, TimerHandle } from "../../src/clock.ts";

interface Timer {
  id: number;
  due: number;
  fn: () => void;
}

/** A clock tests move by hand. Nothing here waits for real time. */
export class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private timers: Timer[] = [];

  constructor(start: number | Date = new Date(2026, 10, 4, 12, 0, 0)) {
    this.current = typeof start === "number" ? start : start.getTime();
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const timer: Timer = { id: this.nextId++, due: this.current + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** How many timers are still waiting. */
  get pending(): number {
    return this.timers.length;
  }

  /** When the next timer falls due, or null when none is waiting. */
  get nextDue(): number | null {
    let next: number | null = null;
    for (const t of this.timers) if (next === null || t.due < next) next = t.due;
    return next;
  }

  /** Move time forward, running every timer that falls due, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.due <= target)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = Math.max(this.current, due.due);
      due.fn();
      await settle();
    }
    this.current = target;
    await settle();
  }

  /** Jump to an absolute time (never backwards), running timers on the way. */
  async advanceTo(at: number | Date): Promise<void> {
    const target = typeof at === "number" ? at : at.getTime();
    await this.advance(Math.max(0, target - this.current));
  }
}

/** Let promise chains started by a timer finish (no real waiting). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}
