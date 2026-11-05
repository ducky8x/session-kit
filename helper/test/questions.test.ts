import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { sessionFeatures } from "../src/features.ts";
import {
  ANSWERED_AT_KEYBOARD,
  AUTONOMOUS_POST,
  type AskItem,
  classifyAskResponse,
  dismissedInTranscript,
  formatQuestions,
  parseReply,
  takeDefaults,
  typedByUser,
} from "../src/questions.ts";
import { wakePrompt } from "../src/wake.ts";
import { OWNER_ID } from "./fakes/fake-rest.ts";
import { inboundKit } from "./helpers/inbound-kit.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { waitFor } from "./helpers/wait.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const QUESTIONS = [
  {
    question: "Which database should the service use?",
    header: "Database",
    options: [
      { label: "SQLite", description: "One file, no server" },
      { label: "Postgres (Recommended)", description: "What production runs" },
    ],
    multiSelect: false,
  },
  {
    question: "Add a cache?",
    header: "Cache",
    options: [
      { label: "No (Default)", description: "Keep it simple" },
      { label: "Yes", description: "Redis in front" },
      { label: "Later" },
    ],
    multiSelect: false,
  },
];

function preAsk(sessionId: string, toolUseId = "toolu_01", transcriptPath?: string) {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: toolUseId,
    tool_input: { questions: QUESTIONS },
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
  });
}

/** Transcript lines: the call, then (when given) its result. Made up, in the shape Claude Code writes. */
function transcriptLines(result?: { is_error?: boolean; content: unknown; toolUseResult?: unknown }, toolUseId = "toolu_01"): string {
  const call = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions: QUESTIONS } }] } };
  const lines = [JSON.stringify({ type: "user", message: { role: "user", content: "pick a database" } }), JSON.stringify(call)];
  if (result) {
    const block = { type: "tool_result", tool_use_id: toolUseId, content: result.content, ...(result.is_error ? { is_error: true } : {}) };
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [block] }, toolUseResult: result.toolUseResult ?? result.content }));
  }
  return `${lines.join("\n")}\n`;
}

/** The result of a call the user rejected in its dialog opens with this sentence; the rest is made up. */
const REJECTED = "The user doesn't want to proceed with this tool use. Wait for the user.";
const CLARIFY = "The user doesn't want to proceed with this tool use. The user said:\nThey want to clarify the questions.";

function postAsk(sessionId: string, toolResponse: unknown, toolUseId = "toolu_01") {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: toolUseId,
    tool_input: { questions: QUESTIONS },
    tool_response: toolResponse,
  });
}

function prompt(sessionId: string, text: string) {
  return JSON.stringify({ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: text });
}

const ANSWERED = {
  questions: QUESTIONS,
  answers: { "Which database should the service use?": "SQLite", "Add a cache?": "No (Default)" },
};

async function asked() {
  const k = await inboundKit();
  k.claude.addInteractive(k.sessionId);
  const r = await k.cli(["hook", "pre-ask"], { stdin: preAsk(k.sessionId) });
  expect(r).toEqual({ code: 0, out: "", err: "" });
  return k;
}

describe("parsing replies", () => {
  const items: AskItem[] = QUESTIONS.map((q) => ({ ...q, options: q.options.map((o) => ({ label: o.label, description: o.description ?? "" })) }));

  test("1a 2b becomes answers, with nothing missing", () => {
    expect(parseReply("1a 2b", items)).toEqual({
      answers: [
        { number: 1, letter: "a", option: "SQLite" },
        { number: 2, letter: "b", option: "Yes" },
      ],
      raw: "1a 2b",
      missing: [],
    });
  });

  test("a partial answer lists the rest as missing; case and commas don't matter", () => {
    expect(parseReply("2C", items)).toEqual({ answers: [{ number: 2, letter: "c", option: "Later" }], raw: "2C", missing: [1] });
    expect(parseReply("1b, 2a", items).answers.map((a: { option: string }) => a.option)).toEqual(["Postgres (Recommended)", "No (Default)"]);
  });

  test("anything else goes through as raw", () => {
    for (const text of ["the second one", "1z", "3a", "1a 1b", "go with postgres"]) {
      expect(parseReply(text, items)).toEqual({ answers: [], raw: text, missing: [] });
    }
  });

  test("with one question a bare letter is enough", () => {
    expect(parseReply("b", items.slice(0, 1)).answers).toEqual([{ number: 1, letter: "b", option: "Postgres (Recommended)" }]);
  });

  test("defaults: the option marked (Default) or (Recommended), else the first", () => {
    expect(takeDefaults(items)).toEqual([
      { number: 1, question: "Which database should the service use?", answer: "Postgres (Recommended)" },
      { number: 2, question: "Add a cache?", answer: "No (Default)" },
    ]);
    const plain: AskItem[] = [{ question: "Pick", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }];
    expect(takeDefaults(plain)).toEqual([{ number: 1, question: "Pick", answer: "A" }]);
  });

  test("the post is numbered, with lettered options and the reply hint", () => {
    expect(formatQuestions(items)).toBe(
      [
        "This session is waiting for an answer:",
        "1. Which database should the service use?",
        "a) SQLite: One file, no server",
        "b) Postgres (Recommended): What production runs",
        "2. Add a cache?",
        "a) No (Default): Keep it simple",
        "b) Yes: Redis in front",
        "c) Later",
        "Reply like `1a 2b`, or in your own words.",
      ].join("\n"),
    );
  });
});

