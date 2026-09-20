import type { DocumentType } from "@typegoose/typegoose";
import { getChannelIdFilter } from "../../data/track.js";
import WebhookModel from "../../models/Webhook.js";
import YoutubeDmBindingModel, {
  type YoutubeDmBinding,
} from "../../models/YoutubeDmBinding.js";

const DM_COLLS = [
  "superchats",
  "superstickers",
  "gifts",
  "memberships",
  "milestones",
  "membershipgiftpurchases",
  "membershipgifts",
];

// Re-reads the latest binding by _id so concurrent / out-of-order bind+unbind
// transforms converge on the current channelIds instead of an older snapshot.
export async function transformYoutubeDmBinding(
  binding: Pick<DocumentType<YoutubeDmBinding>, "_id">
): Promise<void> {
  const fresh = await YoutubeDmBindingModel.findById(binding._id);
  if (!fresh || fresh.channelIds.length === 0) {
    await WebhookModel.deleteMany({ youtubeDmBinding: binding._id });
    return;
  }
  const webhook = {
    colls: DM_COLLS,
    match: { authorChannelId: getChannelIdFilter(fresh.channelIds) },
    templatePreset: "discord-embed-chats",
    insertUrl: `discord-dm://${fresh.discordUserId}`,
    youtubeDmBinding: fresh._id,
    enabled: true,
  };
  await WebhookModel.updateOne(
    { youtubeDmBinding: fresh._id },
    { $set: webhook },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

// Exported so the orphan-cleanup discriminator can be unit-tested directly.
export async function transformYoutubeDmBindings(): Promise<void> {
  for await (const binding of YoutubeDmBindingModel.find()) {
    await transformYoutubeDmBinding(binding);
  }
  // Orphan cleanup: DM webhooks whose binding doc was deleted.
  // MUST use { $type: "objectId" } (same discriminator as the partial index) —
  // { $ne: null } would also match track/generic webhooks lacking the field and
  // delete them.
  for await (const webhook of WebhookModel.aggregate([
    { $match: { youtubeDmBinding: { $type: "objectId" } } },
    {
      $lookup: {
        from: "youtubeDmBindings",
        localField: "youtubeDmBinding",
        foreignField: "_id",
        as: "bindingDoc",
      },
    },
    { $match: { bindingDoc: { $size: 0 } } },
  ])) {
    await WebhookModel.deleteOne({ _id: webhook._id });
  }
}
