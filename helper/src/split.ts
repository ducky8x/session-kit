/** Discord's limit for one message. Lengths here are UTF-16 code units, which never undercount. */
export const DISCORD_MAX_TEXT = 2000;

const CLOSE_FENCE = "\n```";
const FENCE_LINE = /^\s*```/;

/** Where to cut `text` so the first piece has at most `max` characters: paragraph, line, space, else hard. */
function findCut(text: string, max: number): number {
  const window = text.slice(0, max + 1); // one past the limit: a break right at the limit still counts
  const floor = max * 0.3; // a break too near the start would leave a tiny piece
  let cut = window.lastIndexOf("\n\n");
  if (cut < floor) cut = window.lastIndexOf("\n");
  if (cut < floor) cut = window.lastIndexOf(" ");
  if (cut < floor) {
    cut = max;
    // Never leave the first half of a surrogate pair (an emoji) at the end of a piece.
    const last = text.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut--;
  }
  return cut;
}

/** The fence line (such as "```ts") a piece ends inside, or null when every fence in it is closed. */
function openFence(piece: string): string | null {
  let open: string | null = null;
  for (const line of piece.split("\n")) {
    if (FENCE_LINE.test(line)) open = open === null ? line.trim() : null;
  }
  return open;
}

/**
 * Split a post into pieces of at most `max` characters, in order: at the last paragraph break that fits,
 * else the last line break, else the last space, else at the limit (never inside a surrogate pair). A piece
 * that ends inside a ``` fence gets a closing fence, and the next piece opens it again with the same line.
 * Blank edges are dropped, so no piece is empty. A text that fits is one piece.
 */
export function splitMessage(text: string, max = DISCORD_MAX_TEXT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  let reopen: string | null = null;
  for (;;) {
    const body: string = reopen === null ? rest : `${reopen}\n${rest}`;
    if (body.length <= max) {
      if (body.trim() !== "") parts.push(body);
      return parts;
    }
    let cut = findCut(body, max);
    let fence = openFence(body.slice(0, cut).trimEnd());
    if (fence !== null) {
      // Leave room for the closing fence.
      cut = findCut(body, max - CLOSE_FENCE.length);
      fence = openFence(body.slice(0, cut).trimEnd());
    }
    let piece = body.slice(0, cut).trimEnd();
    let next = body.slice(cut);
    if (fence !== null) {
      piece += CLOSE_FENCE;
      // Inside code only the break itself goes: indentation on the next line stays.
      next = next.replace(/^(\n+| )/, "");
    } else {
      next = next.trimStart();
    }
    if (piece.trim() !== "") parts.push(piece);
    rest = next;
    reopen = fence;
  }
}
