import { getModelForClass, index, modelOptions, prop } from "@typegoose/typegoose";

@modelOptions({ schemaOptions: { collection: "raids" } })
@index({ originVideoId: 1, sourceName: 1 }, { unique: true })
export class Raid {
  /**
   * incoming raid id
   */
  @prop({ index: true })
  public id?: string;

  /**
   * outgoing raid id
   */
  @prop({ index: true })
  public outgoingId?: string;

  // source
  @prop({ index: true })
  public sourceVideoId?: string;

  @prop({ index: true })
  public sourceChannelId?: string;

  @prop({ required: true, index: true })
  public sourceName!: string;

  @prop()
  public sourcePhoto?: string;

  // target
  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ index: true })
  public originChannelId?: string;

  @prop()
  public originPhoto?: string;

  @prop({ required: true, index: true })
  timestamp!: Date;
}

export default getModelForClass(Raid);
