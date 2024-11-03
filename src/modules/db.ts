import { mongoose, type ReturnModelType } from "@typegoose/typegoose";
import type { AnyParamConstructor } from "@typegoose/typegoose/lib/types";
import assert from "node:assert";
import fsp from "node:fs/promises";
import path from "node:path";

export const MONGO_URI = process.env.MONGO_URI;

export async function initMongo() {
  assert(MONGO_URI, "MONGO_URI should be defined.");

  // await mongoose.connect(MONGO_URI, {
  //   useNewUrlParser: true,
  //   useUnifiedTopology: true,
  //   useCreateIndex: true,
  // });
  await mongoose.connect(MONGO_URI);

  return () => mongoose.disconnect();
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
  const modelsDir = path.join(__dirname, "../models");
  for (const file of await fsp.readdir(modelsDir, { withFileTypes: true })) {
    if (file.isFile()) {
      const importPath = path.join(
        modelsDir,
        path.basename(file.name, path.extname(file.name))
      );
      require(importPath);
    }
  }
}

export function getModelByCollectionName(
  collectionName: string
): ReturnModelType<AnyParamConstructor<any>> | undefined {
  for (const model of Object.values(mongoose.models)) {
    if (model.collection.name === collectionName) {
      return model;
    }
  }
}
