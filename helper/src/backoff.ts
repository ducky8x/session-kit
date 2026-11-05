/** How long to wait after `failures` failed attempts in a row: 1, 2, 4 ... seconds, at most 60. */
export function backoffMs(failures: number): number {
  return Math.min(60, 2 ** Math.max(0, failures)) * 1000;
}
