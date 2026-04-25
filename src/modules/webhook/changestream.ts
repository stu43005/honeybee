import type { DocumentType } from "@typegoose/typegoose";
import { isEqual, groupBy } from "lodash-es";
import { mongo } from "mongoose";
import PQueue from "p-queue";
import {
  WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS,
  WEBHOOK_RESUME_TOKEN_TTL_MS,
} from "../../constants.js";
import type { WebhookJob } from "../../interfaces.js";
import WebhookModel, { type Webhook } from "../../models/Webhook.js";
import { flatObjectKey, setIfDefine } from "../../util.js";
import type { Application } from "../application.js";
import { documentLog, getModelByCollectionName } from "../db.js";
import { isMatching } from "../matching.js";
import type { Module } from "../module.js";
import { RedisModule } from "../redis.js";
import { WebhookPartitionModule } from "./partition.js";
import { WebhookQueueProducerModule } from "./queue.js";
import { simplifyOrBranches } from "./simplifyMatch.js";

const RESUME_TOKEN_KEY_PREFIX = "webhook:resumetoken:";

interface CollectionState {
  changeStream: mongo.ChangeStream;
  tokenSaveInterval: NodeJS.Timeout;
  rawBranches: any[];
  webhooks: DocumentType<Webhook>[];
}

function requireModule<T extends Module>(app: Application, name: string): T {
  const mod = app.get<T>(name);
  if (!mod) {
    throw new Error(
      `WebhookChangeStreamModule: required module '${name}' not found`
    );
  }
  return mod;
}

/**
 * Listens to MongoDB changeStreams for the collections this instance owns and
 * forwards each relevant insert/update event into the bee-queue worker pool
 * for actual webhook delivery. Centralises all changeStream lifecycle in one
 * place so that webhook config changes (meta-stream) and ownership changes
 * (partition rebalance) trigger a single reconcile path.
 *
 * Owns:
 *   - meta-stream: a single changeStream on WebhookModel that watches insert /
 *     update / replace / delete on webhook config documents and triggers a
 *     reconcile so newly enabled collections are picked up and disabled ones
 *     are dropped.
 *   - per-collection changeStreams: opens one ChangeStream per collection that
 *     this instance currently owns, with a $match filter assembled from all
 *     enabled webhooks targeting that collection.
 *   - resume token persistence: writes the latest resume token to Redis on a
 *     periodic interval and again at close, so a restarted instance (or a new
 *     owner after rebalance) resumes from where the previous owner stopped.
 *   - reconcile loop: idempotent setupCollections() that diffs the desired
 *     ownership set (from partition.getAssignedCollections + enabled webhook
 *     list) against the currently-open streams and opens / closes / updates as
 *     needed. Triggered by meta-stream events and by partition rebalance.
 *
 * Dependencies (obtained in init() via app.get):
 *   - RedisModule: stores resume tokens under "webhook:resumetoken:<coll>"
 *     keys. Resume tokens are this module's internal state — no other module
 *     reads them.
 *   - WebhookPartitionModule: provides getAssignedCollections() to compute
 *     ownership and emits "rebalance" when the active instance set changes.
 *   - WebhookQueueProducerModule: receives change events via
 *     producerModule.scheduleAndEnqueue(job). The cooldown window, in-flight
 *     coalesce check, and Redis WATCH/MULTI/EXEC coordination all live inside
 *     the producer; this module just hands over a WebhookJob describing the
 *     event.
 */
export class WebhookChangeStreamModule implements Module {
  public readonly name = "webhook-changestream";
  public isInit = false;

  private redisModule!: RedisModule;
  private partition!: WebhookPartitionModule;
  private producerModule!: WebhookQueueProducerModule;

  private readonly collections = new Map<string, CollectionState>();
  // PQueue(concurrency=1) + size<2 cap: serialize reconcile runs and
  // coalesce burst events (meta-stream + rebalance) into at most 2 pending runs
  private readonly setupQueue = new PQueue({ concurrency: 1 });
  private metaStream?: mongo.ChangeStream;

  constructor(private readonly app: Application) {}

