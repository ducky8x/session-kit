/**
 * A small Discord REST API on a loopback port: guild channels, messages and a few lookups, with scripted
 * failures and rate-limit headers. Every request is recorded. Nothing here talks to the real Discord.
 */

export const GUILD_ID = "100000000000000001";
export const OWNER_ID = "200000000000000002";
export const BOT_ID = "300000000000000003";
export const APP_ID = "400000000000000004";

export interface FakeChannel {
  id: string;
  guild_id: string;
  /** 0 text, 4 category. */
  type: number;
  name: string;
  parent_id: string | null;
  topic?: string | null;
  position: number;
}

export interface FakeMessage {
  id: string;
  channel_id: string;
  content: string;
  allowed_mentions?: unknown;
  author: { id: string; bot: boolean };
  edited: boolean;
}

export interface RecordedRequest {
  method: string;
  /** The path after the API base, such as `/channels/1/messages`. */
  path: string;
  body: any;
  authorization: string | null;
  userAgent: string | null;
}

interface Override {
  method?: string;
  path: RegExp | string;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  times: number;
}

interface HeaderRule {
  method?: string;
  path: RegExp | string;
  headers: Record<string, string>;
  times: number;
}

function matches(rule: { method?: string; path: RegExp | string }, method: string, path: string): boolean {
  if (rule.method && rule.method !== method) return false;
  return typeof rule.path === "string" ? rule.path === path : rule.path.test(path);
}

export class FakeDiscordRest {
  readonly channels = new Map<string, FakeChannel>();
  readonly messages: FakeMessage[] = [];
  readonly requests: RecordedRequest[] = [];
  guild = { id: GUILD_ID, name: "Sessions", owner_id: OWNER_ID };
  /** Guilds the bot is in (for `GET /users/@me/guilds`). */
  guilds: { id: string; name: string; owner_id: string }[] = [this.guild];
  users = new Map<string, { id: string; username: string; global_name: string | null }>([
    [OWNER_ID, { id: OWNER_ID, username: "owner", global_name: "Owner" }],
  ]);
  /** Discord's limits, smaller in a test that wants to reach them. */
  maxChannels = 500;
  maxPerCategory = 50;
  private overrides: Override[] = [];
  private headerRules: HeaderRule[] = [];
  private nextId = 1n;
  private server: ReturnType<typeof Bun.serve> | null = null;

