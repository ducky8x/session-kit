/** Wait (without a fixed sleep) until something becomes true, for socket I/O that no fake clock can drive. */
export async function waitFor(check: () => boolean | Promise<boolean>, limitMs = 3000): Promise<void> {
  const start = performance.now();
  while (!(await check())) {
    if (performance.now() - start > limitMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}