describe("reading from the transcript whether the user closed the dialog", () => {
  const write = (text: string) => {
    const file = `${tmpDir()}/t.jsonl`;
    writeFileSync(file, text);
    return file;
  };

  test("a rejected call, with or without a reply such as clarify, is closed by the user", async () => {
    expect(await dismissedInTranscript(write(transcriptLines({ is_error: true, content: REJECTED })), "toolu_01")).toBe(true);
    const blocks = [{ type: "text", text: CLARIFY }];
    expect(await dismissedInTranscript(write(transcriptLines({ is_error: true, content: blocks })), "toolu_01")).toBe(true);
  });

  test("an open dialog, an answer, the idle timeout, another call or a rule's denial is not", async () => {
    const timedOut = { questions: QUESTIONS, answers: {}, annotations: {}, afkTimeoutMs: 60_000 };
    for (const text of [
      transcriptLines(),
      transcriptLines({ content: "Your questions have been answered.", toolUseResult: ANSWERED }),
      transcriptLines({ content: "No response after 60s.", toolUseResult: timedOut }),
      transcriptLines({ is_error: true, content: REJECTED }, "toolu_other"),
      transcriptLines({ is_error: true, content: "Permission for this tool use was denied." }),
      transcriptLines({ content: REJECTED }),
    ]) {
      expect(await dismissedInTranscript(write(text), "toolu_01")).toBe(false);
    }
    expect(await dismissedInTranscript(`${tmpDir()}/missing.jsonl`, "toolu_01")).toBe(false);
    expect(await dismissedInTranscript(write("{ torn\n"), "toolu_01")).toBe(false);
  });
});

describe("telling a prompt the user typed from one Claude Code or the helper sent", () => {
  test("typed text and slash commands are the user's", () => {
    for (const text of ["use Postgres", "  /discord status", "1a 2b", "what is <div> for?"]) expect(typedByUser(text)).toBe(true);
  });

  test("tagged prompts, the wake prompt and empty text are not", () => {
    for (const text of [
      "<task-notification>\n<task-id>b1</task-id>\n</task-notification>",
      '<cross-session-message from="worker">hi</cross-session-message>',
      "<system-reminder>x</system-reminder>",
      wakePrompt("run the tests"),
      "",
      "   ",
    ]) {
      expect(typedByUser(text)).toBe(false);
    }
  });
});

