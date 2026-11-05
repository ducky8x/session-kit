import type { ProcessRunner, RunOptions, RunResult, RunningProcess } from "../../src/process.ts";

export interface RunCall {
  cmd: string[];
  opts: RunOptions;
}

export class FakeRunning implements RunningProcess {
  killed = false;
  readonly pid: number;
  readonly exited: Promise<number>;
  private finish!: (code: number) => void;

  constructor(
    readonly cmd: string[],
    readonly opts: RunOptions,
    pid: number,
  ) {
    this.pid = pid;
    this.exited = new Promise<number>((resolve) => {
      this.finish = resolve;
    });
  }

  kill(): void {
    this.killed = true;
    this.finish(143);
  }

  /** The program ended by itself (or was killed from outside). */
  exit(code = 0): void {
    this.finish(code);
  }
}

type Responder = (cmd: string[], opts: RunOptions) => RunResult | undefined | Promise<RunResult | undefined>;

/**
 * A process runner that starts nothing. Tests say what each command prints
 * and then read back which commands were asked for.
 */
export class FakeProcessRunner implements ProcessRunner {
  readonly runs: RunCall[] = [];
  readonly spawned: FakeRunning[] = [];
  private readonly responders: Responder[] = [];
  private nextPid = 40_000;

  /** The first responder that returns a result wins; responders are checked in the order they were added. */
  on(responder: Responder): this {
    this.responders.push(responder);
    return this;
  }

  /** Like `on`, but checked before everything added so far (a test overriding a default answer). */
  prepend(responder: Responder): this {
    this.responders.unshift(responder);
    return this;
  }

  /** Answer commands that start with these words. */
  answer(prefix: readonly string[], result: Partial<RunResult> | (() => Partial<RunResult>)): this {
    return this.on((cmd) => {
      if (prefix.length > cmd.length || !prefix.every((word, i) => cmd[i] === word)) return undefined;
      const r = typeof result === "function" ? result() : result;
      return { code: 0, stdout: "", stderr: "", ...r };
    });
  }

  async run(cmd: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
    const copy = [...cmd];
    this.runs.push({ cmd: copy, opts });
    for (const responder of this.responders) {
      const result = await responder(copy, opts);
      if (result) return result;
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  spawn(cmd: readonly string[], opts: RunOptions = {}): RunningProcess {
    const child = new FakeRunning([...cmd], opts, this.nextPid++);
    this.spawned.push(child);
    return child;
  }

  /** The commands run to completion, as text, in order. */
  get commands(): string[] {
    return this.runs.map((r) => r.cmd.join(" "));
  }
}
