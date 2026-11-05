import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { DEFAULT_COMMAND_TIMEOUT_MS, createProcessRunner, realProcessRunner } from "../src/process.ts";
import { FakeProcessRunner } from "./fakes/fake-process.ts";

// These tests run only the test runner's own executable with tiny inline scripts:
// no `claude`, `security` or `launchctl` ever runs here.
const bun = process.execPath;

describe("real process runner", () => {
  test("run returns the exit code and what was printed", async () => {
    const r = await realProcessRunner.run([bun, "-e", 'console.log("out"); console.error("err"); process.exit(3)']);
    expect(r.code).toBe(3);
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
  });

  test("run uses the folder and the extra environment it is given", async () => {
    const r = await realProcessRunner.run([bun, "-e", "console.log(process.cwd() + '|' + process.env.SK_TEST_FLAG)"], {
      cwd: tmpdir(),
      env: { SK_TEST_FLAG: "yes" },
    });
    expect(r.stdout.trim().endsWith("|yes")).toBe(true);
    expect(r.stdout.startsWith("/")).toBe(true);
  });

  test("run can feed text to the program's stdin", async () => {
    const r = await realProcessRunner.run([bun, "-e", "console.log((await Bun.stdin.text()).toUpperCase())"], {
      stdin: "fed in",
    });
    expect(r.stdout.trim()).toBe("FED IN");
  });

  test("a program that does not exist comes back as exit 127, not a throw", async () => {
    const r = await realProcessRunner.run(["/nonexistent/sk-test-program"]);
    expect(r.code).toBe(127);
    expect(r.stderr).not.toBe("");
  });

  test("a program that runs too long is stopped", async () => {
    const r = await realProcessRunner.run([bun, "-e", "await new Promise(() => {});"], { timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });

  test("a program that ignores the polite stop is killed hard, and the call still ends", async () => {
    const stubborn = 'process.on("SIGTERM", () => {}); console.log("started"); await new Promise(() => {});';
    const started = performance.now();
    const r = await realProcessRunner.run([bun, "-e", stubborn], { timeoutMs: 200, killGraceMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("a program with no timeout of its own gets the default one", async () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(20_000);
    const quick = createProcessRunner({ defaultTimeoutMs: 150 });
    const r = await quick.run([bun, "-e", "await new Promise(() => {});"]);
    expect(r.timedOut).toBe(true);
  });

  test("a timeout given for one call beats the default, and a quick program is never marked timed out", async () => {
    const quick = createProcessRunner({ defaultTimeoutMs: 50 });
    const r = await quick.run([bun, "-e", 'await Bun.sleep(150); console.log("late but fine")'], { timeoutMs: 5000 });
    expect(r.timedOut).toBeUndefined();
    expect(r.stdout.trim()).toBe("late but fine");
  });

  test("spawn starts a program that can be killed", async () => {
    const child = realProcessRunner.spawn([bun, "-e", "await new Promise(() => {});"]);
    expect(typeof child.pid).toBe("number");
    child.kill();
    expect(await child.exited).not.toBe(0);
  });

  test("spawn of a program that does not exist reports exit 127", async () => {
    const child = realProcessRunner.spawn(["/nonexistent/sk-test-program"]);
    expect(await child.exited).toBe(127);
  });
});

describe("fake process runner", () => {
  test("records commands and answers by prefix", async () => {
    const fake = new FakeProcessRunner().answer(["tool", "list"], { stdout: "[]" });
    expect((await fake.run(["tool", "list", "--json"])).stdout).toBe("[]");
    expect((await fake.run(["other"])).code).toBe(0);
    expect(fake.commands).toEqual(["tool list --json", "other"]);
  });

  test("spawned programs can be killed and told to exit", async () => {
    const fake = new FakeProcessRunner();
    const a = fake.spawn(["long", "runner"]);
    a.kill();
    expect(await a.exited).toBe(143);
    expect(fake.spawned[0]!.killed).toBe(true);
  });
});
