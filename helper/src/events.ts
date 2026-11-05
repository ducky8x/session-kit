/** One answer read from a `1a 2b` reply: question number, option letter and that option's label. */
export interface ParsedAnswer {
  number: number;
  letter: string;
  option: string;
}

/** What a question gets when nobody answers: its default option's label, or null when it has none. */
export interface DefaultAnswer {
  number: number;
  question: string;
  answer: string | null;
}

/**
 * What `sk-discord listen` prints, one JSON line per event. Events that waited in the inbox carry
 * `queued: true`.
 */
export type ListenerEvent =
  | { type: "text"; id: string; text: string; at: number; queued?: true }
  | { type: "stop"; queued?: true }
  | { type: "pause"; queued?: true }
  | { type: "resume"; queued?: true }
  | {
      type: "answer";
      id: string;
      answers: ParsedAnswer[];
      raw: string;
      missing: number[];
      late?: true;
      queued?: true;
    }
  | { type: "reminder"; id: string; queued?: true }
  | { type: "autonomous"; id: string; defaults: DefaultAnswer[]; queued?: true }
  | { type: "checkin"; count: number; queued?: true }
  | { type: "disabled" }
  | { type: "unlinked" }
  | { type: "replaced" };

/** Events that end a listener without a reason to start it again. */
export const FINAL_EVENTS: ReadonlySet<string> = new Set(["disabled", "unlinked", "replaced"]);
