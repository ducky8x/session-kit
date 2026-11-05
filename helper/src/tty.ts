/**
 * Read a secret without showing it: from the terminal with echo off, or, when stdin is not a terminal (a
 * pipe), all of stdin.
 */
export async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Bun.stdin.text();
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const done = (action: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
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
