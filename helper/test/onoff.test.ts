import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionFeatures } from "../src/features.ts";
import { writeUpdateFailure } from "../src/update.ts";
import { GUILD_ID } from "./fakes/fake-rest.ts";
import { SID, daemonKit } from "./helpers/daemon-kit.ts";
import { waitFor } from "./helpers/wait.ts";

async function statusOf(k: Awaited<ReturnType<typeof daemonKit>>) {
  return (await k.call({ op: "status" })).status;
}

describe("on and off with the helper running", () => {
  test("off disconnects: register is refused as off, send exits 3, listeners get disabled", async () => {
    const k = await daemonKit();
    await k.connected();
    await k.register(SID);
    const listener = k.call({ op: "listen", sessionId: SID });
    await waitFor(() => sessionFeatures(k.daemon).hub.isListening(SID));
    const r = await k.cli(["off"]);
    expect(r.code).toBe(0);
    expect((await listener).event).toEqual({ type: "disabled" });
    expect(await statusOf(k)).toBe("off");
    await waitFor(() => k.gateway.latest!.closed);
    await expect(k.register(SID)).rejects.toMatchObject({ code: "off" });
    expect((await k.cli(["send", "--session", SID, "hello"])).code).toBe(3);
  });

  test("on reconnects", async () => {
    const k = await daemonKit({ enabled: false });
    expect(await statusOf(k)).toBe("off");
    expect((await k.cli(["on"])).code).toBe(0);
    await k.connected();
    expect(await statusOf(k)).toBe("connected");
    expect(k.gateway.connections).toHaveLength(1);
  });
});

describe("status codes", () => {
  test("connected, off, no-token, token-rejected, intent-missing, not-in-server and no-server", async () => {
    const connected = await daemonKit();
    await connected.connected();
    expect(await statusOf(connected)).toBe("connected");

    expect(await statusOf(await daemonKit({ enabled: false }))).toBe("off");
    expect(await statusOf(await daemonKit({ token: null }))).toBe("no-token");

    const rejected = await daemonKit({ noStart: true });
    rejected.gateway.closeOnIdentify = 4004;
    await rejected.daemon.start();
    await waitFor(() => rejected.daemon.statusCode() === "token-rejected");

    const intents = await daemonKit({ noStart: true });
    intents.gateway.closeOnIdentify = 4014;
    await intents.daemon.start();
    await waitFor(() => intents.daemon.statusCode() === "intent-missing");

    const gone = await daemonKit();
    await gone.connected();
    gone.gateway.dispatch("GUILD_DELETE", { id: GUILD_ID });
    await waitFor(async () => (await statusOf(gone)) === "not-in-server");

    expect(await statusOf(await daemonKit({ noGuild: true }))).toBe("no-server");
  });

  test("a failed update is update-failed, with /discord update as the fix", async () => {
    const k = await daemonKit();
    await k.connected();
    writeUpdateFailure(k.paths, { version: "9.9.9", reason: "checksum mismatch", at: k.clock.now() });
    expect(await k.call({ op: "status" })).toMatchObject({ status: "update-failed", fix: "/discord update" });
  });

  test("with the helper down, status still names what is missing: not-installed, no-token, off, no-server", async () => {
    const k = await daemonKit({ noStart: true });
    const bin = k.paths.bin;
    let r = await k.cli(["status"]);
    expect(r.out.split("\n")[0]).toBe("not-installed");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n");
    k.keychain.token = null;
    r = await k.cli(["status"]);
    expect(r.out.split("\n")[0]).toBe("no-token");
    k.keychain.token = "FAKE00000000000000000000.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";
    k.setConfig((c) => {
      c.enabled = false;
    });
    r = await k.cli(["status"]);
    expect(r.out.split("\n")[0]).toBe("off");
    k.setConfig((c) => {
      c.enabled = true;
      c.guildId = null;
    });
    r = await k.cli(["status"]);
    expect(r.out.split("\n")[0]).toBe("no-server");
    k.setConfig((c) => {
      c.guildId = GUILD_ID;
    });
    r = await k.cli(["status"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("launchctl kickstart");
  });
});
