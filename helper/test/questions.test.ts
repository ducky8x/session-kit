import { describe, expect, test } from "bun:test";
import { sessionFeatures } from "../src/features.ts";
import {
  ANSWERED_AT_KEYBOARD,
  AUTONOMOUS_POST,
  type AskItem,
  classifyAskResponse,
  formatQuestions,
  parseReply,
  takeDefaults,
} from "../src/questions.ts";
import { OWNER_ID } from "./fakes/fake-rest.ts";
import { inboundKit } from "./helpers/inbound-kit.ts";
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

function preAsk(sessionId: string, toolUseId = "toolu_01") {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: toolUseId,
    tool_input: { questions: QUESTIONS },
  });
}

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

describe("telling a keyboard answer from a dialog that closed unanswered", () => {
  test("answers in the response mean answered", () => {
    expect(classifyAskResponse(ANSWERED)).toBe("answered");
    expect(classifyAskResponse({ answers: { "Add a cache?": "Yes, Later" } })).toBe("answered");
    expect(classifyAskResponse('User has answered your questions: "Add a cache?"="Yes". You can now continue.')).toBe("answered");
  });

  test("the auto-continue timeout's shapes mean unanswered", () => {
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
    const timedOut = { questions: QUESTIONS, answers: {}, message: "The user may be away from their keyboard." };
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

  test("pre-ask and post-ask print nothing and exit 0 with Discord off or the helper down", async () => {
    const { daemonKit } = await import("./helpers/daemon-kit.ts");
    const off = await daemonKit({ enabled: false });
    expect(await off.cli(["hook", "pre-ask"], { stdin: preAsk("x") })).toEqual({ code: 0, out: "", err: "" });
    const down = await daemonKit({ noStart: true });
    const r = await down.cli(["hook", "post-ask"], { stdin: postAsk("x", ANSWERED) });
    expect(r.out).toBe("");
  });
});
