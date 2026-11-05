import type { TimerHandle } from "./clock.ts";
import type { Daemon, DiscordMessage } from "./daemon.ts";
import type { DefaultAnswer, ListenerEvent, ParsedAnswer } from "./events.ts";
import type { Inbound } from "./inbound.ts";
import { RequestError } from "./server.ts";
import type { SessionEntry } from "./state.ts";

const MINUTE = 60_000;

export interface QuestionTiming {
  /** Asked at the keyboard first; posted on Discord when unanswered this long. */
  postAfterMs: number;
  remindAfterMs: number;
  /** No answer: take the defaults and work autonomously. */
  autonomousAfterMs: number;
  /** Check-ins after going autonomous, until `send --done`. */
  checkinEveryMs: number;
  /** A run that never says `--done` stops getting check-ins after this many. */
  maxCheckins: number;
}

export const QUESTION_TIMING: QuestionTiming = {
  postAfterMs: 2 * MINUTE,
  remindAfterMs: 30 * MINUTE,
  autonomousAfterMs: 60 * MINUTE,
  checkinEveryMs: 60 * MINUTE,
  maxCheckins: 24,
};

export const ANSWERED_AT_KEYBOARD = "Answered at the keyboard.";
export const AUTONOMOUS_POST = "No answer after an hour: took the defaults and working autonomously.";
export const REMINDER_POST = "Reminder: this session is still waiting for your answer to the question above.";
export const REPLY_HINT = "Reply like `1a 2b`, or in your own words.";

export interface AskOption {
  label: string;
  description: string;
}

