import assert from "assert";
import { createClient, RedisClientType } from "redis";
import { REDIS_URI } from "../constants.js";
import type { Module } from "./module.js";

export interface RedisModuleOptions {
  /**
   * Mark this RedisModule as a non-critical, best-effort dependency.
   * When true: init() does not `await connect()` (node-redis's default
   * reconnectStrategy retries the initial connect forever in the background),
   * healthCheck() returns true without ping() so it never fails /healthz
   * liveness, and close() stops the background reconnect in every state.
   * Default false keeps the existing blocking behavior for critical consumers.
   */
  nonBlockingConnect?: boolean;
}

export class RedisModule implements Module {
  name = "redis";
  redis: RedisClientType;
  private _subscriber?: RedisClientType;
  private nonBlockingConnect: boolean;
  private connectPromise?: Promise<void>;

  constructor(options: RedisModuleOptions = {}) {
    assert(REDIS_URI, "REDIS_URI should be defined.");
    this.nonBlockingConnect = options.nonBlockingConnect ?? false;
    this.redis = createClient({
      url: REDIS_URI,
    });
  }

  async init(): Promise<void> {
    if (this.nonBlockingConnect) {
      // Attach an 'error' listener BEFORE connect: node-redis emits 'error' on
      // every failed (re)connect attempt, and an EventEmitter 'error' with no
      // listener throws and crashes the process. Best-effort: gate Redis health
      // is surfaced via the gate's degraded log, not here.
      this.redis.on("error", () => undefined);
      // Fire-and-forget; do not block startup. The terminal catch swallows the
      // rejection that only happens if the connect is interrupted by close().
      this.connectPromise = this.redis.connect().then(
        () => undefined,
        () => undefined
      );
      return;
    }
    await this.redis.connect();
  }

  async close(_signal?: NodeJS.Signals): Promise<void> {
    if (this._subscriber?.isOpen) {
      try {
        await this._subscriber.disconnect();
      } catch {
        // ignore during shutdown
      }
    }
    if (this.nonBlockingConnect) {
      // connect() sets isOpen=true immediately and the initial-connect retry
      // loop runs while (isOpen && !isReady); so isOpen is true while connected
      // OR still retrying. disconnect() in that state clears isOpen, ending the
      // retry loop and closing the socket. When isOpen is false (never started
      // or gave up) disconnect() would throw ClientClosedError, so skip it.
      if (this.redis.isOpen) {
        try {
          await this.redis.disconnect();
        } catch {
          // ignore during shutdown
        }
      }
      if (this.connectPromise) {
        await this.connectPromise; // terminal-caught; settles, never rejects
      }
      return;
    }
    await this.redis.disconnect();
  }

  async healthCheck(): Promise<boolean> {
    if (this.nonBlockingConnect) {
      // Non-critical: never fail /healthz liveness on this connection.
      return true;
    }
    await this.redis.ping();
    return true;
  }

  /**
   * Returns a connected Redis subscriber connection. Redis subscribe mode is
   * exclusive — a connection in subscribe state cannot execute any other
   * command — so consumers that need pub/sub must use a dedicated connection
   * separate from the main command connection (this.redis).
   *
   * Lazy-initialized on first call and reused for all subsequent calls;
   * lifecycle (disconnect on RedisModule.close) is owned here, so consumers
   * MUST NOT call disconnect() on the returned client. Consumers SHOULD
   * unsubscribe() from their own channels in their close() to clean up
   * listeners — the underlying connection stays alive for any other consumer.
   */
  async getSubscriber(): Promise<RedisClientType> {
    if (!this._subscriber) {
      this._subscriber = this.redis.duplicate();
      await this._subscriber.connect();
    }
    return this._subscriber;
  }
}
