import { describe, expect, test } from "bun:test";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, SECURITY_TOOL, SecurityKeychain, isPlausibleToken } from "../src/secrets.ts";
import { FakeProcessRunner } from "./fakes/fake-process.ts";

const TOKEN = "FAKE00000000000000000000.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";

describe("SecurityKeychain", () => {
  test("reads the token with the security tool", async () => {
    const runner = new FakeProcessRunner().answer([SECURITY_TOOL, "find-generic-password"], { stdout: `${TOKEN}\n` });
    expect(await new SecurityKeychain(runner).getToken()).toBe(TOKEN);
    expect(runner.runs[0]!.cmd).toEqual([
      "/usr/bin/security",
      "find-generic-password",
      "-s",
      "session-kit-discord",
      "-a",
      "bot-token",
      "-w",
    ]);
    expect(KEYCHAIN_SERVICE).toBe("session-kit-discord");
    expect(KEYCHAIN_ACCOUNT).toBe("bot-token");
  });

  test("a missing item reads as no token", async () => {
    const runner = new FakeProcessRunner().answer([SECURITY_TOOL], { code: 44, stderr: "could not be found" });
    expect(await new SecurityKeychain(runner).getToken()).toBeNull();
  });

  test("other failures throw without the token in the message", async () => {
    const runner = new FakeProcessRunner().answer([SECURITY_TOOL], { code: 51, stderr: "user interaction is not allowed" });
    await expect(new SecurityKeychain(runner).getToken()).rejects.toThrow("exit 51");
    const slow = new FakeProcessRunner().answer([SECURITY_TOOL], { code: 143, timedOut: true });
    await expect(new SecurityKeychain(slow).getToken()).rejects.toThrow("timed out");
  });

  test("stores the token through stdin, never on the command line", async () => {
    const runner = new FakeProcessRunner();
    await new SecurityKeychain(runner).setToken(TOKEN);
    const run = runner.runs[0]!;
    expect(run.cmd).toEqual(["/usr/bin/security", "-i"]);
    expect(run.cmd.join(" ")).not.toContain(TOKEN);
    expect(run.opts.stdin).toBe(`add-generic-password -U -s session-kit-discord -a bot-token -w "${TOKEN}"\n`);
  });

  test("refuses to store something that is not a bot token", async () => {
    const runner = new FakeProcessRunner();
    await expect(new SecurityKeychain(runner).setToken('abc" ; delete-keychain')).rejects.toThrow("does not look like");
    expect(runner.runs).toHaveLength(0);
  });

  test("a failed store throws", async () => {
    const runner = new FakeProcessRunner().answer([SECURITY_TOOL], { code: 1, stderr: "returned 1" });
    await expect(new SecurityKeychain(runner).setToken(TOKEN)).rejects.toThrow("exit 1");
  });

  test("isPlausibleToken accepts three dot-separated base64url parts", () => {
    expect(isPlausibleToken(TOKEN)).toBe(true);
    expect(isPlausibleToken(` ${TOKEN}`)).toBe(false);
    expect(isPlausibleToken("abc.def")).toBe(false);
    expect(isPlausibleToken("")).toBe(false);
  });
});
