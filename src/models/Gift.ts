import {
  getModelForClass,
  index,
  modelOptions,
  prop,
} from "@typegoose/typegoose";
import type { MessageAuthorType } from "../interfaces.js";

@modelOptions({
  schemaOptions: { collection: "gifts" },
})
@index({ originVideoId: 1, timestamp: 1 })
// Narrows the price rebuild's sweep to the documents it can actually learn a
// price from. Every condition here is either an equality or `$exists: true`,
// which is deliberate: a partial filter may only use equality, `$exists: true`,
// the range operators, `$type`, `$and`, `$or` and `$in`. Anything else (`$ne`,
// say) makes the server reject createIndex, and mongoose's autoIndex swallows
// that rejection — the code would believe the index exists while queries
// silently fall back to a collection scan.
@index(
  { assetName: 1 },
  {
    partialFilterExpression: {
      hasGiftImageUrl: true,
      assetName: { $exists: true },
      jewelCount: { $exists: true },
      comboCount: { $exists: true },
    },
  }
)
export class Gift {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop({ required: true })
  public timestamp!: Date;

  @prop()
  public authorName?: string;

  @prop()
  public authorPhoto?: string;

  /**
   * Only a ticker carries the sender's channel id, and tickers only appear for
   * gifts priced at 100 Jewels or more.
   */
  @prop()
  public authorChannelId?: string;

  /**
   * Always `other` — a gift action carries no badge information at all, so
   * membership / moderator / owner cannot be told apart.
   */
  @prop({ required: true })
  public authorType!: MessageAuthorType;

  /** Raw display text, e.g. `"comboed x5 Heart for 17,000 Jewels"`. */
  @prop()
  public message?: string;

  @prop()
  public giftName?: string;

  /** Image file name, e.g. `finger_heart`. The key into the price table. */
  @prop()
  public assetName?: string;

  @prop()
  public image?: string;

  /** Raw parsed figure. Feeds price derivation only, never `amount`. */
  @prop()
  public jewelCount?: number;

  /** Raw parsed figure. Feeds price derivation only, never `amount`. */
  @prop()
  public comboCount?: number;

  /**
   * Whether the chat item carried its own image. `assetName` can also come from
   * a ticker's sticker url, so this is the only way to tell whether
   * `jewelCount` is a whole-wave total (safe to divide by `comboCount`) or a
   * single unit price (not safe).
   */
  @prop()
  public hasGiftImageUrl?: boolean;

  /** Jewels for this one gift — always a unit price, never a wave total. */
  @prop()
  public amount?: number;

  /** Always `"JEWEL"`. Keeps the stats label set complete without pretending to be fiat. */
  @prop({ required: true })
  public currency!: string;

  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true })
  public originChannelId!: string;

  @prop()
  public isReplay?: boolean;
}

export default getModelForClass(Gift);
