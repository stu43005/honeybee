import { mongoose, type ReturnModelType } from "@typegoose/typegoose";
import type { AnyParamConstructor } from "@typegoose/typegoose/lib/types.js";
import { mongo } from "mongoose";
import assert from "node:assert";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { __dirname } from "../utils/esm.js";
import type { Module } from "./module.js";

export const MONGO_URI = process.env.MONGO_URI;

export class MongodbModule implements Module {
  name = "mongodb";

  async init(): Promise<void> {
    assert(MONGO_URI, "MONGO_URI should be defined.");
    await mongoose.connect(MONGO_URI);
  }

  async close(): Promise<void> {
    return mongoose.disconnect();
  }

  async healthCheck(): Promise<boolean> {
    return (
      mongoose.connection.readyState === mongoose.ConnectionStates.connected
    );
  }
}

export function documentLog(
  data: mongo.ChangeStreamDocument | mongo.Document | string,
  ...obj: any
) {
  let id: unknown;
  if (typeof data === "string") {
    id = data;
  } else if ("documentKey" in data) {
    id =
      data.documentKey._id instanceof mongo.BSON.ObjectId
        ? data.documentKey._id.toHexString()
        : data.documentKey._id;
  } else {
    id =
      data._id instanceof mongo.BSON.ObjectId
        ? data._id.toHexString()
        : data._id;
  }
  console.log(`${id} -`, ...obj);
}

export async function changeStreamCloseSignal(
  changeStream: mongoose.mongo.ChangeStream<any, any>,
  signal: AbortSignal
): Promise<void> {
  function close() {
    changeStream.removeAllListeners();
    return changeStream.close();
  }
  if (signal.aborted) {
    return close();
  }
  signal.addEventListener("abort", async () => {
    await close();
  });
}

export async function importAllModels(): Promise<void> {
  const modelsDir = path.join(__dirname(import.meta), "../models");
  for (const file of await fsp.readdir(modelsDir, { withFileTypes: true })) {
    if (
      file.isFile() &&
      !file.name.endsWith(".d.ts") &&
      !file.name.endsWith(".spec.js") &&
      !file.name.endsWith(".spec.ts") &&
      !file.name.endsWith(".test.js") &&
      !file.name.endsWith(".test.ts")
    ) {
      const importPath = pathToFileURL(
        path.join(modelsDir, file.name)
      ).href;
      await import(importPath);
    }
  }
}

export function getModelByCollectionName(
  collectionName: string
): AnyModelType | undefined {
  for (const model of Object.values(mongoose.models)) {
    if (model.collection.name === collectionName) {
      return model;
    }
  }
}

export type AnyModelType = ReturnModelType<AnyParamConstructor<any>>;
