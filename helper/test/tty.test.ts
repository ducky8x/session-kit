import { describe, expect, test } from "bun:test";
import { readSecret } from "../src/tty.ts";
import { FakeTerminal } from "./fakes/fake-terminal.ts";

const TOKEN = "FAKE00000000000000000000.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";
const PROMPT = "Paste the bot token (it stays hidden), then press Return: ";

const ENTER = "\r";
const BACKSPACE = "\u007f";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const ESC = "\u001b";
/** What a terminal in bracketed-paste mode sends around pasted text. */
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

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

describe("readSecret with pastes and escape sequences", () => {
  test("a bracketed paste then Return in one chunk gives just the pasted text", async () => {
    const { term, value } = start();
    term.type(`${PASTE_START}${TOKEN}${PASTE_END}${ENTER}`);
    expect(await value).toBe(TOKEN);
    expectRestored(term);
  });

  test("a bracketed paste then Return gives just the pasted text wherever the chunks split", async () => {
    const input = `${PASTE_START}${TOKEN}${PASTE_END}${ENTER}`;
    for (let at = 1; at < input.length; at++) {
      const { term, value } = start();
      term.type(input.slice(0, at), input.slice(at));
      expect({ at, value: await value }).toEqual({ at, value: TOKEN });
    }
    const { term, value } = start();
    term.type(...input);
    expect(await value).toBe(TOKEN);
  });

  test("a paste whose text ends in a newline, before the end marker, gives just the token", async () => {
    for (const newline of ["\r", "\n", "\r\n"]) {
      const one = start();
      one.term.type(`${PASTE_START}${TOKEN}${newline}${PASTE_END}`);
      expect(await one.value).toBe(TOKEN);
      expectRestored(one.term);
      const split = start();
      split.term.type(`${PASTE_START}${TOKEN}${newline}`, PASTE_END);
      expect(await split.value).toBe(TOKEN);
      expectRestored(split.term);
    }
  });

  test("arrow keys and other CSI sequences are dropped", async () => {
    const { term, value } = start();
    // left, right, Ctrl-Up, Delete, focus in and out, an SGR mouse click
    term.type("ab", `${ESC}[D`, `${ESC}[C`, `${ESC}[1;5A`, `${ESC}[3~`, `${ESC}[I`, `${ESC}[O`, "cd", `${ESC}[<0;10;5M`, ENTER);
    expect(await value).toBe("abcd");
  });

  test("arrow keys in application mode (ESC O A) are dropped", async () => {
    const { term, value } = start();
    term.type("ab", `${ESC}OA`, `${ESC}OD`, "cd", ENTER);
    expect(await value).toBe("abcd");
  });

  test("a lone ESC (the Escape key) is dropped and what comes next is kept", async () => {
    const one = start();
    one.term.type(ESC, TOKEN, ENTER);
    expect(await one.value).toBe(TOKEN);
    const twice = start();
    twice.term.type("ab", ESC, ESC, "cd", ENTER);
    expect(await twice.value).toBe("abcd");
    const thenPaste = start();
    thenPaste.term.type(ESC, `${PASTE_START}${TOKEN}${PASTE_END}`, ENTER);
    expect(await thenPaste.value).toBe(TOKEN);
  });

  test("ESC then Return in one chunk ends the input", async () => {
    const { term, value } = start();
    term.type(`ab${ESC}${ENTER}`);
    expect(await value).toBe("ab");
    expectRestored(term);
  });

  test("ESC and the character after it in one chunk (Alt plus a key) are dropped together", async () => {
    const { term, value } = start();
    term.type("ab", `${ESC}x`, "cd", ENTER);
    expect(await value).toBe("abcd");
  });

  test("Return and Ctrl-C still work in the middle of an escape sequence", async () => {
    const enter = start();
    enter.term.type(`ab${ESC}[1${ENTER}`);
    expect(await enter.value).toBe("ab");
    expectRestored(enter.term);
    const cancel = start();
    cancel.term.type(`ab${ESC}[12`, CTRL_C);
    await expect(cancel.value).rejects.toThrow("Canceled.");
    expectRestored(cancel.term);
  });

  test("other control characters and invisible characters are dropped", async () => {
    const { term, value } = start();
    // tab, NUL, Ctrl-U, zero-width space, byte order mark, a C1 control
    term.type("a\tb\u0000c\u0015d​e﻿f\u009bg", ENTER);
    expect(await value).toBe("abcdefg");
  });

  test("other printable characters are kept, and Backspace removes a whole emoji", async () => {
    const { term, value } = start();
    term.type("é😀ü😀", BACKSPACE, ENTER);
    expect(await value).toBe("é😀ü");
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
