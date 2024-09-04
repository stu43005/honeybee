import { getModelForClass, index, modelOptions, prop } from "@typegoose/typegoose";

@modelOptions({ schemaOptions: { collection: "banactions" } })
@index({ channelId: 1, originVideoId: 1 }, { unique: true })
export class BanAction {
  @prop({ required: true })
  channelId!: string;

  @prop({ required: true, index: true })
  originVideoId!: string;

  @prop({ required: true })
  originChannelId!: string;

  @prop({ required: true })
  timestamp!: Date;
}

export default getModelForClass(BanAction);
