import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { HelperError, NOT_RUNNING, TIMEOUT, callHelper } from "../src/client.ts";
import { memoryLogger } from "../src/log.ts";
import { pathsFor } from "../src/paths.ts";
import { AlreadyRunning, ControlServer, HandlerRegistry, RequestError } from "../src/server.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { waitFor } from "./helpers/wait.ts";

const servers: ControlServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(registry: HandlerRegistry, socketPath = pathsFor(tmpDir()).socket) {
  const server = new ControlServer(socketPath, registry, memoryLogger());
  await server.listen();
  servers.push(server);
  return { server, socketPath };
}

describe("control socket", () => {
  test("one request in, one reply out, through the registry", async () => {
    const registry = new HandlerRegistry().add("echo", (req) => ({ said: req.text }));
    const { socketPath } = await serve(registry);
    expect(await callHelper(socketPath, { op: "echo", text: "hi" })).toEqual({ ok: true, said: "hi" });
    expect(registry.ops()).toEqual(["echo"]);
  });

  test("the socket is user-only", async () => {
    const { socketPath } = await serve(new HandlerRegistry());
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  test("errors come back as ok false with a code and a message", async () => {
    const registry = new HandlerRegistry()
      .add("refuse", () => {
        throw new RequestError("off", "Discord is off");
      })
      .add("crash", () => {
        throw new Error("secret internals");
      });
    const { socketPath } = await serve(registry);
    await expect(callHelper(socketPath, { op: "refuse" })).rejects.toMatchObject({ code: "off", message: "Discord is off" });
    await expect(callHelper(socketPath, { op: "nope" })).rejects.toMatchObject({ code: "unknown-op" });
    const crash = await callHelper(socketPath, { op: "crash" }).catch((e) => e);
    expect(crash).toMatchObject({ code: "internal" });
    expect(crash.message).not.toContain("secret internals");
  });

  test("a line that is not a JSON request gets an invalid reply", async () => {
    const { socketPath } = await serve(new HandlerRegistry());
    const reply = await new Promise<string>((resolve) => {
      let text = "";
      void Bun.connect({
        unix: socketPath,
        socket: {
          open: (s) => void s.write("not json\n"),
          data: (_s, chunk) => void (text += chunk.toString()),
          close: () => resolve(text),
        },
      });
    });
    expect(JSON.parse(reply)).toEqual({ ok: false, error: "invalid", message: "The request is not JSON." });
  });

  test("a held request's cleanup runs when the client leaves first", async () => {
    let cleaned = false;
    const registry = new HandlerRegistry().add("wait", (_req, ctx) => {
      return new Promise((resolve) => {
        ctx.onClose(() => {
          cleaned = true;
          resolve({});
        });
      });
    });
    const { socketPath } = await serve(registry);
    const result = await callHelper(socketPath, { op: "wait" }, { timeoutMs: 100 }).catch((e) => e);
    expect(result).toBeInstanceOf(HelperError);
    expect((result as HelperError).code).toBe(TIMEOUT);
    await waitFor(() => cleaned);
  });

  test("a second server on the same socket finds it in use", async () => {
    const { socketPath } = await serve(new HandlerRegistry());
    const second = new ControlServer(socketPath, new HandlerRegistry(), memoryLogger());
    await expect(second.listen()).rejects.toBeInstanceOf(AlreadyRunning);
  });

  test("a socket file left by a crash is replaced", async () => {
    const socketPath = pathsFor(tmpDir()).socket;
    mkdirSync(socketPath.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(socketPath, "");
    const { socketPath: path } = await serve(new HandlerRegistry().add("ping", () => ({ pong: true })), socketPath);
    expect(await callHelper(path, { op: "ping" })).toEqual({ ok: true, pong: true });
  });

  test("closing removes the socket, and the client then reports the helper as not running", async () => {
    const { server, socketPath } = await serve(new HandlerRegistry());
    server.close();
    expect(existsSync(socketPath)).toBe(false);
    await expect(callHelper(socketPath, { op: "ping" })).rejects.toMatchObject({ code: NOT_RUNNING });
  });

  test("a large reply arrives whole", async () => {
    const big = "x".repeat(300_000);
    const { socketPath } = await serve(new HandlerRegistry().add("big", () => ({ big })));
    expect((await callHelper(socketPath, { op: "big" })).big).toBe(big);
  });
});