describe("telling a keyboard answer from a dialog that closed unanswered", () => {
  test("answers in the response mean answered", () => {
    expect(classifyAskResponse(ANSWERED)).toBe("answered");
    expect(classifyAskResponse({ answers: { "Add a cache?": "Yes, Later" } })).toBe("answered");
    expect(classifyAskResponse('User has answered your questions: "Add a cache?"="Yes". You can now continue.')).toBe("answered");
  });

  test("the terminal's answered shape, with its empty annotations, and a multi-select list mean answered", () => {
    expect(classifyAskResponse({ ...ANSWERED, annotations: {} })).toBe("answered");
    expect(classifyAskResponse({ questions: QUESTIONS, answers: { "Add a cache?": ["Yes", "Later"] } })).toBe("answered");
  });

  test("the idle timeout is unanswered, even when options were picked before the user went idle", () => {
    expect(classifyAskResponse({ questions: QUESTIONS, answers: {}, annotations: {}, afkTimeoutMs: 60_000 })).toBe("unanswered");
    expect(
      classifyAskResponse({ questions: QUESTIONS, answers: { "Add a cache?": "Yes" }, annotations: {}, afkTimeoutMs: 300_000 }),
    ).toBe("unanswered");
    expect(classifyAskResponse("No response after 60s: the user may be away from keyboard. Proceed on your own judgment.")).toBe(
      "unanswered",
    );
  });

  test("a typed reply, a request for follow-up questions, or notes alone mean the user is at the keyboard", () => {
    expect(classifyAskResponse({ questions: QUESTIONS, answers: {}, response: "Use whatever is cheapest" })).toBe("answered");
    expect(classifyAskResponse({ questions: QUESTIONS, answers: {}, followUp: true })).toBe("answered");
    expect(
      classifyAskResponse({ questions: QUESTIONS, answers: {}, annotations: { "Add a cache?": { notes: "Only if it is cheap" } } }),
    ).toBe("answered");
  });

  test("the words of the questions, the options and the user's own reply never decide it", () => {
    const question = {
      question: "What should happen when the job timed out?",
      header: "Timeout",
      options: [{ label: "Retry", description: "No answer from the server yet" }],
      multiSelect: false,
    };
    expect(classifyAskResponse({ questions: [question], answers: { [question.question]: "Retry" } })).toBe("answered");
    expect(classifyAskResponse({ questions: QUESTIONS, answers: {}, response: "No answer from me, you pick" })).toBe("answered");
    expect(
      classifyAskResponse('User has answered your questions: "Did the job time out?"="No answer yet". You can now continue.'),
    ).toBe("answered");
  });

  test("results with no answer, or that say the user did not answer, mean unanswered", () => {
    expect(classifyAskResponse({ questions: QUESTIONS, answers: {} })).toBe("unanswered");
    expect(classifyAskResponse({ questions: QUESTIONS, answers: { "Add a cache?": "" } })).toBe("unanswered");
    expect(
      classifyAskResponse({
        questions: QUESTIONS,
        answers: { "Add a cache?": "Yes" },
        message: "The user did not answer in time and may be away from their keyboard.",
      }),
    ).toBe("unanswered");
    expect(classifyAskResponse("No answer: the user may be away from the keyboard. Proceed on your own judgment.")).toBe("unanswered");
    expect(classifyAskResponse([{ type: "text", text: "The question timed out without an answer." }])).toBe("unanswered");
    expect(classifyAskResponse(null)).toBe("unanswered");
  });
});

