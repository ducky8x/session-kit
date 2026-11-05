import type { Clock } from "./clock.ts";
import type { ListenerEvent } from "./events.ts";

/** Hands an event to a waiting `listen` connection. False when that connection is already gone. */
type Deliver = (event: ListenerEvent) => boolean;

/** A listener that returned an event this recently is taken to be starting again, not gone. */
export const BETWEEN_LISTENS_MS = 120_000;

/**
 * The `listen` connections that are waiting, at most one per session. Each gets exactly one event and then
 * ends; the session starts it again. A second `listen` for the same session replaces the first, which gets
 * `replaced`.
 */
export class ListenerHub {
  private readonly waiting = new Map<string, Deliver>();
  /** When each session's listener last attached or took an event. */
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  /** A `listen` connection is waiting. Returns a function that removes it (when its client leaves). */
  attach(sessionId: string, deliver: Deliver): () => void {
    const older = this.waiting.get(sessionId);
    this.waiting.set(sessionId, deliver);
    this.lastSeen.set(sessionId, this.clock.now());
    older?.({ type: "replaced" });
    return () => {
      if (this.waiting.get(sessionId) === deliver) this.waiting.delete(sessionId);
    };
  }

  isListening(sessionId: string): boolean {
    return this.waiting.has(sessionId);
  }

  /** A listener took an event within the last two minutes, so a new one is probably about to start. */
  recentlyListened(sessionId: string): boolean {
    const at = this.lastSeen.get(sessionId);
    return at !== undefined && this.clock.now() - at < BETWEEN_LISTENS_MS;
  }

  /** Give the session's listener this event. False when no listener is waiting (or it just left). */
  offer(sessionId: string, event: ListenerEvent): boolean {
    const deliver = this.waiting.get(sessionId);
    if (!deliver) return false;
    this.waiting.delete(sessionId);
    if (!deliver(event)) return false;
    this.lastSeen.set(sessionId, this.clock.now());
    return true;
  }

  /** Discord was turned off: every listener gets `disabled`. */
  disableAll(): void {
    for (const sessionId of [...this.waiting.keys()]) this.offer(sessionId, { type: "disabled" });
  }

  /** Every session with a listener waiting. */
  listening(): string[] {
    return [...this.waiting.keys()];
  }
}

/** One waiting event as a line in the Stop hook's message. Events with nothing to act on give null. */
export function describeQueued(event: { type: string; [field: string]: unknown }): string | null {
  switch (event.type) {
    case "text":
      return String(event.text ?? "");
    case "stop":
    case "pause":
    case "resume":
      return `(the user typed "${event.type}")`;
    case "answer": {
      const answers = Array.isArray(event.answers) ? (event.answers as { number: number; option: string }[]) : [];
      const chosen = answers.map((a) => `${a.number}) ${a.option}`).join(", ");
      return `(answer to your open question${event.late ? ", after the defaults were taken" : ""}) ${chosen || String(event.raw ?? "")}`;
    }
    case "autonomous": {
      const defaults = Array.isArray(event.defaults) ? (event.defaults as { number: number; answer: string | null }[]) : [];
      const taken = defaults.map((d) => `${d.number}) ${d.answer ?? "your own call"}`).join(", ");
      return `(no answer to your open question for an hour: defaults taken, work autonomously) ${taken}`;
    }
    default:
      return null;
  }
}

/** The Stop hook's message for the events that waited, or null when none of them needs acting on. */
export function stopHookReason(events: readonly { type: string; [field: string]: unknown }[]): string | null {
  const lines = events.map(describeQueued).filter((line): line is string => line !== null && line.trim() !== "");
  if (lines.length === 0) return null;
  return [
    "Discord message(s) for this session:",
    ...lines.map((line, i) => `${i + 1}. ${line}`),
    "Reply in the channel with sk-discord send, then start the Discord listener (session-kit:discord skill).",
  ].join("\n");
}
