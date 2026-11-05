import { describe, expect, test } from "bun:test";
import { readSecret } from "../src/tty.ts";
import { FakeTerminal } from "./fakes/fake-terminal.ts";

const TOKEN = "FAKE00000000000000000000.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";
const PROMPT = "Paste the bot token (it stays hidden), then press Return: ";

const ENTER = "\r";
const BACKSPACE = "\u007f";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";

/** Start reading from a fake terminal. */
function start() {
  const term = new FakeTerminal();
  const value = readSecret(PROMPT, term.streams);
  return { term, value };
}

/** The terminal is back the way it was: raw mode off, stdin paused, nothing listening, and nothing echoed. */
function expectRestored(term: FakeTerminal) {
  expect(term.rawModes).toEqual([true, false]);
  expect(term.paused).toBe(true);
  expect(term.listening).toBe(false);
  expect(term.stderrText).toBe(`${PROMPT}\n`);
}

describe("readSecret at a terminal", () => {
  test("typing then Return gives what was typed, with raw mode on while it reads and nothing echoed", async () => {
    const { term, value } = start();
    expect(term.rawModes).toEqual([true]);
    expect(term.encoding).toBe("utf8");
    expect(term.paused).toBe(false);
    term.type("a", "b", "c", ENTER);
    expect(await value).toBe("abc");
    expectRestored(term);
  });

  test("a newline ends the input like Return", async () => {
    const { term, value } = start();
    term.type(`${TOKEN}\n`);
    expect(await value).toBe(TOKEN);
  });

  test("Backspace (DEL or BS) removes the last character", async () => {
    const { term, value } = start();
    term.type("abX", BACKSPACE, "cdY", "\b", ENTER);
    expect(await value).toBe("abcd");
  });

  test("Backspace on empty input does nothing", async () => {
    const { term, value } = start();
    term.type(BACKSPACE, BACKSPACE, "a", ENTER);
    expect(await value).toBe("a");
  });

  test("Ctrl-C cancels and restores the terminal", async () => {
    const { term, value } = start();
    term.type(TOKEN.slice(0, 10), CTRL_C);
    await expect(value).rejects.toThrow("Canceled.");
    expectRestored(term);
  });

  test("Ctrl-D cancels too", async () => {
    const { term, value } = start();
    term.type(`ab${CTRL_D}`);
    await expect(value).rejects.toThrow("Canceled.");
    expectRestored(term);
  });

  test("what comes after Return in the same chunk is dropped", async () => {
    const { term, value } = start();
    term.type(`${TOKEN}${ENTER}extra`);
    expect(await value).toBe(TOKEN);
    expectRestored(term);
  });
});

describe("readSecret from a pipe", () => {
  test("reads all of stdin without a prompt or raw mode", async () => {
    const term = new FakeTerminal({ isTTY: false, piped: `${TOKEN}\n` });
    expect(await readSecret(PROMPT, term.streams)).toBe(`${TOKEN}\n`);
    expect(term.rawModes).toEqual([]);
    expect(term.stderrText).toBe("");
  });
});
