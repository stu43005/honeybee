import {
  getModelForClass,
  index,
  modelOptions,
  prop,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses.js";
import { transformYoutubeDmBinding } from "../components/youtube-dm-operator.js";
import { YOUTUBE_DM_MAX_CHANNELS_PER_USER } from "../constants.js";

// Thrown when the requested bind would exceed the soft per-user cap; nothing is written.
export class BindingLimitError extends Error {}
// Thrown when the source binding WAS written but transformYoutubeDmBinding failed;
// callers may report a truthful "saved, taking effect shortly" state.
export class BindingTransformPendingError extends Error {}

@modelOptions({ schemaOptions: { collection: "youtubeDmBindings" } })
@index({ discordUserId: 1 }, { unique: true })
export class YoutubeDmBinding extends TimeStamps {
  @prop({ required: true })
  public discordUserId!: string;

  @prop({ type: () => [String], default: [] })
  public channelIds!: string[];

  public static async bindChannels(
    this: ReturnModelType<typeof YoutubeDmBinding>,
    discordUserId: string,
    channelIds: string[]
  ) {
    const requested = [...new Set(channelIds)];
    const existing = await this.findOne({ discordUserId });
    const current = existing?.channelIds ?? [];
    const genuinelyNew = requested.filter((id) => !current.includes(id));
    if (
      current.length + genuinelyNew.length >
      YOUTUBE_DM_MAX_CHANNELS_PER_USER
    ) {
      throw new BindingLimitError(
        `binding limit reached (max ${YOUTUBE_DM_MAX_CHANNELS_PER_USER} channels per user)`
      );
    }
    // Pre-write errors (findOneAndUpdate throwing) propagate as-is; only a
    // post-write transform failure is reclassified as BindingTransformPendingError.
    const doc = await this.findOneAndUpdate(
      { discordUserId },
      { $addToSet: { channelIds: { $each: requested } } },
      { upsert: true, new: true }
    );
    try {
      await transformYoutubeDmBinding(doc);
    } catch (error) {
      throw new BindingTransformPendingError(`${error}`);
    }
    return doc;
  }

  public static async unbindChannel(
    this: ReturnModelType<typeof YoutubeDmBinding>,
    discordUserId: string,
    channelId: string
  ) {
    const doc = await this.findOneAndUpdate(
      { discordUserId },
      { $pull: { channelIds: channelId } },
      { new: true }
    );
    if (!doc) return null;
    await transformYoutubeDmBinding(doc);
    return doc;
  }

  public static async unbindAll(
    this: ReturnModelType<typeof YoutubeDmBinding>,
    discordUserId: string
  ) {
    const doc = await this.findOneAndUpdate(
      { discordUserId },
      { $set: { channelIds: [] } },
      { new: true }
    );
    if (!doc) return null;
    await transformYoutubeDmBinding(doc);
    return doc;
  }
}

export default getModelForClass(YoutubeDmBinding);
