import { realClock } from "./clock.ts";
import { Daemon } from "./daemon.ts";
import { EXTENSIONS } from "./extensions.ts";
import { FileLogger, type Logger } from "./log.ts";
import { pathsFor } from "./paths.ts";
import { realProcessRunner } from "./process.ts";
import { SecurityKeychain } from "./secrets.ts";
import { AlreadyRunning } from "./server.ts";
import { ensurePrivateDir } from "./state.ts";

/** Run a started daemon until `signal` fires. A second daemon finds the socket in use, says so and exits 0. */
export async function serveUntilStopped(daemon: Daemon, log: Logger, signal: AbortSignal): Promise<number> {
  try {
    await daemon.start();
  } catch (error) {
    if (error instanceof AlreadyRunning) {
      log.info("already running");
      return 0;
    }
    log.error(`could not start: ${(error as Error).message}`);
    return 1;
  }
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  await daemon.stop();
  log.info("stopped");
  return 0;
}

/** `sk-discord daemon` with the real clock, programs, keychain and log, until SIGTERM or SIGINT. */
export async function runDaemon(o: { home: string; env: Record<string, string | undefined> }): Promise<number> {
  const paths = pathsFor(o.home);
  ensurePrivateDir(paths.dir);
  const log = new FileLogger(paths.log);
  const runner = realProcessRunner;
  const daemon = new Daemon({
    paths,
    env: o.env,
    clock: realClock,
    log,
    runner,
    keychain: new SecurityKeychain(runner),
    extensions: EXTENSIONS,
  });
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  return serveUntilStopped(daemon, log, stop.signal);
}