describe("question timing", () => {
  test("posted with a ping at 2:00, not at 1:59", async () => {
    const k = await asked();
    await k.clock.advance(2 * MINUTE - 1000);
    await k.settle();
    expect(k.replies()).toEqual([]);
    await k.clock.advance(1000);
    await k.settle();
    const posted = k.rest.posted(k.channelId());
    expect(posted).toHaveLength(1);
    expect(posted[0]!.content.startsWith(`<@${OWNER_ID}> This session is waiting for an answer:`)).toBe(true);
    expect(posted[0]!.allowed_mentions).toEqual({ parse: [], users: [OWNER_ID] });
  });

  test("a session whose chat has no channel yet gets one for its question at 2:00", async () => {
    const k = await inboundKit();
    const id = "eeee5555-0000-4000-8000-000000000005";
    await k.register(id);
    k.claude.addInteractive(id);
    expect((await k.cli(["hook", "pre-ask"], { stdin: preAsk(id) })).code).toBe(0);
    await k.clock.advance(2 * MINUTE);
    await k.settle();
    const channelId = k.daemon.sessions.get(id)!.channelId;
    expect(channelId).not.toBeNull();
    const posted = k.rest.posted(channelId!);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.content.startsWith(`<@${OWNER_ID}> This session is waiting for an answer:`)).toBe(true);
  });

  test("a keyboard answer at 1:30 posts nothing, ever", async () => {
    const k = await asked();
    await k.clock.advance(90_000);
    expect((await k.cli(["hook", "post-ask"], { stdin: postAsk(k.sessionId, ANSWERED) })).code).toBe(0);
    await k.clock.advance(2 * HOUR);
    await k.settle();
    expect(k.replies()).toEqual([]);
  });

  test("a dialog that closed unanswered keeps the question open: it still goes to Discord at 2:00", async () => {
    const k = await asked();
    await k.clock.advance(MINUTE);
    // The idle timeout's result: what was picked before the user went idle, and how long Claude Code waited.
    const timedOut = { questions: QUESTIONS, answers: { "Add a cache?": "Yes" }, annotations: {}, afkTimeoutMs: 60_000 };
    expect((await k.cli(["hook", "post-ask"], { stdin: postAsk(k.sessionId, timedOut) })).code).toBe(0);
    await k.clock.advance(MINUTE);
    await k.settle();
    expect(k.replies()).toHaveLength(1);
  });

  test("a Discord answer goes to the session as an answer event; a later keyboard result changes nothing", async () => {
    const k = await asked();
    await k.clock.advance(2 * MINUTE);
    await k.settle();
    const listener = k.listen();
    await k.attached();
    await k.say("1a 2b");
    expect(await listener).toEqual({
      type: "answer",
      id: expect.any(String),
      answers: [
        { number: 1, letter: "a", option: "SQLite" },
        { number: 2, letter: "b", option: "Yes" },
      ],
      raw: "1a 2b",
      missing: [],
    });
    expect((await k.cli(["hook", "post-ask"], { stdin: postAsk(k.sessionId, ANSWERED) })).code).toBe(0);
    await k.settle();
    expect(k.rest.posted(k.channelId()).filter((m) => m.edited)).toHaveLength(0);
    // The question is closed: the reminder never comes.
    await k.clock.advance(HOUR);
    await k.settle();
    expect(k.replies()).toHaveLength(1);
  });

  test("words that are not 1a 2b go through as raw", async () => {
    const k = await asked();
    await k.clock.advance(2 * MINUTE);
    await k.settle();
    const listener = k.listen();
    await k.attached();
    await k.say("the second one");
    expect(await listener).toMatchObject({ type: "answer", answers: [], raw: "the second one", missing: [] });
  });

  test("a keyboard answer after the post edits it to say so", async () => {
    const k = await asked();
    await k.clock.advance(2 * MINUTE);
    await k.settle();
    expect((await k.cli(["hook", "post-ask"], { stdin: postAsk(k.sessionId, ANSWERED) })).code).toBe(0);
    await k.settle();
    await waitFor(() => k.rest.posted(k.channelId())[0]!.edited);
    expect(k.rest.posted(k.channelId())[0]!.content).toBe(ANSWERED_AT_KEYBOARD);
    expect(ANSWERED_AT_KEYBOARD).toBe("Answered at the keyboard.");
    // A Discord reply after that is ordinary text.
    const listener = k.listen();
    await k.attached();
    await k.say("1b");
    expect(await listener).toMatchObject({ type: "text", text: "1b" });
  });

  test("a prompt typed at 1:00 (the dialog was dismissed) settles the question: nothing goes to Discord", async () => {
    const k = await asked();
    await k.clock.advance(MINUTE);
    expect(await k.cli(["hook", "prompt"], { stdin: prompt(k.sessionId, "never mind, use SQLite") })).toEqual({ code: 0, out: "", err: "" });
    await k.clock.advance(2 * HOUR);
    await k.settle();
    expect(k.replies()).toEqual([]);
    expect(k.daemon.sessions.get(k.sessionId)!.question).toMatchObject({ status: "answered", source: "keyboard" });
  });

  test("a prompt typed after the post marks it answered, and no reminder or autonomous step follows", async () => {
    const k = await asked();
    await k.clock.advance(5 * MINUTE);
    await k.settle();
    expect(k.replies()).toHaveLength(1);
    expect((await k.cli(["hook", "prompt"], { stdin: prompt(k.sessionId, "I'm back") })).code).toBe(0);
    await waitFor(() => k.rest.posted(k.channelId())[0]!.edited);
    expect(k.rest.posted(k.channelId())[0]!.content).toBe(ANSWERED_AT_KEYBOARD);
    await k.clock.advance(2 * HOUR);
    await k.settle();
    expect(k.replies()).toHaveLength(1);
  });

  test("a dialog closed with Esc, with no prompt after it, is settled at 2:00 instead of posted", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId);
    const transcript = `${tmpDir()}/t.jsonl`;
    writeFileSync(transcript, transcriptLines());
    expect((await k.cli(["hook", "pre-ask"], { stdin: preAsk(k.sessionId, "toolu_01", transcript) })).code).toBe(0);
    await k.clock.advance(MINUTE);
    writeFileSync(transcript, transcriptLines({ is_error: true, content: REJECTED }));
    await k.clock.advance(MINUTE);
    await waitFor(() => k.daemon.sessions.get(k.sessionId)!.question?.status === "answered");
    await k.clock.advance(2 * HOUR);
    await k.settle();
    expect(k.replies()).toEqual([]);
  });

  test("a dialog still open, or closed by the idle timeout, goes out at 2:00; a later Esc stops the reminder", async () => {
    const k = await inboundKit();
    k.claude.addInteractive(k.sessionId);
    const transcript = `${tmpDir()}/t.jsonl`;
    writeFileSync(transcript, transcriptLines());
    expect((await k.cli(["hook", "pre-ask"], { stdin: preAsk(k.sessionId, "toolu_01", transcript) })).code).toBe(0);
    await k.clock.advance(2 * MINUTE);
    await waitFor(() => k.replies().length === 1);
    // The user comes back at 10:00 and closes the dialog with Esc: no reminder at 30:00, no defaults at 60:00.
    await k.clock.advance(8 * MINUTE);
    writeFileSync(transcript, transcriptLines({ is_error: true, content: REJECTED }));
    await k.clock.advance(20 * MINUTE);
    await waitFor(() => k.daemon.sessions.get(k.sessionId)!.question?.status === "answered");
    await waitFor(() => k.rest.posted(k.channelId())[0]!.edited);
    expect(k.rest.posted(k.channelId())[0]!.content).toBe(ANSWERED_AT_KEYBOARD);
    await k.clock.advance(2 * HOUR);
    await k.settle();
    expect(k.replies()).toHaveLength(1);

    const t = await inboundKit();
    t.claude.addInteractive(t.sessionId);
    const timedOut = `${tmpDir()}/t.jsonl`;
    writeFileSync(timedOut, transcriptLines({ content: "No response after 60s.", toolUseResult: { questions: QUESTIONS, answers: {}, afkTimeoutMs: 60_000 } }));
    expect((await t.cli(["hook", "pre-ask"], { stdin: preAsk(t.sessionId, "toolu_01", timedOut) })).code).toBe(0);
    await t.clock.advance(2 * MINUTE);
    await waitFor(() => t.replies().length === 1);
  });

  test("the wake prompt, task notifications and messages from other sessions don't count as the user", async () => {
    const k = await asked();
    await k.clock.advance(MINUTE);
    for (const text of [
      wakePrompt("1a 2b"),
      "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>",
      '<cross-session-message from="worker">done</cross-session-message>',
    ]) {
      expect((await k.cli(["hook", "prompt"], { stdin: prompt(k.sessionId, text) })).code).toBe(0);
    }
    await k.clock.advance(MINUTE);
    await k.settle();
    expect(k.replies()).toHaveLength(1);
  });

  test("reminder at 30:00, autonomous at 60:00 with the defaults, check-ins at 2:00:00 and 3:00:00", async () => {
    const k = await asked();
    const events: unknown[] = [];
    const keepListening = async () => {
      for (;;) {
        const event = await k.listen().catch(() => null);
        if (event === null) return;
        events.push(event);
      }
    };
    void keepListening();
    await k.attached();

    await k.clock.advance(30 * MINUTE - 1000);
    await k.settle();
    expect(k.replies()).toHaveLength(1);
    await k.clock.advance(1000);
    await k.settle();
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ type: "reminder", id: expect.any(String) });
    expect(k.replies()).toHaveLength(2);
    expect(k.rest.posted(k.channelId())[1]!.content.startsWith(`<@${OWNER_ID}> Reminder:`)).toBe(true);

    await k.attached();
    await k.clock.advance(30 * MINUTE);
    await k.settle();
    await waitFor(() => events.length === 2);
    expect(events[1]).toEqual({
      type: "autonomous",
      id: expect.any(String),
      defaults: [
        { number: 1, question: "Which database should the service use?", answer: "Postgres (Recommended)" },
        { number: 2, question: "Add a cache?", answer: "No (Default)" },
      ],
    });
    expect(k.replies()[2]!.startsWith(AUTONOMOUS_POST)).toBe(true);
    expect(AUTONOMOUS_POST).toBe("No answer after an hour: took the defaults and working autonomously.");

    for (const hour of [2, 3]) {
      await k.attached();
      await k.clock.advance(HOUR - 1000);
      await k.settle();
      expect(events).toHaveLength(hour);
      await k.clock.advance(1000);
      await k.settle();
      await waitFor(() => events.length === hour + 1);
      expect(events[hour]).toEqual({ type: "checkin", count: hour - 1 });
    }
    expect(k.replies().filter((r) => r.startsWith("Check-in"))).toHaveLength(2);
  });

  test("send --done stops the check-ins", async () => {
    const k = await asked();
    await k.clock.advance(HOUR);
    await k.settle();
    await k.clock.advance(HOUR);
    await k.settle();
    expect(k.replies().filter((r) => r.startsWith("Check-in"))).toHaveLength(1);
    expect((await k.cli_send("Finished: all done.")).code).toBe(0);
    await k.cli(["send", "--session", k.sessionId, "--done", "Finished."]);
    await k.clock.advance(5 * HOUR);
    await k.settle();
    expect(k.replies().filter((r) => r.startsWith("Check-in"))).toHaveLength(1);
  });

  test("a reply after the hour arrives as a late answer", async () => {
    const k = await asked();
    await k.clock.advance(HOUR);
    await k.settle();
    const listener = k.listen();
    // The queued reminder and autonomous events come first.
    expect(await listener).toMatchObject({ type: "reminder", queued: true });
    expect(await k.listen()).toMatchObject({ type: "autonomous", queued: true });
    const next = k.listen();
    await k.attached();
    await k.say("1a");
    expect(await next).toMatchObject({ type: "answer", answers: [{ number: 1, letter: "a", option: "SQLite" }], missing: [2], late: true });
  });

  test("with Discord turned off, an open question is not posted", async () => {
    const k = await asked();
    k.setConfig((c) => {
      c.enabled = false;
    });
    await k.call({ op: "reload" });
    await k.clock.advance(2 * HOUR);
    await k.settle();
    expect(k.rest.posted(k.channelId())).toHaveLength(0);
    expect(k.daemon.outbox.size).toBe(0);
    // Turned on again: the latest step that is due runs once (the hour has passed, so the defaults).
    expect((await k.cli(["on"])).code).toBe(0);
    await k.connected();
    await k.clock.advance(0);
    await k.settle();
    const posts = k.rest.posted(k.channelId()).map((m) => m.content);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.startsWith(AUTONOMOUS_POST)).toBe(true);
  });

  test("open questions survive a restart: overdue steps run once, the rest keep their times", async () => {
    const k = await asked();
    const question = k.daemon.sessions.get(k.sessionId)!.question!;
    expect(question).toMatchObject({ status: "open", askedAt: k.clock.now() });
    // A fresh features install on the same daemon state, as after a restart, 5 minutes in.
    await k.clock.advance(5 * MINUTE);
    await k.settle();
    expect(k.replies()).toHaveLength(1);
    sessionFeatures(k.daemon).questions.resumeAll();
    await k.settle();
    expect(k.replies()).toHaveLength(1);
  });

  test("pre-ask, post-ask and prompt print nothing and exit 0 with Discord off or the helper down", async () => {
    const { daemonKit } = await import("./helpers/daemon-kit.ts");
    const off = await daemonKit({ enabled: false });
    expect(await off.cli(["hook", "prompt"], { stdin: prompt("x", "hello") })).toEqual({ code: 0, out: "", err: "" });
    const down = await daemonKit({ noStart: true });
    expect((await down.cli(["hook", "prompt"], { stdin: prompt("x", "hello") })).out).toBe("");
  });

  test("pre-ask and post-ask print nothing and exit 0 with Discord off or the helper down", async () => {
    const { daemonKit } = await import("./helpers/daemon-kit.ts");
    const off = await daemonKit({ enabled: false });
    expect(await off.cli(["hook", "pre-ask"], { stdin: preAsk("x") })).toEqual({ code: 0, out: "", err: "" });
    const down = await daemonKit({ noStart: true });
    const r = await down.cli(["hook", "post-ask"], { stdin: postAsk("x", ANSWERED) });
    expect(r.out).toBe("");
  });
});
