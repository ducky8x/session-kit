import { describe, expect, test } from "bun:test";
import { OWNER_ID } from "./fakes/fake-rest.ts";
import { SID, daemonKit } from "./helpers/daemon-kit.ts";
import { waitFor } from "./helpers/wait.ts";

function hookInput(type: string, message = "Claude needs your permission to use Bash") {
  return JSON.stringify({ session_id: SID, cwd: "/work/session-kit", hook_event_name: "Notification", message, notification_type: type });
}

describe("hook notification", () => {
  test("permission_prompt and elicitation_dialog post with a ping", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    const channelId = k.daemon.sessions.get(SID)!.channelId!;
    for (const [type, message] of [
      ["permission_prompt", "Claude needs your permission to use Bash"],
      ["elicitation_dialog", "Claude is asking for input"],
    ] as const) {
      const r = await k.cli(["hook", "notification"], { stdin: hookInput(type, message) });
      expect(r).toEqual({ code: 0, out: "", err: "" });
    }
    await waitFor(() => k.rest.posted(channelId).length === 2);
    expect(k.rest.posted(channelId).map((m) => [m.content, m.allowed_mentions])).toEqual([
      [`<@${OWNER_ID}> Claude needs your permission to use Bash`, { parse: [], users: [OWNER_ID] }],
      [`<@${OWNER_ID}> Claude is asking for input`, { parse: [], users: [OWNER_ID] }],
    ]);
  });

  test("idle_prompt and auth_success post nothing", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    for (const type of ["idle_prompt", "auth_success"]) {
      const r = await k.cli(["hook", "notification"], { stdin: hookInput(type, "Claude is waiting for your input") });
      expect(r).toEqual({ code: 0, out: "", err: "" });
    }
    await k.daemon.settle();
    expect(k.rest.posted()).toHaveLength(0);
    expect(k.daemon.outbox.size).toBe(0);
  });

  test("with Discord off it posts nothing and exits 0", async () => {
    const k = await daemonKit({ enabled: false });
    const r = await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt") });
    expect(r).toEqual({ code: 0, out: "", err: "" });
    expect(k.daemon.outbox.size).toBe(0);
  });

  test("with the helper down it prints nothing", async () => {
    const k = await daemonKit({ noStart: true });
    const r = await k.cli(["hook", "notification"], { stdin: hookInput("permission_prompt") });
    expect(r.out).toBe("");
    expect(r.err).toBe("");
  });
});
