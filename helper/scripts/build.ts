/**
 * Builds sk-discord for both Mac architectures into build/ and signs each binary ad hoc.
 * Run from the helper folder: `bun run build`.
 */
export const IDENTIFIER = "io.github.ducky8x.session-kit.discord";

const TARGETS = [
  ["bun-darwin-arm64", "sk-discord-darwin-arm64"],
  ["bun-darwin-x64", "sk-discord-darwin-x64"],
] as const;

export function buildCommands(outDir = "build"): string[][] {
  return TARGETS.flatMap(([target, name]) => {
    const out = `${outDir}/${name}`;
    return [
      ["bun", "build", "--compile", `--target=${target}`, "src/main.ts", "--outfile", out],
      ["codesign", "--force", "--sign", "-", "--identifier", IDENTIFIER, out],
    ];
  });
}

if (import.meta.main) {
  for (const cmd of buildCommands()) {
    const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) {
      process.stderr.write(`build failed: ${cmd.join(" ")}\n`);
      process.exit(result.exitCode ?? 1);
    }
  }
}
