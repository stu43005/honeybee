import {
  getModelForClass,
  index,
  modelOptions,
  prop,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses.js";

@modelOptions({ schemaOptions: { collection: "raids" } })
@index({ originVideoId: 1, sourceName: 1 }, { unique: true })
@index({ updatedAt: 1 })
@index({ originVideoId: 1, timestamp: 1 })
export class Raid extends TimeStamps {
  /**
   * incoming raid id
   */
  @prop()
  public id?: string;

  @prop()
  public targetId?: string;

  /**
   * outgoing raid id
   */
  @prop()
  public outgoingId?: string;

  @prop()
  public outgoingTargetId?: string;

  // source
  @prop()
  public sourceVideoId?: string;

  @prop()
  public sourceChannelId?: string;

  @prop({ required: true })
  public sourceName!: string;

  @prop()
  public sourcePhoto?: string;

  // target
  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop()
  public originChannelId?: string;

  @prop()
  public originName?: string;

  @prop()
  public originPhoto?: string;

  @prop({ required: true })
  timestamp!: Date;
}

export default getModelForClass(Raid);
