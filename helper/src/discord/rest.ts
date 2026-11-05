import { backoffMs } from "../backoff.ts";
import type { Clock } from "../clock.ts";
import type { Logger } from "../log.ts";
import { VERSION } from "../version.ts";

export const DISCORD_API = "https://discord.com/api/v10";
/** Discord asks bots to name themselves this way. */
export const USER_AGENT = `DiscordBot (https://github.com/ducky8x/session-kit, ${VERSION})`;

/** How many times a 5xx or a network error is retried before the call fails. */
export const DEFAULT_MAX_RETRIES = 5;
/** A request that takes longer than this counts as a network error. */
const REQUEST_TIMEOUT_MS = 15_000;
/** A call that keeps getting 429s gives up after this many. */
const MAX_RATE_LIMITED = 10;

/**
 * Why a call failed: `client` a 4xx other than 429 (not retried), `server` a 5xx after the retries, `network`
 * no answer after the retries, `rate-limited` a 429 the caller asked to see, `no-token` nothing to sign with.
 */
export type RestErrorKind = "client" | "server" | "network" | "rate-limited" | "no-token";

export class RestError extends Error {
  constructor(
    readonly kind: RestErrorKind,
    readonly route: string,
    readonly status: number,
    /** Discord's own error code from the JSON body, such as 10003 for an unknown channel. */
    readonly code: number | null,
    message: string,
    /** For `rate-limited`: how long Discord asked to wait. */
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

/** Discord's error code for a channel that does not exist (deleted). */
export const UNKNOWN_CHANNEL = 10003;

export interface RestClientOptions {
  baseUrl?: string;
  /** Read for every request, so a new token takes effect without a new client. */
  token: () => string | null;
  clock: Clock;
  log: Logger;
  fetch?: typeof fetch;
  maxRetries?: number;
}

export interface RequestOptions {
  body?: unknown;
  /** false: a 429 throws a `rate-limited` error instead of being waited out and retried. */
  retry429?: boolean;
}

interface Bucket {
  /** No request goes out on this route before this time. */
  pausedUntil: number;
  /** The route's requests run one after another on this chain. */
  chain: Promise<void>;
}

/**
 * The route a request is rate-limited under: the method and path, keeping the channel, guild or webhook id
 * (Discord's "major parameters") and replacing every other id with `:id`. It is also how requests are logged.
 */
export function routeKey(method: string, path: string): string {
  const segments = path.split("?")[0]!.split("/");
  const keyed = segments.map((segment, i) => {
    if (!/^\d{5,}$/.test(segment)) return segment;
    const before = segments[i - 1];
    return before === "channels" || before === "guilds" || before === "webhooks" ? segment : ":id";
  });
  return `${method} ${keyed.join("/")}`;
}

function finite(value: unknown): number | null {
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = (await res.json()) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Discord's REST API with its rate limits. Requests on one route go out one at a time; `X-RateLimit-Remaining: 0`
 * pauses the route until `X-RateLimit-Reset-After`; a 429 waits `retry_after` and sends the same call again;
 * a 5xx or a network error is retried with backoff; any other 4xx is logged (route and code only) and thrown.
 */
export class RestClient {
  private readonly buckets = new Map<string, Bucket>();
  private globalPausedUntil = 0;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(private readonly o: RestClientOptions) {
    this.baseUrl = o.baseUrl ?? DISCORD_API;
    this.fetchImpl = o.fetch ?? fetch;
    this.maxRetries = o.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const route = routeKey(method, path);
    let bucket = this.buckets.get(route);
    if (!bucket) {
      bucket = { pausedUntil: 0, chain: Promise.resolve() };
      this.buckets.set(route, bucket);
    }
    const b = bucket;
    const run = b.chain.then(() => this.send<T>(method, path, route, b, opts));
    b.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.o.clock.setTimeout(resolve, ms));
  }

  private async waitForBucket(bucket: Bucket): Promise<void> {
    for (;;) {
      const until = Math.max(bucket.pausedUntil, this.globalPausedUntil);
      const wait = until - this.o.clock.now();
      if (wait <= 0) return;
      await this.sleep(wait);
    }
  }

  private noteLimits(bucket: Bucket, headers: Headers): void {
    const remaining = finite(headers.get("x-ratelimit-remaining"));
    const resetAfter = finite(headers.get("x-ratelimit-reset-after"));
    if (remaining === 0 && resetAfter !== null) {
      bucket.pausedUntil = Math.max(bucket.pausedUntil, this.o.clock.now() + Math.ceil(resetAfter * 1000));
    }
  }

  private async send<T>(method: string, path: string, route: string, bucket: Bucket, opts: RequestOptions): Promise<T> {
    let failures = 0;
    let rateLimited = 0;
    for (;;) {
      await this.waitForBucket(bucket);
      const token = this.o.token();
      if (!token) throw new RestError("no-token", route, 0, null, "There is no bot token.");

      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bot ${token}`,
            "User-Agent": USER_AGENT,
            ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (failures >= this.maxRetries) {
          this.o.log.warn(`${route} failed: no answer (${(error as Error).name})`);
          throw new RestError("network", route, 0, null, `No answer from Discord for ${route}.`);
        }
        await this.sleep(backoffMs(failures++));
        continue;
      }

      this.noteLimits(bucket, res.headers);

      if (res.status === 429) {
        const body = await readJson(res);
        const seconds = finite(body?.retry_after) ?? finite(res.headers.get("retry-after")) ?? 1;
        const retryAfterMs = Math.ceil(seconds * 1000);
        const until = this.o.clock.now() + retryAfterMs;
        if (body?.global === true || res.headers.get("x-ratelimit-global") === "true") {
          this.globalPausedUntil = Math.max(this.globalPausedUntil, until);
        } else {
          bucket.pausedUntil = Math.max(bucket.pausedUntil, until);
        }
        this.o.log.info(`${route} rate limited for ${retryAfterMs} ms`);
        if (opts.retry429 === false || ++rateLimited > MAX_RATE_LIMITED) {
          throw new RestError("rate-limited", route, 429, null, `Rate limited on ${route}.`, retryAfterMs);
        }
        continue;
      }

      if (res.status >= 500) {
        await res.body?.cancel();
        if (failures >= this.maxRetries) {
          this.o.log.warn(`${route} -> ${res.status}`);
          throw new RestError("server", route, res.status, null, `Discord failed on ${route} (${res.status}).`);
        }
        await this.sleep(backoffMs(failures++));
        continue;
      }

      if (res.status >= 400) {
        // Only the status and Discord's numeric code are kept: the body can echo what was sent.
        const code = finite((await readJson(res))?.code);
        this.o.log.warn(`${route} -> ${res.status}${code === null ? "" : ` (code ${code})`}`);
        throw new RestError("client", route, res.status, code, `Discord refused ${route} (${res.status}).`);
      }

      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text === "" ? undefined : JSON.parse(text)) as T;
    }
  }
}
