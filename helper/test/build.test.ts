import { describe, expect, test } from "bun:test";
import { IDENTIFIER, buildCommands } from "../scripts/build.ts";

describe("build script", () => {
  test("builds both Mac targets into build/ and signs each ad hoc with the LaunchAgent identifier", () => {
    expect(IDENTIFIER).toBe("io.github.ducky8x.session-kit.discord");
    expect(buildCommands()).toEqual([
      ["bun", "build", "--compile", "--target=bun-darwin-arm64", "src/main.ts", "--outfile", "build/sk-discord-darwin-arm64"],
      ["codesign", "--force", "--sign", "-", "--identifier", IDENTIFIER, "build/sk-discord-darwin-arm64"],
      ["bun", "build", "--compile", "--target=bun-darwin-x64", "src/main.ts", "--outfile", "build/sk-discord-darwin-x64"],
      ["codesign", "--force", "--sign", "-", "--identifier", IDENTIFIER, "build/sk-discord-darwin-x64"],
    ]);
  });
});
