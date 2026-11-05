/** The parts of the terminal's input stream that `readSecret` uses. */
export interface SecretInput {
  readonly isTTY?: boolean;
  setRawMode(on: boolean): unknown;
  setEncoding(encoding: "utf8"): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
}

/** Where `readSecret` reads and writes. Tests pass fakes; the default is the real stdin and stderr. */
export interface SecretStreams {
  stdin: SecretInput;
  stderr: { write(text: string): unknown };
  /** All of stdin, for when it is a pipe. */
  readAll(): Promise<string>;
}

function realStreams(): SecretStreams {
  return { stdin: process.stdin, stderr: process.stderr, readAll: () => Bun.stdin.text() };
}

const ESC = "\u001b";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const DEL = "\u007f";
/** Control characters and invisible formatting ones (zero-width space, byte order mark). Never kept. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

type End = "enter" | "cancel";

/**
 * Turns what the terminal sends into the characters the user typed or pasted. Return or a newline ends the
 * input, Ctrl-C or Ctrl-D cancels it, and Backspace removes the last character. Escape sequences are dropped
 * whole: the markers a terminal in bracketed-paste mode puts around a paste (ESC [200~ and ESC [201~), arrow
 * keys, focus and mouse reports. So are other control characters and invisible ones.
 *
 * A sequence can be split across chunks. An ESC that ends a chunk is taken as the Escape key unless the next
 * chunk carries on with `[` or `O`, so a paste that follows the Escape key keeps its first character.
 */
class KeyReader {
  private readonly chars: string[] = [];
  /** text: plain input. esc: just saw ESC. csi: inside ESC [ ... up to its final byte. ss3: after ESC O. */
  private mode: "text" | "esc" | "csi" | "ss3" = "text";

  get value(): string {
    return this.chars.join("");
  }

  /** Read one chunk. Says how the input ended, or null when it goes on. */
  feed(chunk: string): End | null {
    if (this.mode === "esc" && chunk.length > 0 && chunk[0] !== "[" && chunk[0] !== "O") this.mode = "text";
    for (const ch of chunk) {
      const end = this.key(ch);
      if (end !== null) return end;
    }
    return null;
  }

  private key(ch: string): End | null {
    const code = ch.codePointAt(0)!;
    const ascii = code >= 0x20 && code <= 0x7e;
    switch (this.mode) {
      case "esc":
        if (ch === "[") this.mode = "csi";
        else if (ch === "O") this.mode = "ss3";
        else if (ch !== ESC) {
          this.mode = "text";
          // ESC plus one character (Alt plus a key) is dropped whole. Anything else after ESC, such as Return,
          // is read as a key.
          if (!ascii) return this.key(ch);
        }
        return null;
      case "csi":
        // Parameter and intermediate bytes run on and a final byte ends the sequence. Anything else cuts it
        // short and is read as a key, so Return and Ctrl-C work even mid-sequence.
        if (code >= 0x20 && code <= 0x3f) return null;
        this.mode = "text";
        return code >= 0x40 && code <= 0x7e ? null : this.key(ch);
      case "ss3":
        this.mode = "text";
        return ascii ? null : this.key(ch);
      case "text":
        if (ch === "\r" || ch === "\n") return "enter";
        if (ch === CTRL_C || ch === CTRL_D) return "cancel";
        if (ch === DEL || ch === "\b") this.chars.pop();
        else if (ch === ESC) this.mode = "esc";
        else if (!UNPRINTABLE.test(ch)) this.chars.push(ch);
        return null;
    }
  }
}

/**
 * Read a secret without showing it: from the terminal with echo off, or, when stdin is not a terminal (a
 * pipe), all of stdin. At the terminal only the characters the user typed or pasted are kept (see `KeyReader`).
 */
export async function readSecret(prompt: string, streams: SecretStreams = realStreams()): Promise<string> {
  const { stdin, stderr } = streams;
  if (!stdin.isTTY) return streams.readAll();
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    const keys = new KeyReader();
    const onData = (chunk: string) => {
      const end = keys.feed(chunk);
      if (end === null) return;
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (end === "enter") resolve(keys.value);
      else reject(new Error("Canceled."));
    };
    stdin.on("data", onData);
  });
}
