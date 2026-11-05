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

/**
 * Read a secret without showing it: from the terminal with echo off, or, when stdin is not a terminal (a
 * pipe), all of stdin.
 */
export async function readSecret(prompt: string, streams: SecretStreams = realStreams()): Promise<string> {
  const { stdin, stderr } = streams;
  if (!stdin.isTTY) return streams.readAll();
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const done = (action: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      action();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value));
        if (ch === "\u0003" || ch === "\u0004") return done(() => reject(new Error("Canceled.")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
