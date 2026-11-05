import { describe, expect, test } from "bun:test";
import { DISCORD_MAX_TEXT, splitMessage } from "../src/split.ts";

/** Lines that open or close a code fence. */
const fences = (piece: string) => piece.split("\n").filter((line) => /^\s*```/.test(line));

describe("splitMessage", () => {
  test("Discord's limit is 2,000 characters", () => {
    expect(DISCORD_MAX_TEXT).toBe(2000);
  });

  test("a 4,500-character text with paragraphs splits into 3 chunks at paragraph breaks", () => {
    const paragraphs = [0, 1, 2].map((n) => `P${n} ${"word ".repeat(299)}end.`); // 1,500 characters each
    const text = paragraphs.join("\n\n");
    expect(text.length).toBeGreaterThanOrEqual(4500);
    expect(splitMessage(text)).toEqual(paragraphs);
  });

  test("one 2,500-character line splits at a space", () => {
    const words = Array.from({ length: 500 }, (_, i) => `w${String(i).padStart(3, "0")}`).join(" "); // 2,499 characters
    const parts = splitMessage(words);
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(DISCORD_MAX_TEXT);
    expect(parts.join(" ")).toBe(words);
  });

  test("an emoji at the boundary is not cut in half", () => {
    for (const offset of [0, 1]) {
      const text = `${"a".repeat(offset)}${"😀".repeat(1500)}`;
      const parts = splitMessage(text);
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(DISCORD_MAX_TEXT);
        expect(part.isWellFormed()).toBe(true);
      }
      expect(parts.join("")).toBe(text);
    }
  });

  test("a 3,000-character code block comes back as two balanced fenced chunks", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `  const value${String(i).padStart(2, "0")} = compute(${i}); // ${"x".repeat(2)}`);
    const block = `\`\`\`ts\n${lines.join("\n")}\n\`\`\``;
    expect(block.length).toBeGreaterThan(3000);
    const parts = splitMessage(block);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(DISCORD_MAX_TEXT);
      expect(fences(part)).toHaveLength(2);
      expect(part.startsWith("```ts\n")).toBe(true);
      expect(part.endsWith("\n```")).toBe(true);
    }
    // Every code line arrives once, in order, with its indentation.
    const body = parts.flatMap((p) => p.split("\n").slice(1, -1));
    expect(body).toEqual(lines);
  });

  test("text around a long code block keeps every fence balanced", () => {
    const code = Array.from({ length: 150 }, (_, i) => `line ${i} ${"y".repeat(20)}`).join("\n");
    const text = `Here is the output:\n\n\`\`\`\n${code}\n\`\`\`\n\nThat is all.`;
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(DISCORD_MAX_TEXT);
      expect(fences(part).length % 2).toBe(0);
    }
    expect(parts[0]!.startsWith("Here is the output:")).toBe(true);
    expect(parts.at(-1)!.endsWith("That is all.")).toBe(true);
  });

  test("a short text stays whole; nothing or only blanks gives no chunks", () => {
    expect(splitMessage("done.")).toEqual(["done."]);
    expect(splitMessage("")).toEqual([]);
    expect(splitMessage("  \n \n")).toEqual([]);
  });

  test("a text of exactly the limit stays whole, one more character splits it", () => {
    expect(splitMessage("x".repeat(DISCORD_MAX_TEXT))).toHaveLength(1);
    expect(splitMessage("x".repeat(DISCORD_MAX_TEXT + 1))).toHaveLength(2);
  });

  test("a long text is cut at a line break, never mid line", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}: ${"y".repeat(80)}`);
    const parts = splitMessage(lines.join("\n"));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(DISCORD_MAX_TEXT);
    expect(parts.join("\n").split("\n")).toEqual(lines);
  });

  test("with no break at all it cuts at the limit", () => {
    const parts = splitMessage("z".repeat(5000));
    expect(parts.map((p) => p.length)).toEqual([2000, 2000, 1000]);
  });

  test("a smaller limit can be given", () => {
    expect(splitMessage("aaa\nbbb\nccc", 8)).toEqual(["aaa\nbbb", "ccc"]);
  });

  test("blank lines at a cut are not carried into the next chunk", () => {
    const parts = splitMessage(`${"a".repeat(DISCORD_MAX_TEXT - 100)}\n\n\n${"b".repeat(300)}`);
    expect(parts[1]).toBe("b".repeat(300));
  });
});
