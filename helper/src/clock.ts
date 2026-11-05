/** Time as the helper sees it. Real in production, fake in tests. */
export type TimerHandle = unknown;

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** setTimeout delays above this overflow, so longer waits are capped (callers re-check and wait again). */
const MAX_DELAY_MS = 2 ** 31 - 1;

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(Math.max(0, ms), MAX_DELAY_MS)),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
