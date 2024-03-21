import { getModelForClass, modelOptions, prop } from "@typegoose/typegoose";

@modelOptions({ schemaOptions: { collection: "raids" } })
export class Raid {
  @prop({ required: true, unique: true })
  public id!: string;

  // source
  @prop({ index: true })
  public sourceVideoId?: string;

  @prop({ index: true })
  public sourceChannelId?: string;

  @prop({ index: true })
  public sourceName?: string;

  // target
  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true, index: true })
  public originChannelId!: string;

  @prop({ required: true, index: true })
  timestamp!: Date;
}

export default getModelForClass(Raid);