  init(): Promise<void> {
    this.redisModule = requireModule(this.app, "redis");
    this.partition = requireModule(this.app, "webhook-partition");
    this.producerModule = requireModule(this.app, "webhook-queue-producer");

    // Meta-stream: watch Webhook config inserts/updates/replaces/deletes
    this.metaStream = WebhookModel.watch([
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace", "delete"] },
        },
      },
    ]).on("change", (data: mongo.ChangeStreamDocument<Webhook>) => {
      documentLog(data, data.operationType.toUpperCase());
      this.scheduleSetup();
    });

    // React to partition reassignments. This also provides our INITIAL
    // reconcile: runWebhook registers changestream BEFORE partition so that
    // partition closes first under LIFO shutdown — partition's close()
    // promptly DELs its instance key from Redis and broadcasts a rebalance,
    // letting peers begin reassignment while our own changeStreams are still
    // alive to flush in-flight events. As a consequence, this init() runs
    // while partition is still uninitialized. partition.init() will later
    // publish to its rebalance channel as its last step, and its own
    // subscriber loops it back to emit "rebalance" on the EventEmitter —
    // triggering our first setupCollections() call with a fully-populated
    // activeInstanceIds. No manual initial reconcile is needed.
    this.partition.on("rebalance", () => this.scheduleSetup());
    return Promise.resolve();
  }

  async close(): Promise<void> {
    // Stop accepting new meta-stream events
    if (this.metaStream) {
      await this.metaStream.close();
    }
    // Drain any in-flight reconcile runs
    await this.setupQueue.onIdle();
    // Close all owned collection streams (writes final resume tokens)
    for (const coll of Array.from(this.collections.keys())) {
      await this.closeCollection(coll);
    }
  }

  /** Enqueue a reconcile run. Drops if ≥2 already queued (debounce). */
  private scheduleSetup(): void {
    if (this.setupQueue.size < 2) {
      void this.setupQueue.add(() => this.setupCollections());
    }
  }

  /**
   * Reconcile loop: fetch enabled webhooks, compute which colls this instance
   * should listen to via partition.getAssignedCollections, then diff against
   * current `collections` Map to open/close/keep each one.
   */
  private async setupCollections(): Promise<void> {
    try {
      const allWebhooks = await WebhookModel.findEnabled();
      const valid = allWebhooks.filter((wh) => this.validateWebhook(wh));
      const byColl = groupBy(
        valid.flatMap((webhook) =>
          webhook.colls.map((coll) => ({ webhook, coll }))
        ),
        ({ coll }) => coll
      );
      const allColls = Object.keys(byColl);
      const assigned = new Set(this.partition.getAssignedCollections(allColls));

      // 1) Close collections no longer owned or no longer configured
      for (const coll of Array.from(this.collections.keys())) {
        if (!assigned.has(coll) || !byColl[coll]) {
          await this.closeCollection(coll);
        }
      }

      // 2) Open or reconfigure assigned collections
      for (const coll of assigned) {
        const webhooks = byColl[coll].map(({ webhook }) => webhook);
        const rawBranches = this.buildRawBranches(webhooks);
        const existing = this.collections.get(coll);
        if (
          existing &&
          existing.changeStream.closed === false &&
          isEqual(rawBranches, existing.rawBranches)
        ) {
          existing.webhooks = webhooks;
          continue;
        }
        const simplified = simplifyOrBranches(rawBranches);
        if (simplified.length === 0) {
          // Defensive: today's simplifier never drops branches, but a future rule
          // change could regress. An empty $or would forward every event silently,
          // so fail fast instead.
          throw new Error(
            `simplifyOrBranches dropped all ${rawBranches.length} branch(es) for "${coll}" — simplifier regression`
          );
        }
        const match =
          simplified.length === 1 ? simplified[0] : { $or: simplified };
        if (existing) await this.closeCollection(coll);
        const opened = await this.openCollection(
          coll,
          webhooks,
          rawBranches,
          match
        );
        if (opened) {
          documentLog(
            coll,
            `start listening (branches: ${rawBranches.length} → ${simplified.length})`
          );
        }
      }
    } catch (error) {
      documentLog("global", "<!> [FATAL] Unable to setup webhooks.", error);
      process.exit(1);
    }
  }

  private buildRawBranches(webhooks: DocumentType<Webhook>[]): any[] {
    return webhooks.map((webhook) =>
      flatObjectKey({
        operationType: webhook.followUpdate
          ? { $in: ["insert", "update"] }
          : "insert",
        ...setIfDefine("fullDocument", webhook.match),
      })
    );
  }

  private validateWebhook(webhook: DocumentType<Webhook>): boolean {
    const error = webhook.validateSync();
    if (error) {
      documentLog(
        webhook,
        "<!> [ERROR] The format of the webhook is incorrect.",
        error
      );
      return false;
    }
    return true;
  }

  private async openCollection(
    coll: string,
    webhooks: DocumentType<Webhook>[],
    rawBranches: any[],
    match: any
  ): Promise<boolean> {
    const model = getModelByCollectionName(coll);
    if (!model) {
      documentLog(
        coll,
        `<!> [ERROR] Unable to get model (unknown collection "${coll}")`
      );
      return false;
    }
    const resumeAfter = await this.loadResumeToken(coll);
    const changeStream = model.watch([{ $match: match }], {
      resumeAfter: resumeAfter as any,
      fullDocument: "updateLookup",
      readPreference: "secondaryPreferred",
    });

    const tokenSaveInterval = global.setInterval(() => {
      const token = (changeStream as any).resumeToken;
      if (!token) return;
      void this.saveResumeToken(coll, token).catch((err) =>
        documentLog(coll, "<!> [WARN] resume token save failed:", err)
      );
    }, WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS);

    changeStream.on("change", (data: mongo.ChangeStreamDocument) => {
      this.handleChangeEvent(coll, data);
    });

    this.collections.set(coll, {
      changeStream,
      tokenSaveInterval,
      rawBranches,
      webhooks,
    });
    return true;
  }

  private async closeCollection(coll: string): Promise<void> {
    const state = this.collections.get(coll);
    if (!state) return;
    this.collections.delete(coll);
    global.clearInterval(state.tokenSaveInterval);
    // Read resumeToken BEFORE close() — driver may clear it afterwards
    const finalToken = (state.changeStream as any).resumeToken;
    try {
      await state.changeStream.close();
      state.changeStream.removeAllListeners();
    } catch (error) {
      documentLog(coll, "<!> [ERROR] Unable to close change stream.", error);
    }
    if (finalToken) {
      await this.saveResumeToken(coll, finalToken).catch(() => {});
    }
    documentLog(coll, "stop listening");
  }

  private handleChangeEvent(
    coll: string,
    data: mongo.ChangeStreamDocument
  ): void {
    if (data.operationType !== "insert" && data.operationType !== "update")
      return;
    if (!("documentKey" in data)) return;
    if (!("fullDocument" in data) || !data.fullDocument) {
      documentLog(coll, "<!> [ERROR] missing fullDocument", data.documentKey);
      return;
    }
    const state = this.collections.get(coll);
    if (!state) return;

    const docId = data.documentKey._id.toHexString();
    for (const webhook of state.webhooks) {
      if (!webhook.followUpdate && data.operationType === "update") continue;
      if (webhook.match && !isMatching(data.fullDocument, webhook.match))
        continue;
      const job: WebhookJob = {
        webhookId: webhook._id.toHexString(),
        coll,
        docId,
        operationType: data.operationType,
      };
      void this.producerModule
        .scheduleAndEnqueue(job)
        .catch((err) =>
          documentLog(coll, "<!> [ERROR] scheduleAndEnqueue failed:", err)
        );
    }
  }

  private async loadResumeToken(coll: string): Promise<unknown> {
    const raw = await this.redisModule.redis.get(
      `${RESUME_TOKEN_KEY_PREFIX}${coll}`
    );
    if (!raw) return undefined;
    try {
      return JSON.parse(raw).token;
    } catch {
      return undefined;
    }
  }

  private async saveResumeToken(coll: string, token: unknown): Promise<void> {
    await this.redisModule.redis.set(
      `${RESUME_TOKEN_KEY_PREFIX}${coll}`,
      JSON.stringify({
        token,
        updatedAt: Date.now(),
        owner: this.partition.instanceId,
      }),
      { PX: WEBHOOK_RESUME_TOKEN_TTL_MS }
    );
  }
}
