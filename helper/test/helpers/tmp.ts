import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";

const made: string[] = [];

/**
 * A fresh temp folder, removed after each test. A Unix socket path can be at most 103 bytes on macOS, and the
 * helper's socket sits four folders down, so the folder name is short and a long system temp path is skipped.
 */
export function tmpDir(prefix = "h"): string {
  const base = tmpdir().length > 60 ? "/tmp" : tmpdir();
  const dir = mkdtempSync(join(base, prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});
