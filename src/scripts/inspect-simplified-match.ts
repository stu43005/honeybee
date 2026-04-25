/**
 * Diagnostic script: connect to Mongo, fetch all enabled webhooks for a
 * given collection name, run them through `buildRawBranches` +
 * `simplifyOrBranches`, and print both the raw `$or` shape and the simplified
 * `$match` shape that `WebhookChangeStreamModule.setupCollections` would
 * pass to `model.watch([{ $match: ... }], ...)`.
 *
 * Usage (after `npm run build`):
 *   MONGO_URI=mongodb://... node dist/scripts/inspect-simplified-match.js chats
 *
 * Multiple collections can be passed:
 *   ... inspect-simplified-match.js chats videos polls
 *
 * Note: tsx/esbuild do not emit decorator metadata, which Typegoose requires.
 * Run the compiled output instead of using tsx directly.
 */

import { createPatch } from "diff";
import { groupBy } from "lodash-es";
import { mongoose } from "@typegoose/typegoose";
import { flatObjectKey, setIfDefine } from "../util.js";
import WebhookModel from "../models/Webhook.js";
import { importAllModels, MONGO_URI } from "../modules/db.js";
import { simplifyOrBranches } from "../modules/webhook/simplifyMatch.js";
import type { Webhook } from "../models/Webhook.js";
import type { DocumentType } from "@typegoose/typegoose";

function colorizePatch(patch: string): string {
  if (!process.stdout.isTTY) return patch;
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---"))
        return `\x1b[1m${line}\x1b[0m`;
      if (line.startsWith("@@")) return `\x1b[36m${line}\x1b[0m`;
      if (line.startsWith("+")) return `\x1b[32m${line}\x1b[0m`;
      if (line.startsWith("-")) return `\x1b[31m${line}\x1b[0m`;
      return line;
    })
    .join("\n");
}

function buildRawBranches(webhooks: DocumentType<Webhook>[]): any[] {
  return webhooks.map((webhook) =>
    flatObjectKey({
      operationType: webhook.followUpdate
        ? { $in: ["insert", "update"] }
        : "insert",
      ...setIfDefine("fullDocument", webhook.match),
    })
  );
}

function validateWebhook(webhook: DocumentType<Webhook>): boolean {
  const error = webhook.validateSync();
  if (error) {
    console.error(
      `[skip] webhook ${webhook._id.toHexString()} failed validation:`,
      error.message
    );
    return false;
  }
  return true;
}

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error(
      "Usage: inspect-simplified-match.ts <coll> [<coll> ...]\n" +
        "Example: inspect-simplified-match.ts chats"
    );
    process.exit(1);
  }
  if (!MONGO_URI) {
    console.error("MONGO_URI is not set.");
    process.exit(1);
  }

  await importAllModels();
  await mongoose.connect(MONGO_URI);

  try {
    const allWebhooks = await WebhookModel.findEnabled();
    const valid = allWebhooks.filter(validateWebhook);
    const byColl = groupBy(
      valid.flatMap((webhook) =>
        webhook.colls.map((coll) => ({ webhook, coll }))
      ),
      ({ coll }) => coll
    );

    for (const coll of targets) {
      const pairs = byColl[coll] ?? [];
      console.log(
        `\n=== Collection: ${coll} (${pairs.length} matching webhook${pairs.length === 1 ? "" : "s"}) ===`
      );
      if (pairs.length === 0) {
        console.log("(no enabled webhooks target this collection)");
        continue;
      }

      const webhooks = pairs.map(({ webhook }) => webhook);
      const rawBranches = buildRawBranches(webhooks);
      const simplified = simplifyOrBranches(rawBranches);
      const match =
        simplified.length === 1 ? simplified[0] : { $or: simplified };

      const rawText = JSON.stringify({ $or: rawBranches }, null, 2) + "\n";
      const simplifiedText = JSON.stringify(match, null, 2) + "\n";

      const patch = createPatch(
        coll,
        rawText,
        simplifiedText,
        `raw branches (${rawBranches.length})`,
        `simplified $match (${simplified.length} branch${simplified.length === 1 ? "" : "es"})`,
        { context: 3 }
      );
      process.stdout.write(colorizePatch(patch));

      console.log(
        `\nReduction: ${rawBranches.length} → ${simplified.length} (${(
          (1 - simplified.length / rawBranches.length) *
          100
        ).toFixed(1)}% fewer branches)`
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
