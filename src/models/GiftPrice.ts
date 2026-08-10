import { getModelForClass, modelOptions, prop } from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses.js";

@modelOptions({ schemaOptions: { collection: "giftprices" } })
export class GiftPrice extends TimeStamps {
  /** Image file name, e.g. `finger_heart`. */
  @prop({ required: true, unique: true })
  public assetName!: string;

  /** Jewels for a single gift of this asset. */
  @prop({ required: true })
  public price!: number;

  /**
   * Latest observed display name. Reference only — two different assets can
   * share one display name, so it must never be used to look a price up.
   */
  @prop()
  public giftName?: string;

  /**
   * Hand-entered price. A seed, not a lock: the rebuild applies the very same
   * overwrite rules to it and clears this flag once real observations back the
   * value. A permanently pinned price would silently stay wrong after YouTube
   * repriced the asset.
   */
  @prop()
  public manual?: boolean;

  /**
   * Largest number of observations any single rebuild has seen supporting the
   * current `price`. A max rather than a running total: every rebuild rescans
   * the same window, so summing would let a value gain confidence purely by
   * sitting there across reruns — the opposite of what this field is for.
   */
  @prop({ required: true, default: 0 })
  public sampleCount!: number;
}

export default getModelForClass(GiftPrice);
