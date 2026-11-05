/**
 * Starting other programs, behind one small interface so the tests never start a real one.
 * The helper uses it for the `claude` CLI, `security` and `launchctl`.
 */
export interface RunOptions {
  /** The folder to run in. */
  cwd?: string;
  /** Added to (and overriding) the helper's own environment. */
  env?: Record<string, string>;
  /** Text written to the program's stdin, which is then closed. Without it, stdin is empty. */
  stdin?: string;
  /** Stop the program after this long. Without one, `run` uses the runner's default (20 seconds). */
  timeoutMs?: number;
  /** After a timeout, how long the program gets to end by itself before it is killed hard. Default 2 seconds. */
  killGraceMs?: number;
}

export interface RunResult {
  /** 127 when the program could not be started at all. */
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** A program started and left running. */
export interface RunningProcess {
  readonly pid: number | undefined;
  kill(): void;
  /** Resolves with the exit code when the program ends, however it ends. */
  readonly exited: Promise<number>;
}

export interface ProcessRunner {
  /** Run to the end and collect what it printed. Never throws. */
  run(cmd: readonly string[], opts?: RunOptions): Promise<RunResult>;
  /** Start and leave running. Never throws. */
  spawn(cmd: readonly string[], opts?: RunOptions): RunningProcess;
}

const NOT_STARTED = 127;
const KILLED_BY_TIMEOUT = 143;
/** How long any program the helper starts may run before it is stopped, unless the caller says otherwise. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

function environment(extra: Record<string, string> | undefined): Record<string, string | undefined> {
  return { ...process.env, ...extra };
}

export interface ProcessRunnerOptions {
  /** The time limit for a `run` that gives none of its own. */
  defaultTimeoutMs?: number;
}

export function createProcessRunner(options: ProcessRunnerOptions = {}): ProcessRunner {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return {
    async run(cmd, opts = {}) {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([...cmd], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          env: environment(opts.env),
        });
      } catch (error) {
        return { code: NOT_STARTED, stdout: "", stderr: (error as Error).message };
      }
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
      const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      let timedOut = false;
      let soft: ReturnType<typeof setTimeout> | undefined;
      let hard: ReturnType<typeof setTimeout> | undefined;
      const collected = Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      collected.catch(() => {}); // abandoned after a hard kill: its failure is of no interest
      // A program that ignores the polite stop (or leaves a child holding its pipes) must not hold the call forever.
      const gaveUp = new Promise<null>((resolve) => {
        soft = setTimeout(() => {
          timedOut = true;
          proc.kill();
          hard = setTimeout(() => {
            proc.kill(9);
            resolve(null);
          }, graceMs);
        }, timeoutMs);
      });
      try {
        const done = await Promise.race([collected, gaveUp]);
        if (done === null) return { code: KILLED_BY_TIMEOUT, stdout: "", stderr: "", timedOut: true };
        const [stdout, stderr, code] = done;
        return { code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) };
      } finally {
        if (soft !== undefined) clearTimeout(soft);
        if (hard !== undefined) clearTimeout(hard);
      }
    },

    spawn(cmd, opts = {}) {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([...cmd], {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          env: environment(opts.env),
        });
      } catch {
        return { pid: undefined, kill() {}, exited: Promise.resolve(NOT_STARTED) };
      }
      return {
        pid: proc.pid,
        kill: () => void proc.kill(),
        exited: proc.exited,
      };
    },
  };
}

export const realProcessRunner: ProcessRunner = createProcessRunner();