/** One question from AskUserQuestion's `tool_input.questions`. */
export interface AskItem {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

/** A session's open question (or the last one), kept in `sessions.json`. */
export interface QuestionRecord {
  id: string;
  toolUseId: string | null;
  items: AskItem[];
  askedAt: number;
  status: "open" | "answered" | "defaulted";
  postedAt: number | null;
  remindedAt: number | null;
  closedAt: number | null;
  source: "discord" | "keyboard" | null;
  /** The Discord messages the question went out as, so a keyboard answer can edit them. */
  posts: { channelId: string; messageId: string }[];
  /** When the defaults were taken; check-ins count from here. */
  autonomousAt: number | null;
  checkins: number;
  checkinsDone: boolean;
  /** A reply came after the defaults were taken (only the first counts). */
  lateAnswered: boolean;
}

function letter(index: number): string {
  return String.fromCharCode(97 + index);
}

/** The post: numbered questions, lettered options with their descriptions, and how to reply. */
export function formatQuestions(items: readonly AskItem[]): string {
  const lines = ["This session is waiting for an answer:"];
  items.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.question}`);
    item.options.forEach((option, j) => {
      lines.push(`${letter(j)}) ${option.label}${option.description ? `: ${option.description}` : ""}`);
    });
  });
  lines.push(REPLY_HINT);
  return lines.join("\n");
}

/** Each question's default: the option whose label ends in "(Default)" or "(Recommended)", else the first. */
export function takeDefaults(items: readonly AskItem[]): DefaultAnswer[] {
  return items.map((item, i) => {
    const marked = item.options.find((o) => /\((default|recommended)\)\s*$/i.test(o.label));
    return { number: i + 1, question: item.question, answer: (marked ?? item.options[0])?.label ?? null };
  });
}

export interface ParsedReply {
  answers: ParsedAnswer[];
  raw: string;
  missing: number[];
}

/**
 * Read a reply such as `1a 2b` (or a bare letter when there is one question; `1ac` for a multi-select one).
 * Anything else (words, a number or letter that does not exist, a question answered twice) passes through
 * as `raw` with no answers, for the session to read.
 */
export function parseReply(text: string, items: readonly AskItem[]): ParsedReply {
  const raw: ParsedReply = { answers: [], raw: text, missing: [] };
  const trimmed = text.trim();
  const pairs: [number, string][] = [];
  if (items.length === 1 && /^[a-z]$/i.test(trimmed)) {
    pairs.push([1, trimmed.toLowerCase()]);
  } else if (/^(?:\d+\s*[a-z]+[\s,;]*)+$/i.test(trimmed)) {
    for (const m of trimmed.matchAll(/(\d+)\s*([a-z]+)/gi)) pairs.push([Number(m[1]), m[2]!.toLowerCase()]);
  } else {
    return raw;
  }
  const answers: ParsedAnswer[] = [];
  const seen = new Set<number>();
  for (const [number, letters] of pairs) {
    const item = items[number - 1];
    if (!item || seen.has(number)) return raw;
    if (letters.length > 1 && item.multiSelect !== true) return raw;
    seen.add(number);
    for (const l of letters) {
      const option = item.options[l.charCodeAt(0) - 97];
      if (!option) return raw;
      answers.push({ number, letter: l, option: option.label });
    }
  }
  return { answers, raw: text, missing: items.map((_, i) => i + 1).filter((n) => !seen.has(n)) };
}

/** Words in a tool result that mean the dialog closed without an answer (the auto-continue timeout). */
const UNANSWERED_WORDS =
  /away from (?:the|their|your) keyboard|did not (?:answer|respond)|didn't (?:answer|respond)|no answer|not answered|without an answer|timed out|auto-continue/i;

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).map(textOf).join("\n");
  return "";
}

/**
 * Did the user answer the dialog? PostToolUse also runs when `askUserQuestionTimeout` closes it unanswered,
 * so the result decides: an `answers` object with at least one non-empty answer (or a text result) counts as
 * answered, unless the result says the user may be away or did not answer.
 */
export function classifyAskResponse(response: unknown): "answered" | "unanswered" {
  if (response === null || response === undefined) return "unanswered";
  const words = textOf(response);
  if (UNANSWERED_WORDS.test(words)) return "unanswered";
  if (typeof response === "object" && !Array.isArray(response) && "answers" in (response as object)) {
    const answers = (response as { answers?: unknown }).answers;
    if (!answers || typeof answers !== "object") return "unanswered";
    const given = Object.values(answers as Record<string, unknown>).filter((v) => textOf(v).trim() !== "");
    return given.length > 0 ? "answered" : "unanswered";
  }
  return words.trim() === "" ? "unanswered" : "answered";
}

/** Read `tool_input.questions` (or a request's `questions`) into items. Null when it is not a question list. */
export function readAskItems(value: unknown): AskItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: AskItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const q = raw as Record<string, unknown>;
    if (typeof q.question !== "string" || !Array.isArray(q.options)) return null;
    const options: AskOption[] = [];
    for (const o of q.options) {
      if (!o || typeof o !== "object" || typeof (o as Record<string, unknown>).label !== "string") return null;
      const option = o as Record<string, unknown>;
      options.push({ label: option.label as string, description: typeof option.description === "string" ? option.description : "" });
    }
    items.push({
      question: q.question,
      options,
      ...(typeof q.header === "string" ? { header: q.header } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return items;
}

function describeAnswer(event: Extract<ListenerEvent, { type: "answer" }>): string {
  const chosen = event.answers.map((a) => `${a.number}) ${a.option}`).join(", ");
  return `answer to your open question${event.late ? " (after the defaults were taken)" : ""}: ${chosen || event.raw}`;
}

/**
 * Questions asked with AskUserQuestion, on Discord: recorded by the pre-ask hook; posted with a ping after
 * 2 minutes without a keyboard answer; a reminder at 30; the defaults and an `autonomous` event at 60; then
 * a check-in every hour until `send --done`. The first answer wins: a Discord reply becomes an `answer`
 * event, and a keyboard answer edits the post to say so. A reply after the defaults were taken is `late`.
 */
export class Questions {
  private readonly timers = new Map<string, TimerHandle[]>();
  private nextId = 1;

  constructor(
    private readonly daemon: Daemon,
    private readonly inbound: Inbound,
    private readonly timing: QuestionTiming = QUESTION_TIMING,
  ) {}

  install(): void {
    this.inbound.addInterceptor((session, text, message) => this.intercept(session, text, message));
    this.daemon.onSend((event) => {
      if (event.done) this.stopCheckins(event.sessionId);
    });
    // Steps skipped while Discord was off: the latest one that is due runs when it comes back on.
    this.daemon.onConfigChange((config, before) => {
      if (config.enabled && !before.enabled) this.resumeAll();
    });
    this.daemon.onPosted((event) => {
      if (event.tag === null || !event.tag.startsWith("question:")) return;
      const id = event.tag.slice("question:".length);
      const q = this.question(event.target);
      if (!q || q.id !== id) return;
      this.save(event.target, (r) => {
        r.posts.push({ channelId: event.channelId, messageId: event.messageId });
      });
      if (q.status !== "open" && q.source === "keyboard") void this.markAnswered([{ channelId: event.channelId, messageId: event.messageId }]);
    });
    this.daemon.handlers
      .add("ask", async (req) => {
        const sessionId = typeof req.sessionId === "string" ? req.sessionId : "";
        const items = readAskItems(req.questions);
        if (sessionId === "" || items === null) throw new RequestError("invalid", "The request needs a session id and questions.");
        if (!this.daemon.currentConfig().enabled) throw new RequestError("off", "Discord is off (/discord on to turn it on)");
        const entrypoint = typeof req.entrypoint === "string" ? req.entrypoint : null;
        const cwd = typeof req.cwd === "string" ? req.cwd : null;
        if (!(await this.daemon.adopt(sessionId, entrypoint, cwd))) return { opened: false };
        const toolUseId = typeof req.toolUseId === "string" ? req.toolUseId : null;
        return { opened: true, id: this.open(sessionId, toolUseId, items) };
      })
      .add("answer", (req) => {
        const sessionId = typeof req.sessionId === "string" ? req.sessionId : "";
        const toolUseId = typeof req.toolUseId === "string" ? req.toolUseId : null;
        return { closed: this.answeredAtKeyboard(sessionId, toolUseId) };
      });
    this.resumeAll();
  }

  private question(sessionId: string): QuestionRecord | null {
    return (this.daemon.sessions.get(sessionId)?.question as QuestionRecord | null | undefined) ?? null;
  }

  private save(sessionId: string, mutate: (q: QuestionRecord) => void): void {
    this.daemon.sessions.update(sessionId, (e) => {
      if (e.question) mutate(e.question as unknown as QuestionRecord);
    });
  }

  private clearTimers(sessionId: string): void {
    for (const t of this.timers.get(sessionId) ?? []) this.daemon.deps.clock.clearTimeout(t);
    this.timers.delete(sessionId);
  }

  private at(sessionId: string, delay: number, fn: () => void): void {
    const handle = this.daemon.deps.clock.setTimeout(() => {
      this.timers.set(sessionId, (this.timers.get(sessionId) ?? []).filter((t) => t !== handle));
      fn();
    }, Math.max(0, delay));
    this.timers.set(sessionId, [...(this.timers.get(sessionId) ?? []), handle]);
  }

  /** Record a new question for the session (replacing any open one) and start its timers. */
  open(sessionId: string, toolUseId: string | null, items: AskItem[]): string {
    const now = this.daemon.deps.clock.now();
    const id = `q${now.toString(36)}${this.nextId++}`;
    const record: QuestionRecord = {
      id,
      toolUseId,
      items,
      askedAt: now,
      status: "open",
      postedAt: null,
      remindedAt: null,
      closedAt: null,
      source: null,
      posts: [],
      autonomousAt: null,
      checkins: 0,
      checkinsDone: false,
      lateAnswered: false,
    };
    this.daemon.sessions.update(sessionId, (e) => {
      e.question = record as unknown as Record<string, unknown>;
    });
    this.arm(sessionId);
    return id;
  }

  /** Start the timers again for every session's question (at start, after a restart). */
  resumeAll(): void {
    for (const entry of this.daemon.sessions.all()) if (entry.question) this.arm(entry.sessionId);
  }

  /**
   * Set the timers for the session's question from its record. After a long gap (the helper was down) only
   * the latest overdue step runs.
   */
  private arm(sessionId: string): void {
    this.clearTimers(sessionId);
    const q = this.question(sessionId);
    if (!q) return;
    const now = this.daemon.deps.clock.now();
    if (q.status === "open") {
      const t = this.timing;
      const steps = [
        { run: () => this.postQuestion(sessionId), due: q.askedAt + t.postAfterMs, done: q.postedAt !== null },
        { run: () => this.remind(sessionId), due: q.askedAt + t.remindAfterMs, done: q.remindedAt !== null },
        { run: () => this.goAutonomous(sessionId), due: q.askedAt + t.autonomousAfterMs, done: false },
      ].filter((s) => !s.done);
      const overdue = steps.filter((s) => s.due <= now);
      const last = overdue.at(-1);
      if (last) this.at(sessionId, 0, last.run);
      for (const step of steps.filter((s) => s.due > now)) this.at(sessionId, step.due - now, step.run);
      return;
    }
    if (q.status === "defaulted") this.armCheckin(sessionId);
  }

  private armCheckin(sessionId: string): void {
    const q = this.question(sessionId);
    if (!q || q.autonomousAt === null || q.checkinsDone) return;
    const next = q.checkins + 1;
    const due = q.autonomousAt + next * this.timing.checkinEveryMs;
    this.at(sessionId, due - this.daemon.deps.clock.now(), () => this.checkin(sessionId, next));
  }

  /** The session's question while it is open and Discord is on (with Discord off, its steps are skipped). */
  private stillOpen(sessionId: string): QuestionRecord | null {
    if (!this.daemon.currentConfig().enabled) return null;
    const q = this.question(sessionId);
    return q && q.status === "open" ? q : null;
  }

  private postQuestion(sessionId: string): void {
    const q = this.stillOpen(sessionId);
    if (!q) return;
    this.save(sessionId, (r) => {
      r.postedAt = this.daemon.deps.clock.now();
    });
    this.daemon.post(sessionId, formatQuestions(q.items), { ping: true, tag: `question:${q.id}` });
  }

  private remind(sessionId: string): void {
    const q = this.stillOpen(sessionId);
    if (!q) return;
    if (q.postedAt === null) this.postQuestion(sessionId);
    this.save(sessionId, (r) => {
      r.remindedAt = this.daemon.deps.clock.now();
    });
    this.daemon.post(sessionId, REMINDER_POST, { ping: true });
    void this.inbound.route(sessionId, { type: "reminder", id: q.id }, {});
  }

  private goAutonomous(sessionId: string): void {
    const q = this.stillOpen(sessionId);
    if (!q) return;
    const now = this.daemon.deps.clock.now();
    const defaults = takeDefaults(q.items);
    this.save(sessionId, (r) => {
      r.status = "defaulted";
      r.closedAt = now;
      r.autonomousAt = now;
      r.checkins = 0;
      r.checkinsDone = false;
    });
    const lines = defaults.map((d) => `${d.number}. ${d.question} ${d.answer ?? "(no default: its own call)"}`);
    this.daemon.post(sessionId, [AUTONOMOUS_POST, ...lines].join("\n"));
    void this.inbound.route(sessionId, { type: "autonomous", id: q.id, defaults }, {});
    this.armCheckin(sessionId);
  }

  private checkin(sessionId: string, count: number): void {
    const entry = this.daemon.sessions.get(sessionId);
    const q = this.question(sessionId);
    if (!entry || !q || q.status !== "defaulted" || q.checkinsDone || q.autonomousAt === null) return;
    if (!this.daemon.currentConfig().enabled) {
      this.armCheckin(sessionId);
      return;
    }
    if (entry.doneAt !== null && entry.doneAt >= q.autonomousAt) {
      this.stopCheckins(sessionId);
      return;
    }
    const last = count >= this.timing.maxCheckins;
    this.save(sessionId, (r) => {
      r.checkins = count;
      if (last) r.checkinsDone = true;
    });
    const tail = last ? " This is the last check-in until the session posts again." : " Reply here to steer it.";
    this.daemon.post(sessionId, `Check-in ${count}: still working autonomously.${tail}`);
    void this.inbound.route(sessionId, { type: "checkin", count }, {});
    if (!last) this.armCheckin(sessionId);
  }

  /** `send --done`: the run is finished, so the check-ins stop. */
  private stopCheckins(sessionId: string): void {
    const q = this.question(sessionId);
    if (!q || q.status !== "defaulted" || q.checkinsDone) return;
    this.clearTimers(sessionId);
    this.save(sessionId, (r) => {
      r.checkinsDone = true;
    });
  }

  /** PostToolUse with an answer: the keyboard answered first. Edits the post if it went out. */
  answeredAtKeyboard(sessionId: string, toolUseId: string | null): boolean {
    const q = this.stillOpen(sessionId);
    if (!q || (toolUseId !== null && q.toolUseId !== null && toolUseId !== q.toolUseId)) return false;
    this.clearTimers(sessionId);
    this.save(sessionId, (r) => {
      r.status = "answered";
      r.closedAt = this.daemon.deps.clock.now();
      r.source = "keyboard";
    });
    if (q.posts.length > 0) void this.markAnswered(q.posts);
    return true;
  }

  private async markAnswered(posts: { channelId: string; messageId: string }[]): Promise<void> {
    for (const post of posts) {
      try {
        await this.daemon.rest.request("PATCH", `/channels/${post.channelId}/messages/${post.messageId}`, {
          body: { content: ANSWERED_AT_KEYBOARD, allowed_mentions: { parse: [] } },
        });
      } catch (error) {
        this.daemon.deps.log.warn(`could not mark a question post as answered: ${(error as Error).message}`);
      }
    }
  }

  /** A message in a session's channel: an answer to its posted question, or a late one after the defaults. */
  private async intercept(session: SessionEntry, text: string, _message: DiscordMessage): Promise<boolean> {
    const q = this.question(session.sessionId);
    if (!q) return false;
    const open = q.status === "open" && q.postedAt !== null;
    const late = q.status === "defaulted" && !q.lateAnswered;
    if (!open && !late) return false;
    const parsed = parseReply(text, q.items);
    const event: Extract<ListenerEvent, { type: "answer" }> = {
      type: "answer",
      id: q.id,
      answers: parsed.answers,
      raw: parsed.raw,
      missing: parsed.missing,
      ...(late ? { late: true as const } : {}),
    };
    if (open) {
      this.clearTimers(session.sessionId);
      this.save(session.sessionId, (r) => {
        r.status = "answered";
        r.closedAt = this.daemon.deps.clock.now();
        r.source = "discord";
      });
    } else {
      this.save(session.sessionId, (r) => {
        r.lateAnswered = true;
      });
    }
    const result = await this.inbound.route(session.sessionId, event, { wakeText: describeAnswer(event), secret: text });
    this.inbound.replyFor(session, result);
    return true;
  }
}
