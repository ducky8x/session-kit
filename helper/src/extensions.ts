import type { Daemon } from "./daemon.ts";

/**
 * A feature that plugs into the daemon when it is built: it adds socket ops to `daemon.handlers` and listens
 * with `daemon.onInbound`, `daemon.onSend` and `daemon.onGatewayEvent`.
 */
export type Extension = (daemon: Daemon) => void;

/** Every extension the real daemon (and the daemon tests) install, in order. */
export const EXTENSIONS: Extension[] = [];
