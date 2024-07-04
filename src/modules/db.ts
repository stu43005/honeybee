import { mongoose } from "@typegoose/typegoose";
import assert from "assert";

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
