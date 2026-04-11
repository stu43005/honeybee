import { type DocumentType, type ReturnModelType } from "@typegoose/typegoose";
import type { AnyParamConstructor } from "@typegoose/typegoose/lib/types.js";
import mongoose, { mongo, type FilterQuery } from "mongoose";
import EventEmitter from "node:events";
import { setTimeout } from "node:timers/promises";

export type ResumeToken = {
  id?: string;
  updateAt?: number;
};

export type OperationType = "insert" | "update";

export type WatcherIterateOptions = {
  filter?: FilterQuery<any>;
  resumeToken?: ResumeToken;
  operationType?: OperationType[];
  fetchInterval?: number;
  signal?: AbortSignal;
};

export type WatcherResultDocument<
  T extends AnyParamConstructor<mongoose.AnyObject> =
    AnyParamConstructor<mongoose.AnyObject>,
> = {
  documentKey: mongo.WithId<object>;
  fullDocument: DocumentType<InstanceType<T>>;
  operationType: OperationType;
  ns: {
    db: string;
    coll: string;
  };
};

type CollectionWatcherEvents<
  T extends AnyParamConstructor<mongoose.AnyObject>,
> = {
  data: [data: WatcherResultDocument<T>, watcher: CollectionWatcher<T>];
  end: [reason: string | null];
  error: [error: unknown];
};

export class CollectionWatcher<
  T extends AnyParamConstructor<mongoose.AnyObject> =
    AnyParamConstructor<mongoose.AnyObject>,
> extends EventEmitter<CollectionWatcherEvents<T>> {
  private listener: Promise<void> | null = null;
  private listenerAbortion: AbortController = new AbortController();

  private token: mongo.BSON.ObjectId | null = null;
  private updateAt: Date | null = null;
  public get resumeToken(): ResumeToken {
    return {
      id: this.token?.toString(),
      updateAt: this.updateAt?.getTime(),
    };
  }

  public get dbName(): string {
    return this.model.db.name;
  }
  public get collectionName(): string {
    return this.model.collection.name;
  }

  constructor(private model: ReturnModelType<T>) {
    super();
  }

  public listen(iterateOptions?: Omit<WatcherIterateOptions, "signal">) {
    if (this.listener) return this.listener;

    this.listenerAbortion = new AbortController();

    const makePromise = async (iterateOptions?: WatcherIterateOptions) => {
      for await (const res of this.iterate(iterateOptions)) {
        this.emit("data", res, this);
      }
    };

    this.listener = makePromise({
      ...iterateOptions,
      signal: this.listenerAbortion.signal,
    })
      .then(() => {
        this.emit("end", null);
      })
      .catch((err: unknown) => {
        if (err === "aborted") return;
        if (err instanceof Error && err.name === "AbortError") return;

        this.emit("error", err);
      })
      .finally(() => {
        this.listener = null;
      });

    return this.listener;
  }

  public async stop(): Promise<void> {
    if (!this.listener) return;
    this.listenerAbortion.abort("aborted");
    await this.listener;
    this.emit("end", "aborted");
  }

  public get stopped() {
    return this.listener === null;
  }

  private async *iterate({
    filter,
    resumeToken = this.resumeToken,
    operationType = ["insert"],
    fetchInterval = 5000,
    signal,
  }: WatcherIterateOptions = {}): AsyncGenerator<
    WatcherResultDocument<T>,
    void,
    unknown
  > {
    let token = (this.token = resumeToken.id
      ? new mongo.BSON.ObjectId(resumeToken.id)
      : createObjectIdFromTime(new Date()));
    let updateAt = resumeToken.updateAt
      ? new Date(resumeToken.updateAt)
      : token.getTimestamp();

    while (true) {
      signal?.throwIfAborted();

      const startMs = Date.now();
      const firstToken = token;

      if (operationType.includes("insert")) {
        const query: FilterQuery<InstanceType<T>> = {
          _id: {
            $gt: firstToken,
          },
        };
        const cursor = this.model
          .find(filter ? { $and: [query, filter] } : query)
          .sort({ _id: 1 })
          .cursor();
        for await (const doc of cursor) {
          signal?.throwIfAborted();

          token = this.token = doc._id as mongo.BSON.ObjectId;
          yield {
            documentKey: {
              _id: doc._id as mongo.BSON.ObjectId,
            },
            fullDocument: doc as DocumentType<InstanceType<T>>,
            operationType: "insert",
            ns: {
              db: this.dbName,
              coll: this.collectionName,
            },
          };
        }
      }

      if (operationType.includes("update")) {
        const query: FilterQuery<InstanceType<T>> = {
          ...(operationType.includes("insert")
            ? { _id: { $lte: firstToken } }
            : {}),
          updatedAt: {
            $gt: updateAt,
          },
          $expr: { $ne: ["$updatedAt", "$createdAt"] },
        };
        const cursor = this.model
          .find(filter ? { $and: [query, filter] } : query)
          .sort({ updatedAt: 1 })
          .cursor();
        for await (const doc of cursor) {
          signal?.throwIfAborted();

          updateAt = this.updateAt = doc.updatedAt!;
          yield {
            documentKey: {
              _id: doc._id as mongo.BSON.ObjectId,
            },
            fullDocument: doc as DocumentType<InstanceType<T>>,
            operationType: "update",
            ns: {
              db: this.dbName,
              coll: this.collectionName,
            },
          };
        }
      }

      const lastToken = createObjectIdFromTime(new Date(startMs - 1000));
      if (token.getTimestamp() < lastToken.getTimestamp()) {
        token = this.token = lastToken;
      }
      if (updateAt < lastToken.getTimestamp()) {
        updateAt = this.updateAt = lastToken.getTimestamp();
      }

      const driftMs = Date.now() - startMs;
      const timeoutMs = Math.max(fetchInterval - driftMs, 500);
      await setTimeout(timeoutMs, void 0, { signal });
    }
  }
}

function createObjectIdFromTime(date: Date) {
  return mongo.BSON.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));
}