  static async start(): Promise<FakeDiscordRest> {
    const fake = new FakeDiscordRest();
    fake.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => fake.handle(req) });
    return fake;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.server!.port}/api/v10`;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  // ---- what tests set up ----------------------------------------------------

  newId(): string {
    return String(900000000000000000n + this.nextId++);
  }

  addChannel(o: { name: string; type?: number; parent_id?: string | null; topic?: string | null; id?: string }): FakeChannel {
    const channel: FakeChannel = {
      id: o.id ?? this.newId(),
      guild_id: GUILD_ID,
      type: o.type ?? 0,
      name: o.name,
      parent_id: o.parent_id ?? null,
      topic: o.topic ?? null,
      position: this.channels.size,
    };
    this.channels.set(channel.id, channel);
    return channel;
  }

  addCategory(name: string): FakeChannel {
    return this.addChannel({ name, type: 4 });
  }

  /** Answer the next `times` matching requests with this status and body instead of handling them. */
  failNext(o: { method?: string; path: RegExp | string; status: number; body?: unknown; headers?: Record<string, string>; times?: number }): void {
    this.overrides.push({ ...o, times: o.times ?? 1 });
  }

  /** Add these headers to the next `times` matching successful responses (rate-limit buckets). */
  addHeaders(o: { method?: string; path: RegExp | string; headers: Record<string, string>; times?: number }): void {
    this.headerRules.push({ ...o, times: o.times ?? 1 });
  }

  // ---- what tests read back ---------------------------------------------------

  channelNamed(name: string): FakeChannel | undefined {
    return [...this.channels.values()].find((c) => c.name === name);
  }

  childrenOf(parentId: string): FakeChannel[] {
    return [...this.channels.values()].filter((c) => c.parent_id === parentId);
  }

  posted(channelId?: string): FakeMessage[] {
    return channelId === undefined ? this.messages : this.messages.filter((m) => m.channel_id === channelId);
  }

  requestsMatching(method: string, path: RegExp | string): RecordedRequest[] {
    return this.requests.filter((r) => matches({ method, path }, r.method, r.path));
  }

  // ---- the API ------------------------------------------------------------------

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    if (status === 204) return new Response(null, { status, headers });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private error(status: number, code: number, message: string): Response {
    return this.json(status, { message, code });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v10/, "");
    const method = req.method;
    const text = await req.text();
    let body: any = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    this.requests.push({
      method,
      path,
      body,
      authorization: req.headers.get("authorization"),
      userAgent: req.headers.get("user-agent"),
    });

    const override = this.overrides.find((o) => o.times > 0 && matches(o, method, path));
    if (override) {
      override.times--;
      this.overrides = this.overrides.filter((o) => o.times > 0);
      return this.json(override.status, override.body ?? {}, override.headers);
    }

    const response = this.route(method, path, body);
    const rule = this.headerRules.find((r) => r.times > 0 && matches(r, method, path));
    if (rule && response.status < 400) {
      rule.times--;
      this.headerRules = this.headerRules.filter((r) => r.times > 0);
      for (const [k, v] of Object.entries(rule.headers)) response.headers.set(k, v);
    }
    return response;
  }

  private route(method: string, path: string, body: any): Response {
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/users/@me/guilds") return this.json(200, this.guilds);
    if (method === "GET" && path === "/users/@me") return this.json(200, { id: BOT_ID, username: "session-kit", bot: true });
    if ((m = /^\/users\/(\d+)$/.exec(path)) && method === "GET") {
      const user = this.users.get(m[1]!);
      return user ? this.json(200, user) : this.error(404, 10013, "Unknown User");
    }
    if ((m = /^\/guilds\/(\d+)$/.exec(path)) && method === "GET") {
      const guild = this.guilds.find((g) => g.id === m![1]);
      return guild ? this.json(200, guild) : this.error(404, 10004, "Unknown Guild");
    }
    if ((m = /^\/guilds\/(\d+)\/channels$/.exec(path))) {
      if (m[1] !== GUILD_ID) return this.error(404, 10004, "Unknown Guild");
      if (method === "GET") return this.json(200, [...this.channels.values()]);
      if (method === "POST") return this.createChannel(body);
    }
    if ((m = /^\/channels\/(\d+)$/.exec(path))) {
      const channel = this.channels.get(m[1]!);
      if (!channel) return this.error(404, 10003, "Unknown Channel");
      if (method === "GET") return this.json(200, channel);
      if (method === "DELETE") {
        this.channels.delete(channel.id);
        return this.json(200, channel);
      }
      if (method === "PATCH") return this.patchChannel(channel, body);
    }
    if ((m = /^\/channels\/(\d+)\/messages$/.exec(path)) && method === "POST") {
      const channel = this.channels.get(m[1]!);
      if (!channel) return this.error(404, 10003, "Unknown Channel");
      if (typeof body?.content !== "string" || body.content === "") return this.error(400, 50006, "Cannot send an empty message");
      if (body.content.length > 2000) return this.error(400, 50035, "Invalid Form Body");
      const message: FakeMessage = {
        id: this.newId(),
        channel_id: channel.id,
        content: body.content,
        allowed_mentions: body.allowed_mentions,
        author: { id: BOT_ID, bot: true },
        edited: false,
      };
      this.messages.push(message);
      return this.json(200, message);
    }
    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path)) && method === "PATCH") {
      const message = this.messages.find((x) => x.channel_id === m![1] && x.id === m![2]);
      if (!message) return this.error(404, 10008, "Unknown Message");
      if (typeof body?.content === "string") message.content = body.content;
      message.edited = true;
      return this.json(200, message);
    }
    return this.error(404, 0, "404: Not Found");
  }

  private createChannel(body: any): Response {
    if (this.channels.size >= this.maxChannels) {
      return this.error(400, 30013, "Maximum number of guild channels reached (500)");
    }
    const parent = typeof body?.parent_id === "string" ? body.parent_id : null;
    if (parent !== null) {
      const category = this.channels.get(parent);
      if (!category || category.type !== 4) return this.error(400, 50035, "Invalid Form Body");
      if (this.childrenOf(parent).length >= this.maxPerCategory) return this.error(400, 50035, "Invalid Form Body");
    }
    const channel = this.addChannel({
      name: String(body?.name ?? ""),
      type: typeof body?.type === "number" ? body.type : 0,
      parent_id: parent,
      topic: typeof body?.topic === "string" ? body.topic : null,
    });
    return this.json(201, channel);
  }

  private patchChannel(channel: FakeChannel, body: any): Response {
    if (body && "parent_id" in body) {
      const parent = body.parent_id as string | null;
      if (parent !== null) {
        const category = this.channels.get(parent);
        if (!category || category.type !== 4) return this.error(400, 50035, "Invalid Form Body");
        if (channel.parent_id !== parent && this.childrenOf(parent).length >= this.maxPerCategory) {
          return this.error(400, 50035, "Invalid Form Body");
        }
      }
      channel.parent_id = parent;
    }
    if (typeof body?.name === "string") channel.name = body.name;
    if (body && "topic" in body) channel.topic = body.topic;
    return this.json(200, channel);
  }
}
