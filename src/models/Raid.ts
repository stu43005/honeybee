import { getModelForClass, index, modelOptions, prop } from "@typegoose/typegoose";

@modelOptions({ schemaOptions: { collection: "raids" } })
@index({ originVideoId: 1, sourceName: 1 }, { unique: true })
export class Raid {
  /**
   * incoming raid id
   */
  @prop()
  public id?: string;

  /**
   * outgoing raid id
   */
  @prop()
  public outgoingId?: string;

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
  public originPhoto?: string;

  @prop({ required: true })
  timestamp!: Date;
}

export default getModelForClass(Raid);
